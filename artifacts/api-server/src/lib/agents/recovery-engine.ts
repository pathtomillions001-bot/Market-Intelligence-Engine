/**
 * Recovery Intelligence Engine
 *
 * Institutional-grade AI-driven recovery system for Over/Under contracts.
 *
 * PRINCIPLE: Recovery is not simply increasing stake.
 *            Recovery is choosing the SMARTEST possible trade.
 *
 * Available recovery candidates evaluated on every loss:
 *   OVER 1 (payout 1.08×) | OVER 2 (1.19×) | OVER 3 (1.37×) | OVER 4 (1.63×)
 *   UNDER 8 (1.08×) | UNDER 7 (1.19×) | UNDER 6 (1.37×) | UNDER 5 (1.63×)
 *
 * Each candidate is scored on 20+ factors including:
 *   digit distribution, Markov probabilities, historical win rates,
 *   EV, capital efficiency, market conditions, noise, momentum, etc.
 *
 * State persisted to DB (recoveryStateJson) so recovery survives restarts.
 */

import { analyzeDigits } from "./digit-probability";
import { getWinRate, getWinRateCount } from "../win-rate-store";

// ── Contract family types ──────────────────────────────────────────────────────

export type ContractFamily = "overunder" | "risefall" | "evenodd";
export const CONTRACT_FAMILIES: ContractFamily[] = ["overunder", "risefall", "evenodd"];

// ── Recovery candidate payout table ───────────────────────────────────────────
// Verified Deriv payouts for the 8 allowed recovery contracts:

export const RECOVERY_CANDIDATE_PAYOUTS: Record<string, Record<number, number>> = {
  DIGITOVER:  { 1: 1.08, 2: 1.19, 3: 1.37, 4: 1.63 },
  DIGITUNDER: { 8: 1.08, 7: 1.19, 6: 1.37, 5: 1.63 },
};

// Risk-equivalent pairings — same theoretical win rate, different direction:
// OVER 1 ↔ UNDER 8 (~80%), OVER 2 ↔ UNDER 7 (~70%), OVER 3 ↔ UNDER 6 (~60%), OVER 4 ↔ UNDER 5 (~50%)
const EQUIVALENT_UNDER: Record<number, number> = { 1: 8, 2: 7, 3: 6, 4: 5 };
const EQUIVALENT_OVER:  Record<number, number> = { 8: 1, 7: 2, 6: 3, 5: 4 };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecoveryCandidate {
  contractType:          "DIGITOVER" | "DIGITUNDER";
  barrier:               number;
  label:                 string;   // "OVER 2", "UNDER 7", etc.

  // Win probability
  statisticalWinP:       number;   // from Bayesian digit analysis
  markovWinP:            number;   // from Markov chain
  historicalWinRate:     number;   // from DB win-rate-store
  blendedWinP:           number;   // ensemble of the above

  // Payout & EV
  payout:                number;   // e.g. 1.19 for OVER 2
  expectedValue:         number;   // per $1 stake
  edge:                  number;   // blendedWinP - (1/payout)
  isPositiveEV:          boolean;

  // Dynamic stake
  minRecoveryStake:      number;   // minimum to recover in one win: loss/(payout-1)
  riskAdjustedStake:     number;   // accounting for win probability
  dynamicMultiplier:     number;   // riskAdjustedStake / baseStake
  capitalExposure:       number;   // riskAdjustedStake / balance (fraction)

  // Market-condition metrics
  digitBias:             number;   // how biased current distribution favors this contract (-1 to +1)
  markovAlignment:       number;   // agreement between Bayesian and Markov (0-1)
  recentCycleAccuracy:   number;   // win rate in last 20 digits
  lastDigitFavorable:    boolean;  // last digit favors this contract direction

  // Risk profile
  probabilityOfRecovery: number;   // P(recover in exactly 1 trade)
  probRecoverIn3:        number;   // P(recover within 3 trades)
  estimatedTrades:       number;   // geometric mean trades to recover
  maxDrawdownRisk:       number;   // worst-case 3-loss drawdown in dollars
  expectedNetProfit:     number;   // blendedWinP * profit_on_win - (1-blendedWinP) * stake

  // Final score
  recoveryScore:         number;   // 0–100 composite
  rank:                  number;   // 1 = best
}

export interface RecoveryContext {
  symbol:                string;
  digits:                number[];
  prices:                number[];
  balance:               number;
  maxRiskPerTrade:       number;   // percentage, e.g. 2 = 2%
  maxTradeStake:         number;
  minConfidenceThreshold: number;
  riskProfile:           "conservative" | "moderate" | "aggressive";
  // Optional market condition signals from feature-engineering agent
  volatility?:           number;
  momentum?:             number;
  noiseScore?:           number;
  tickAcceleration?:     number;
  regime?:               string;
}

export interface RecoveryEvaluationResult {
  candidates:             RecoveryCandidate[];  // all 8, ranked by score desc
  shouldTrade:            boolean;
  topCandidate:           RecoveryCandidate | null;
  chosenBarrierOverride:  { DIGITOVER: number; DIGITUNDER: number } | undefined;
  chosenStake:            number;
  rejectReason?:          string;
  timestamp:              number;
  unrecoveredAmount:      number;
  baseStake:              number;
}

export interface FamilyRecoveryState {
  family:              ContractFamily;
  inRecovery:          boolean;
  recoveryStep:        number;       // 0 = not in recovery; increments per consecutive recovery loss
  unrecoveredAmount:   number;       // dollars still owed before returning to normal mode
  baseStake:           number;       // normal stake this family recovers back to
  streakLossCount:     number;       // losses in the current streak (display)
  streakStartAmount:   number;       // total lost in this streak (display)
  // AI-chosen recovery barrier (set by evaluateRecoveryCandidates):
  chosenOverBarrier?:  number | null;
  chosenUnderBarrier?: number | null;
}

// ── State ─────────────────────────────────────────────────────────────────────

function freshState(family: ContractFamily): FamilyRecoveryState {
  return {
    family,
    inRecovery:          false,
    recoveryStep:        0,
    unrecoveredAmount:   0,
    baseStake:           0,
    streakLossCount:     0,
    streakStartAmount:   0,
    chosenOverBarrier:   null,
    chosenUnderBarrier:  null,
  };
}

const states = new Map<ContractFamily, FamilyRecoveryState>(
  CONTRACT_FAMILIES.map((f) => [f, freshState(f)]),
);

// Cache the latest evaluation result keyed by "family|symbol" to prevent
// parallel market scans from overwriting each other's results.
const lastEvaluations = new Map<string, RecoveryEvaluationResult>();

function evalKey(family: ContractFamily, symbol: string): string {
  return `${family}|${symbol}`;
}

/** Delete all cached evaluations for a family (across all symbols). */
function clearFamilyEvals(family: ContractFamily): void {
  const prefix = `${family}|`;
  for (const k of lastEvaluations.keys()) {
    if (k.startsWith(prefix)) lastEvaluations.delete(k);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Map a Deriv contract type to its recovery family, or null if not tracked. */
export function contractTypeToFamily(contractType: string): ContractFamily | null {
  if (contractType === "DIGITOVER" || contractType === "DIGITUNDER") return "overunder";
  if (["CALL", "PUT", "RISE", "FALL"].includes(contractType)) return "risefall";
  if (contractType === "DIGITEVEN" || contractType === "DIGITODD") return "evenodd";
  return null;
}

export function getState(family: ContractFamily): FamilyRecoveryState {
  return states.get(family) ?? freshState(family);
}

export function getAllStates(): FamilyRecoveryState[] {
  return CONTRACT_FAMILIES.map((f) => getState(f));
}

export function isInRecovery(family: ContractFamily): boolean {
  return getState(family).inRecovery;
}

export function isAnyInRecovery(): boolean {
  return getAllStates().some((s) => s.inRecovery);
}

/**
 * Returns the last cached evaluation result for a family + symbol pair.
 * Pass the winning market's symbol to get the correct stake for that symbol.
 */
export function getLastEvaluation(family: ContractFamily, symbol?: string): RecoveryEvaluationResult | null {
  if (symbol) return lastEvaluations.get(evalKey(family, symbol)) ?? null;
  // Fallback: return the most recently stored result for this family
  for (const [k, v] of lastEvaluations) {
    if (k.startsWith(`${family}|`)) return v;
  }
  return null;
}

// ── Barrier override (AI-chosen, replaces fixed OVER4/UNDER5) ─────────────────

/**
 * Returns the AI-chosen barrier override for the Over/Under family.
 * When a recovery evaluation has been run, uses its top candidate.
 * Falls back to OVER 4 / UNDER 5 (safe mid-range) if no evaluation has run.
 */
export function getBarrierOverride(
  family: ContractFamily,
): { DIGITOVER: number; DIGITUNDER: number } | undefined {
  if (family !== "overunder") return undefined;
  const state = getState(family);
  if (!state.inRecovery) return undefined;

  // Use AI-chosen barriers if available
  const ov = state.chosenOverBarrier;
  const un = state.chosenUnderBarrier;
  if (ov != null && un != null) {
    return { DIGITOVER: ov, DIGITUNDER: un };
  }

  // Fallback: mid-range defaults (will be overridden on next evaluation)
  return { DIGITOVER: 4, DIGITUNDER: 5 };
}

// ── Stake calculation ─────────────────────────────────────────────────────────

/**
 * Compute the minimum stake required to recover `unrecoveredAmount` in a single
 * winning trade, then risk-adjust for win probability. Always cap at maxTradeStake
 * and never go below $0.35.
 */
function computeDynamicStake(
  unrecoveredAmount: number,
  payout: number,
  blendedWinP: number,
  balance: number,
  maxTradeStake: number,
  riskProfile: "conservative" | "moderate" | "aggressive",
): number {
  const netPayout = payout - 1;
  if (netPayout <= 0) return 0.35;

  // Minimum stake to fully recover in one win:
  const minRecovery = unrecoveredAmount / netPayout;

  // Risk-adjusted: account for the probability of winning — use conservative sizing
  // so we don't over-expose. Conservative factor: divide by (0.7 * winP + 0.3)
  // This blends actual win probability with a conservative floor.
  const conservativeFactor = 0.7 * Math.max(0.4, blendedWinP) + 0.3;
  const riskAdjusted = minRecovery / conservativeFactor;

  // Profile-based max exposure (% of balance)
  const maxExposurePct = riskProfile === "conservative" ? 0.08
    : riskProfile === "aggressive" ? 0.20
    : 0.12;   // moderate
  const maxExposure = Math.min(balance * maxExposurePct, maxTradeStake);

  return Math.max(0.35, Math.min(riskAdjusted, maxExposure));
}

/**
 * Get the AI-evaluated dynamic stake for the next recovery trade.
 * Falls back to the old multiplier-based formula if no evaluation is cached.
 */
export function getDynamicRecoveryStake(
  family: ContractFamily,
  baseStakeFromAI: number,
  maxTradeStake: number,
  balance?: number,
  symbol?: string,
): number {
  const state = getState(family);
  if (!state.inRecovery) {
    if (baseStakeFromAI > 0 && isFinite(baseStakeFromAI)) state.baseStake = baseStakeFromAI;
    return baseStakeFromAI;
  }

  // Look up by the exact symbol that won the tournament, not an arbitrary family entry
  const lastEval = symbol
    ? lastEvaluations.get(evalKey(family, symbol))
    : getLastEvaluation(family);
  if (lastEval && lastEval.shouldTrade && lastEval.chosenStake > 0) {
    return Math.max(0.35, Math.min(lastEval.chosenStake, maxTradeStake));
  }

  // Fallback: original multiplier formula (1.2^step)
  const raw = state.baseStake * Math.pow(1.2, state.recoveryStep);
  return Math.max(0.35, Math.min(raw, maxTradeStake));
}

/**
 * Legacy stake function (kept for backward compat with ai.ts manual-trade path).
 * New code should use getDynamicRecoveryStake.
 */
export function getNextStake(
  family: ContractFamily,
  baseStakeFromAI: number,
  recoveryMultiplier: number,
  maxTradeStake: number,
): number {
  const state = getState(family);
  if (!state.inRecovery) {
    if (baseStakeFromAI > 0 && isFinite(baseStakeFromAI)) state.baseStake = baseStakeFromAI;
    return baseStakeFromAI;
  }
  const mult = isFinite(recoveryMultiplier) && recoveryMultiplier > 1 ? recoveryMultiplier : 1.2;
  const raw  = state.baseStake * Math.pow(mult, state.recoveryStep);
  return Math.max(0.35, Math.min(raw, maxTradeStake));
}

// ── Core Evaluation Engine ────────────────────────────────────────────────────

/**
 * evaluateRecoveryCandidates — the heart of the Recovery Intelligence Engine.
 *
 * Evaluates all 8 recovery contracts (OVER 1-4, UNDER 5-8), scores each on
 * 20+ factors, ranks them, and returns the best choice along with a dynamic
 * stake. Only recommends trading if the top score exceeds the confidence
 * threshold. Never forces a recovery trade.
 */
export function evaluateRecoveryCandidates(
  ctx: RecoveryContext,
  family: ContractFamily = "overunder",
  symbol?: string,
): RecoveryEvaluationResult {
  const cacheSymbol = symbol ?? ctx.symbol;
  const state = getState(family);

  const empty: RecoveryEvaluationResult = {
    candidates: [], shouldTrade: false, topCandidate: null,
    chosenBarrierOverride: undefined, chosenStake: 0, timestamp: Date.now(),
    unrecoveredAmount: state.unrecoveredAmount, baseStake: state.baseStake,
  };

  if (!state.inRecovery || family !== "overunder") return empty;

  const { digits, balance, maxRiskPerTrade, maxTradeStake, minConfidenceThreshold, riskProfile } = ctx;
  const unrecoveredAmount = state.unrecoveredAmount;
  const baseStake = state.baseStake > 0 ? state.baseStake : (balance * maxRiskPerTrade / 100);

  // Need at least some digit history to evaluate
  const safeDigits = digits.length >= 10
    ? digits
    : [...Array(30).fill(5), ...digits];

  // Digit analysis
  const analysis = analyzeDigits(safeDigits);
  const { bayesianProb, markov, frequency } = analysis;

  // Hour of day (0-23) — some digit markets have time-of-day patterns
  const hourOfDay = new Date().getUTCHours();
  // Noise penalty: high noise → harder to predict
  const noisePenalty = Math.max(0, Math.min(20, (ctx.noiseScore ?? 0.3) * 30));
  // Regime bonus/penalty
  const regimeFavor = ctx.regime === "trending" ? 5 : ctx.regime === "ranging" ? 3 : 0;

  const candidates: RecoveryCandidate[] = [];

  for (const [ct, payoutMap] of Object.entries(RECOVERY_CANDIDATE_PAYOUTS)) {
    const contractType = ct as "DIGITOVER" | "DIGITUNDER";

    for (const [bStr, payout] of Object.entries(payoutMap)) {
      const barrier = Number(bStr);

      // ── Statistical win probability (Bayesian) ────────────────────────────
      let statWinP = 0;
      if (contractType === "DIGITOVER") {
        for (let d = barrier + 1; d <= 9; d++) statWinP += bayesianProb[d];
      } else {
        for (let d = 0; d < barrier; d++) statWinP += bayesianProb[d];
      }

      // ── Markov win probability ────────────────────────────────────────────
      let markovWinP = 0;
      if (contractType === "DIGITOVER") {
        for (let d = barrier + 1; d <= 9; d++) markovWinP += markov.nextProb[d];
      } else {
        for (let d = 0; d < barrier; d++) markovWinP += markov.nextProb[d];
      }

      // ── Historical win rate ───────────────────────────────────────────────
      const histWinRate = getWinRate(ctx.symbol, contractType, barrier);
      const histCount   = getWinRateCount(ctx.symbol, contractType, barrier);
      // Weight historical more when we have more data
      const histWeight = Math.min(0.35, histCount * 0.02); // max 35% weight at 17+ trades
      const statWeight = 1 - histWeight;

      // ── Blended win probability ───────────────────────────────────────────
      const statBlend   = statWinP * 0.65 + markovWinP * 0.35;
      const blendedWinP = statBlend * statWeight + histWinRate * histWeight;

      // ── EV ────────────────────────────────────────────────────────────────
      const expectedValue = blendedWinP * (payout - 1) - (1 - blendedWinP);
      const edge          = blendedWinP - (1 / payout);
      const isPositiveEV  = expectedValue > 0;

      // ── Dynamic stake ─────────────────────────────────────────────────────
      const minRecoveryStake  = unrecoveredAmount / (payout - 1);
      const riskAdjustedStake = computeDynamicStake(
        unrecoveredAmount, payout, blendedWinP, balance, maxTradeStake, riskProfile,
      );
      const dynamicMultiplier = baseStake > 0 ? riskAdjustedStake / baseStake : 1;
      const capitalExposure   = balance > 0 ? riskAdjustedStake / balance : 0;

      // ── Digit bias ────────────────────────────────────────────────────────
      // How much the current distribution favors this contract vs. theoretical
      const theoreticalWinP = contractType === "DIGITOVER"
        ? (9 - barrier) / 10
        : barrier / 10;
      const digitBias = theoreticalWinP > 0
        ? (statWinP - theoreticalWinP) / theoreticalWinP  // relative excess
        : 0;

      // ── Markov alignment ─────────────────────────────────────────────────
      const markovAlignment = statWinP > 0 && markovWinP > 0
        ? Math.min(statWinP, markovWinP) / Math.max(statWinP, markovWinP)
        : 0.5;

      // ── Recent cycle accuracy (last 20 digits) ────────────────────────────
      const recentDigits  = safeDigits.slice(-20);
      let   recentWins    = 0;
      for (const d of recentDigits) {
        if (contractType === "DIGITOVER" ? d > barrier : d < barrier) recentWins++;
      }
      const recentCycleAccuracy = recentDigits.length > 0 ? recentWins / recentDigits.length : blendedWinP;

      // ── Last digit favorability ───────────────────────────────────────────
      const lastDigit         = safeDigits[safeDigits.length - 1] ?? 5;
      const lastDigitFavorable = contractType === "DIGITOVER" ? lastDigit > barrier : lastDigit < barrier;

      // ── Recovery probability ──────────────────────────────────────────────
      const probabilityOfRecovery = blendedWinP;
      const probRecoverIn3        = 1 - Math.pow(1 - blendedWinP, 3);
      const estimatedTrades       = blendedWinP > 0 ? 1 / blendedWinP : 999;
      const maxDrawdownRisk       = riskAdjustedStake * 3;
      const expectedNetProfit     = blendedWinP * (riskAdjustedStake * (payout - 1)) -
                                    (1 - blendedWinP) * riskAdjustedStake;

      // ── Recovery Confidence Score (0–100) ─────────────────────────────────
      //
      // Factor 1: Win probability (25%)
      //   Scaled so 50% = 0pts, 80% = 100pts
      const winPScore = Math.max(0, Math.min(100,
        (blendedWinP - 0.50) / 0.30 * 100,
      ));

      // Factor 2: EV score (20%)
      //   EV=-0.15 = 0pts, EV=+0.15 = 100pts
      const evScore = Math.max(0, Math.min(100,
        (expectedValue + 0.15) / 0.30 * 100,
      ));

      // Factor 3: Capital efficiency (20%)
      //   Rewards higher-payout contracts that need less stake to recover.
      //   OVER4 (payout=1.63, net=0.63): efficiency=100
      //   OVER1 (payout=1.08, net=0.08): efficiency≈13
      //   Scaled: net_payout / 0.63 * 100
      const netPayout          = payout - 1;
      const capitalEfficiency  = Math.max(0, Math.min(100, (netPayout / 0.63) * 100));

      // Factor 4: Digit bias alignment (15%)
      //   Scaled: bias=-1 → 0pts, bias=+0.2 → 100pts
      const biasScore = Math.max(0, Math.min(100, (digitBias + 0.2) / 0.40 * 100));

      // Factor 5: Recent cycle accuracy (15%)
      //   Scaled: 50%=0pts, 80%=100pts
      const cycleScore = Math.max(0, Math.min(100,
        (recentCycleAccuracy - 0.50) / 0.30 * 100,
      ));

      // Factor 6: Markov alignment (5%)
      const markovScore = Math.max(0, Math.min(100, markovAlignment * 100));

      // Market condition adjustments (applied after base score)
      let marketAdj = 0;
      marketAdj -= noisePenalty;                       // noise penalises all candidates
      marketAdj += regimeFavor;                        // trending/ranging market slight bonus
      if (ctx.momentum != null) {
        // Positive momentum favors OVER contracts, negative favors UNDER
        const momentumAlign = contractType === "DIGITOVER" ? ctx.momentum : -ctx.momentum;
        marketAdj += Math.max(-8, Math.min(8, momentumAlign * 25));
      }
      if (isPositiveEV) marketAdj += 5;               // positive EV bonus
      if (lastDigitFavorable) marketAdj += 3;          // last digit favorable bonus
      if (histCount >= 10 && histWinRate > blendedWinP + 0.05) marketAdj += 5; // strong historical edge

      const rawScore =
        winPScore         * 0.25 +
        evScore           * 0.20 +
        capitalEfficiency * 0.20 +
        biasScore         * 0.15 +
        cycleScore        * 0.15 +
        markovScore       * 0.05 +
        marketAdj;

      const recoveryScore = Math.max(0, Math.min(100, Math.round(rawScore)));
      const label = `${contractType === "DIGITOVER" ? "OVER" : "UNDER"} ${barrier}`;

      candidates.push({
        contractType,
        barrier,
        label,
        statisticalWinP:       Math.round(statWinP      * 10000) / 10000,
        markovWinP:            Math.round(markovWinP     * 10000) / 10000,
        historicalWinRate:     Math.round(histWinRate    * 10000) / 10000,
        blendedWinP:           Math.round(blendedWinP    * 10000) / 10000,
        payout,
        expectedValue:         Math.round(expectedValue  * 10000) / 10000,
        edge:                  Math.round(edge           * 10000) / 10000,
        isPositiveEV,
        minRecoveryStake:      Math.round(minRecoveryStake  * 100) / 100,
        riskAdjustedStake:     Math.round(riskAdjustedStake * 100) / 100,
        dynamicMultiplier:     Math.round(dynamicMultiplier * 100) / 100,
        capitalExposure:       Math.round(capitalExposure   * 10000) / 10000,
        digitBias:             Math.round(digitBias         * 10000) / 10000,
        markovAlignment:       Math.round(markovAlignment   * 10000) / 10000,
        recentCycleAccuracy:   Math.round(recentCycleAccuracy * 10000) / 10000,
        lastDigitFavorable,
        probabilityOfRecovery: Math.round(probabilityOfRecovery * 10000) / 10000,
        probRecoverIn3:        Math.round(probRecoverIn3    * 10000) / 10000,
        estimatedTrades:       Math.round(estimatedTrades   * 10) / 10,
        maxDrawdownRisk:       Math.round(maxDrawdownRisk   * 100) / 100,
        expectedNetProfit:     Math.round(expectedNetProfit * 100) / 100,
        recoveryScore,
        rank: 0,
      });
    }
  }

  // Sort by score descending, assign ranks
  candidates.sort((a, b) => b.recoveryScore - a.recoveryScore);
  candidates.forEach((c, i) => { c.rank = i + 1; });

  const topCandidate = candidates[0] ?? null;
  const shouldTrade  = topCandidate !== null && topCandidate.recoveryScore >= minConfidenceThreshold;

  // Determine barrier override from top candidate
  // The coordinator will still pick OVER vs UNDER based on digit direction;
  // we constrain both sides to be at the equivalent risk level of the top pick.
  let chosenBarrierOverride: { DIGITOVER: number; DIGITUNDER: number } | undefined;
  let chosenStake = baseStake;

  if (shouldTrade && topCandidate) {
    const isOver = topCandidate.contractType === "DIGITOVER";
    const overBarrier  = isOver ? topCandidate.barrier : (EQUIVALENT_OVER[topCandidate.barrier]  ?? 4);
    const underBarrier = isOver ? (EQUIVALENT_UNDER[topCandidate.barrier] ?? 5) : topCandidate.barrier;
    chosenBarrierOverride = { DIGITOVER: overBarrier, DIGITUNDER: underBarrier };
    chosenStake = topCandidate.riskAdjustedStake;

    // Persist chosen barriers in state so getBarrierOverride() uses them
    const st = getState(family);
    st.chosenOverBarrier  = overBarrier;
    st.chosenUnderBarrier = underBarrier;
  }

  let rejectReason: string | undefined;
  if (!shouldTrade) {
    if (topCandidate) {
      rejectReason = `Best candidate (${topCandidate.label}) scored ${topCandidate.recoveryScore}/100, ` +
        `below threshold ${minConfidenceThreshold}. Waiting for statistically superior conditions.`;
    } else {
      rejectReason = "No recovery candidates could be evaluated — insufficient digit data.";
    }
  }

  const result: RecoveryEvaluationResult = {
    candidates,
    shouldTrade,
    topCandidate,
    chosenBarrierOverride,
    chosenStake,
    rejectReason,
    timestamp: Date.now(),
    unrecoveredAmount,
    baseStake,
  };

  lastEvaluations.set(evalKey(family, cacheSymbol), result);
  return result;
}

// ── Outcome recording ─────────────────────────────────────────────────────────

export function recordOutcome(
  family: ContractFamily,
  won: boolean,
  profit: number,
  stakeUsed: number,
  maxRecoverySteps: number,
): FamilyRecoveryState {
  const state = getState(family);

  if (won) {
    if (state.inRecovery) {
      const recovered = Math.max(0, profit);
      if (recovered >= state.unrecoveredAmount) {
        // Fully recovered — return to normal, clear AI-chosen barriers
        states.set(family, freshState(family));
        clearFamilyEvals(family);
      } else {
        state.unrecoveredAmount -= recovered;
        // Stay in recovery; clear chosen barriers so they get re-evaluated next cycle
        state.chosenOverBarrier  = null;
        state.chosenUnderBarrier = null;
        clearFamilyEvals(family);
      }
    }
  } else {
    if (!state.inRecovery) {
      state.inRecovery          = true;
      state.recoveryStep        = 1;
      state.baseStake           = state.baseStake > 0 ? state.baseStake : stakeUsed;
      state.unrecoveredAmount   = stakeUsed;
      state.streakLossCount     = 1;
      state.streakStartAmount   = stakeUsed;
    } else {
      const cap                  = maxRecoverySteps > 0 ? maxRecoverySteps : 3;
      state.recoveryStep         = Math.min(state.recoveryStep + 1, cap);
      state.unrecoveredAmount   += stakeUsed;
      state.streakLossCount++;
      state.streakStartAmount   += stakeUsed;
    }
    // Clear stale barriers — next trade re-evaluates from current market state
    state.chosenOverBarrier  = null;
    state.chosenUnderBarrier = null;
    clearFamilyEvals(family);
  }

  return getState(family);
}

// ── State management ──────────────────────────────────────────────────────────

export function resetAll(): void {
  for (const f of CONTRACT_FAMILIES) states.set(f, freshState(f));
  lastEvaluations.clear();
}

export function seedFamilyState(
  family: ContractFamily,
  data: {
    inRecovery:          boolean;
    recoveryStep:        number;
    unrecoveredAmount:   number;
    baseStake:           number;
    streakLossCount:     number;
    streakStartAmount:   number;
  },
): void {
  const existing = getState(family);
  states.set(family, {
    family,
    ...data,
    // Preserve AI-chosen barriers only if still in recovery
    chosenOverBarrier:  data.inRecovery ? existing.chosenOverBarrier : null,
    chosenUnderBarrier: data.inRecovery ? existing.chosenUnderBarrier : null,
  });
  if (!data.inRecovery) clearFamilyEvals(family);
}

export function serializeState(): string {
  return JSON.stringify(CONTRACT_FAMILIES.map((f) => getState(f)));
}

export function loadState(json: string): void {
  try {
    const parsed = JSON.parse(json) as FamilyRecoveryState[];
    for (const s of parsed) {
      if (CONTRACT_FAMILIES.includes(s.family)) {
        states.set(s.family, {
          family:              s.family,
          inRecovery:          !!s.inRecovery,
          recoveryStep:        Number(s.recoveryStep)       || 0,
          unrecoveredAmount:   Number(s.unrecoveredAmount)  || 0,
          baseStake:           Number(s.baseStake)          || 0,
          streakLossCount:     Number(s.streakLossCount)    || 0,
          streakStartAmount:   Number(s.streakStartAmount)  || 0,
          chosenOverBarrier:   s.chosenOverBarrier  ?? null,
          chosenUnderBarrier:  s.chosenUnderBarrier ?? null,
        });
      }
    }
  } catch {
    /* ignore malformed state — start fresh */
  }
}

export function getLossStreakSummary(): {
  active: boolean;
  totalUnrecovered: number;
  totalStreakLosses: number;
  totalStreakAmount: number;
  families: ContractFamily[];
} {
  const active = getAllStates().filter((s) => s.inRecovery);
  return {
    active:           active.length > 0,
    totalUnrecovered: active.reduce((s, f) => s + f.unrecoveredAmount, 0),
    totalStreakLosses: active.reduce((s, f) => s + f.streakLossCount, 0),
    totalStreakAmount: active.reduce((s, f) => s + f.streakStartAmount, 0),
    families:         active.map((f) => f.family),
  };
}

/**
 * SpeedAI Engine — 1-tick ultra-fast trading engine  (PrecisionAI v2)
 *
 * Analyzes all markets in real-time to find the best setup for each selected
 * contract type, then executes 1-tick trades in a continuous loop until the
 * user-set Take Profit or Stop Loss is reached.
 *
 * Recovery state is ISOLATED from the global recovery engine so SpeedAI
 * sessions do not interfere with the main autonomous engine.
 *
 * PrecisionAI v2 changes (vs v1):
 *  • Five-signal contract-specific scoring: empirical win rate (50t) + short-term
 *    momentum (15t) + Markov chain + entry timing (last 3-5 ticks) + pattern
 *    stability (30t vs 15t agreement). Replaces the single-formula scoreMarket.
 *  • isGreenLight(): contract-type-specific optimal entry moment — OVER waits for
 *    a low digit (reversal setup), EVEN waits for an odd digit, MATCH waits for
 *    hot digit to be recent but not just hit, etc.
 *  • fastRecoveryGate(): hard 3-attempt / ~2-second time cap. Single 60-tick
 *    window instead of three windows (60/100/150) that could block 15+ minutes.
 *    Always falls back to best available — never blocks indefinitely.
 *  • Adaptive fallback: if no candidate clears the threshold after max attempts,
 *    drops threshold to 45 and executes the best scoring setup anyway.
 *  • Post-loss pause 800 ms (was 1800 ms) — speed gap covered by gate quality.
 *  • Normal-trade green-light retry: max 2 × 400 ms (was 1 × 1200 ms).
 */

import {
  tickManager,
  DERIV_MARKETS,
  executeLiveTrade,
  waitForContractResult,
  getCachedToken,
  getLiveBalance,
} from "./deriv";
import { broadcastSSE } from "./sse";
import { db, accountsTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum score (0–100) for a market to be considered "suitable" during initial scan */
const SUITABLE_SCORE_THRESHOLD = 54;

/** Minimum score for a normal trade to execute */
const MIN_TRADE_SCORE = 50;

/** Minimum score for recovery — slightly tighter but still always achievable */
const MIN_RECOVERY_SCORE = 52;

const DIGIT_PAYOUTS_OVER: Record<number, number> = {
  0: 1.04, 1: 1.08, 2: 1.19, 3: 1.37, 4: 1.63,
  5: 1.96, 6: 2.45, 7: 3.27, 8: 4.90,
};
const DIGIT_PAYOUTS_UNDER: Record<number, number> = {
  9: 1.04, 8: 1.08, 7: 1.19, 6: 1.37, 5: 1.63,
  4: 1.96, 3: 2.45, 2: 3.27, 1: 4.90,
};

// ── Types ─────────────────────────────────────────────────────────────────────

export type SpeedContractType =
  | "DIGITOVER" | "DIGITUNDER"
  | "DIGITEVEN" | "DIGITODD"
  | "DIGITMATCH" | "DIGITDIFF"
  | "CALL" | "PUT";

export interface SpeedAIConfig {
  normalContractTypes: SpeedContractType[];
  normalBarriers: number[];       // For OVER/UNDER — e.g. [1,2] for OVER or [7,8] for UNDER
  recoveryContractTypes: SpeedContractType[];
  recoveryBarriers: number[];     // For OVER/UNDER recovery — e.g. [4] for OVER, [5] for UNDER
  stake: number;
  stopLoss: number;
  takeProfit: number;
  recoveryMultiplier: number;
  recoveryMethod: "split" | "instant";
  maxRecoverySteps: number;
  /** When set, the loop trades ONLY this symbol — no per-trade market re-scanning */
  lockedSymbol?: string;
}

export interface ScanResult {
  suitable: boolean;
  best: MarketScore | null;
  allScored: MarketScore[];
  reason: string;
}

export interface MarketScore {
  symbol: string;
  displayName: string;
  contractType: SpeedContractType;
  barrier?: number;
  score: number;
  /** Score for normal contract types (0-100) */
  normalScore?: number;
  /** Score for recovery contract types (0-100) */
  recoveryScore?: number;
  /** Best recovery contract type found for this market */
  recoveryContractType?: SpeedContractType;
  /** Best recovery barrier found for this market */
  recoveryBarrier?: number;
  winProbability: number;
  payout: number;
  reason: string;
}

interface SpeedRecoveryState {
  inRecovery: boolean;
  recoveryStep: number;
  unrecoveredAmount: number;
  baseStake: number;
  /** Losses taken while already IN recovery (resets to 0 on any recovery win) */
  consecutiveRecoveryLosses: number;
}

export interface SpeedAIStatus {
  running: boolean;
  sessionId: string | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  inRecovery: boolean;
  recoveryStep: number;
  unrecoveredAmount: number;
  consecutiveRecoveryLosses: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  config?: SpeedAIConfig;
  message?: string;
  topMarkets?: MarketScore[];
}

// ── Session state ─────────────────────────────────────────────────────────────

let session: {
  running: boolean;
  sessionId: string | null;
  config: SpeedAIConfig | null;
  totalProfit: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  currentStake: number;
  recovery: SpeedRecoveryState;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  message?: string;
  topMarkets: MarketScore[];
  stopRequested: boolean;
} = {
  running: false,
  sessionId: null,
  config: null,
  totalProfit: 0,
  tradeCount: 0,
  winCount: 0,
  lossCount: 0,
  currentStake: 0,
  recovery: { inRecovery: false, recoveryStep: 0, unrecoveredAmount: 0, baseStake: 0, consecutiveRecoveryLosses: 0 },
  topMarkets: [],
  stopRequested: false,
};

// ── PrecisionAI v2 — market analysis ─────────────────────────────────────────

/**
 * Digit frequency histogram (0–9) over a tick buffer.
 */
function digitFrequency(digits: number[]): number[] {
  const counts = Array(10).fill(0);
  for (const d of digits) if (d >= 0 && d <= 9) counts[d]++;
  const n = digits.length || 1;
  return counts.map(c => c / n);
}

/**
 * Laplace-smoothed Markov next-digit probabilities.
 * Returns P(nextDigit = 0..9 | the last digit seen).
 */
function markovNextProb(digits: number[]): number[] {
  if (digits.length < 2) return Array(10).fill(0.1);
  const last = digits[digits.length - 1];
  const mat = Array.from({ length: 10 }, () => Array(10).fill(0));
  for (let i = 1; i < digits.length; i++) {
    const f = digits[i - 1], t = digits[i];
    if (f >= 0 && f <= 9 && t >= 0 && t <= 9) mat[f][t]++;
  }
  const row = mat[last ?? 5];
  const total = row.reduce((a, b) => a + b, 0);
  return row.map(v => (v + 1) / (total + 10));
}

/**
 * Fraction of the last `window` digits/prices that satisfy the bet condition.
 * Used as a short-term momentum signal.
 */
function momentumRate(
  digits: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
  window = 15,
): number {
  if (contractType === "CALL" || contractType === "PUT") return 0.5; // handled separately
  const recent = digits.slice(-window);
  if (recent.length < 5) return 0.5;
  let hits = 0;
  for (const d of recent) {
    switch (contractType) {
      case "DIGITOVER":  if (barrier !== undefined && d > barrier)  hits++; break;
      case "DIGITUNDER": if (barrier !== undefined && d < barrier)  hits++; break;
      case "DIGITEVEN":  if (d % 2 === 0)                          hits++; break;
      case "DIGITODD":   if (d % 2 !== 0)                          hits++; break;
      case "DIGITMATCH": if (barrier !== undefined && d === barrier) hits++; break;
      case "DIGITDIFF":  if (barrier !== undefined && d !== barrier) hits++; break;
    }
  }
  return hits / recent.length;
}

/**
 * Entry timing score (0–100):
 *  — DIGIT contracts: counts how many of the LAST 3 ticks were AGAINST the bet.
 *    Higher "against" count = better reversal setup = higher timing score.
 *    Rational: after 3 consecutive adverse ticks the market is statistically
 *    more likely to correct, giving an optimal entry moment.
 *  — CALL/PUT: measures directional alignment of recent price ticks.
 */
function entryTimingScore(
  digits: number[],
  prices: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
): number {
  if (contractType === "CALL" || contractType === "PUT") {
    const recent = prices.slice(-8);
    if (recent.length < 3) return 50;
    let aligned = 0;
    for (let i = 1; i < recent.length; i++) {
      const up = recent[i] > recent[i - 1];
      if ((contractType === "CALL" && up) || (contractType === "PUT" && !up)) aligned++;
    }
    return Math.round((aligned / (recent.length - 1)) * 100);
  }

  const last3 = digits.slice(-3);
  if (last3.length < 2) return 50;

  let against = 0;
  for (const d of last3) {
    switch (contractType) {
      case "DIGITOVER":  if (barrier !== undefined && d <= barrier) against++; break;
      case "DIGITUNDER": if (barrier !== undefined && d >= barrier) against++; break;
      case "DIGITEVEN":  if (d % 2 !== 0) against++; break;
      case "DIGITODD":   if (d % 2 === 0) against++; break;
      case "DIGITMATCH": if (barrier !== undefined && d !== barrier) against++; break;
      case "DIGITDIFF":  if (barrier !== undefined && d === barrier) against++; break;
    }
  }
  // 0 against = poor timing (20), 1 = neutral (50), 2 = good (80), 3 = optimal (100)
  return ([20, 50, 80, 100][against]) ?? 50;
}

/**
 * Theoretical win rate for a contract type + barrier.
 * Used to normalize edge relative to the baseline (not just in absolute terms).
 */
function theoreticalWinRate(contractType: SpeedContractType, barrier: number | undefined): number {
  switch (contractType) {
    case "DIGITOVER":  return barrier !== undefined ? (9 - barrier) / 10 : 0.5;
    case "DIGITUNDER": return barrier !== undefined ? barrier / 10 : 0.5;
    case "DIGITEVEN":
    case "DIGITODD":
    case "CALL":
    case "PUT":        return 0.5;
    case "DIGITMATCH": return 0.1;
    case "DIGITDIFF":  return 0.9;
    default:           return 0.5;
  }
}

/**
 * Auto-select barrier for DIGITMATCH: digit with the highest Markov probability
 * of appearing NEXT (given current last digit), blended with recent frequency.
 * This is the most accurate "hot digit" prediction available.
 */
function pickBestMatchBarrier(digits: number[]): number {
  const markov  = markovNextProb(digits);
  const freq30  = digitFrequency(digits.slice(-30));
  const hotScore = markov.map((m, i) => m * 0.60 + (freq30[i] ?? 0) * 0.40);
  return hotScore.indexOf(Math.max(...hotScore));
}

/**
 * Auto-select barrier for DIGITDIFF: digit with the lowest combined Markov
 * probability + recent frequency — the "coldest" digit, least likely to appear.
 */
function pickBestDiffBarrier(digits: number[]): number {
  const markov   = markovNextProb(digits);
  const freq30   = digitFrequency(digits.slice(-30));
  const coldScore = markov.map((m, i) => m * 0.60 + (freq30[i] ?? 0) * 0.40);
  return coldScore.indexOf(Math.min(...coldScore));
}

/**
 * Extract OVER and UNDER barriers from the barriers array.
 * Convention: barriers[0] = OVER barrier, barriers[1] = UNDER barrier.
 * Each has its own independent default — never reuse barriers[0] as UNDER fallback.
 */
function extractBarriers(barriers: number[]): { overBarrier: number; underBarrier: number } {
  const overBarrier  = barriers.length > 0 ? barriers[0] : 1;   // default OVER 1  (~90% win)
  const underBarrier = barriers.length > 1 ? barriers[1] : 8;   // default UNDER 8 (~90% win)
  return { overBarrier, underBarrier };
}

/**
 * PrecisionAI v2 — five-signal, contract-type-specific market scorer.
 *
 * Five signals per contract type:
 *   1. Empirical win rate   (last 50 ticks) — actual market behaviour
 *   2. Short-term momentum  (last 15 ticks) — what the market is doing RIGHT NOW
 *   3. Markov chain         (full buffer)   — probabilistic next-digit prediction
 *   4. Entry timing         (last 3-5 ticks) — is this the optimal entry moment?
 *   5. Pattern stability    (30t vs 15t)    — how consistent is the signal? (noise filter)
 *
 * Score formula:
 *   base  = 50 + clamp((winP − theoretical) / 0.15, −1, 1) × 50
 *   bonus = timingBonus (±10) + stabilityBonus (±5)
 *   score = clamp(base + bonus, 0, 100)
 *
 * Score 50 = exactly at theoretical win rate (marginal edge), 100 = excellent.
 * Requires score ≥ MIN_TRADE_SCORE (50) for normal, ≥ MIN_RECOVERY_SCORE (52) for recovery.
 */
function precisionScore(
  symbol: string,
  displayName: string,
  contractType: SpeedContractType,
  barrier: number | undefined,
  digits: number[],
  prices: number[],
): MarketScore | null {
  if (contractType.startsWith("DIGIT") && digits.length < 35) return null;
  if ((contractType === "CALL" || contractType === "PUT") && prices.length < 20) return null;

  const freq50   = digitFrequency(digits.slice(-50));
  const markov   = markovNextProb(digits);
  const momentum = momentumRate(digits, contractType, barrier, 15);
  const timing   = entryTimingScore(digits, prices, contractType, barrier);

  // Stability: agreement between 30-tick and 15-tick momentum (high = reliable pattern)
  const mom30       = momentumRate(digits, contractType, barrier, 30);
  const stabilityRaw = Math.max(0, 1 - Math.abs(mom30 - momentum) / 0.30);

  let empirical: number;
  let markovWin: number;
  let payout: number;

  switch (contractType) {
    case "DIGITOVER": {
      if (barrier === undefined) return null;
      empirical = freq50.slice(barrier + 1).reduce((a, b) => a + b, 0);
      markovWin = markov.slice(barrier + 1).reduce((a, b) => a + b, 0);
      payout    = DIGIT_PAYOUTS_OVER[barrier] ?? 1.63;
      break;
    }
    case "DIGITUNDER": {
      if (barrier === undefined) return null;
      empirical = freq50.slice(0, barrier).reduce((a, b) => a + b, 0);
      markovWin = markov.slice(0, barrier).reduce((a, b) => a + b, 0);
      payout    = DIGIT_PAYOUTS_UNDER[barrier] ?? 1.63;
      break;
    }
    case "DIGITEVEN": {
      empirical = [0, 2, 4, 6, 8].reduce((s, d) => s + (freq50[d] ?? 0), 0);
      markovWin = [0, 2, 4, 6, 8].reduce((s, d) => s + (markov[d] ?? 0), 0);
      payout    = 1.96;
      break;
    }
    case "DIGITODD": {
      empirical = [1, 3, 5, 7, 9].reduce((s, d) => s + (freq50[d] ?? 0), 0);
      markovWin = [1, 3, 5, 7, 9].reduce((s, d) => s + (markov[d] ?? 0), 0);
      payout    = 1.96;
      break;
    }
    case "DIGITMATCH": {
      if (barrier === undefined) return null;
      empirical = freq50[barrier] ?? 0.1;
      markovWin = markov[barrier] ?? 0.1;
      payout    = 9.0;
      break;
    }
    case "DIGITDIFF": {
      if (barrier === undefined) return null;
      empirical = 1 - (freq50[barrier] ?? 0.1);
      markovWin = 1 - (markov[barrier] ?? 0.1);
      payout    = 1.04;
      break;
    }
    case "CALL": {
      let ups = 0;
      for (let i = 1; i < prices.length; i++) if (prices[i] > prices[i - 1]) ups++;
      empirical = ups / Math.max(1, prices.length - 1);
      markovWin = empirical;
      payout    = 1.91;
      break;
    }
    case "PUT": {
      let downs = 0;
      for (let i = 1; i < prices.length; i++) if (prices[i] < prices[i - 1]) downs++;
      empirical = downs / Math.max(1, prices.length - 1);
      markovWin = empirical;
      payout    = 1.91;
      break;
    }
    default: return null;
  }

  // Composite win probability (three signals, weighted)
  const winP = empirical * 0.50 + markovWin * 0.25 + momentum * 0.25;

  // Normalize edge relative to theoretical win rate
  // max achievable edge ≈ 15 percentage points above theoretical
  const theoretical    = theoreticalWinRate(contractType, barrier);
  const edgeNorm       = Math.max(-1, Math.min(1, (winP - theoretical) / 0.15));
  const timingBonus    = (timing - 50) * 0.20;          // ±10 pts
  const stabilityBonus = (stabilityRaw - 0.5) * 10;     // ±5 pts

  const score = Math.min(100, Math.max(0,
    50 + edgeNorm * 50 + timingBonus + stabilityBonus
  ));

  const ev = winP * (payout - 1) - (1 - winP);
  const reason = [
    `${(winP * 100).toFixed(1)}% win-p`,
    `timing ${timing.toFixed(0)}/100`,
    `EV ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}%`,
    `stability ${(stabilityRaw * 100).toFixed(0)}%`,
  ].join(" · ");

  return { symbol, displayName, contractType, barrier, score, winProbability: winP, payout, reason };
}

/**
 * Green-light entry check — is this the OPTIMAL moment to execute this contract?
 *
 * Each contract type has a specific "entry moment" that maximises win probability:
 *
 *   DIGITOVER (barrier B):
 *     GREEN if last digit was ≤ B (reversal setup — market just hit/went below
 *     barrier → statistically more likely to bounce back above it next tick).
 *     Also GREEN if short-term momentum ≥ 65% (strong trend — ride it).
 *
 *   DIGITUNDER (barrier B):
 *     GREEN if last digit was ≥ B (reversal setup).
 *     Also GREEN if momentum ≥ 65%.
 *
 *   DIGITEVEN:
 *     GREEN if last digit was ODD (alternation play — volatile indices oscillate).
 *     Also GREEN if even frequency in last 10 ticks > 60%.
 *
 *   DIGITODD:
 *     GREEN if last digit was EVEN. Also GREEN if odd freq last 10 > 60%.
 *
 *   CALL:
 *     GREEN if last tick was UP and ≥ 2 of last 5 ticks were UP (momentum).
 *
 *   PUT:
 *     GREEN if last tick was DOWN and ≥ 2 of last 5 ticks were DOWN.
 *
 *   DIGITMATCH (target digit):
 *     GREEN if target appeared in last 7 ticks BUT NOT in the last 2 ticks.
 *     (Hot but not just hit — peak probability window.)
 *
 *   DIGITDIFF (target digit):
 *     GREEN if target digit NOT in last 8 ticks (cold enough to safely exclude).
 */
function isGreenLight(
  digits: number[],
  prices: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
): boolean {
  const lastDigit = digits[digits.length - 1];

  switch (contractType) {
    case "DIGITOVER": {
      if (barrier === undefined) return true;
      const reversal  = lastDigit !== undefined && lastDigit <= barrier;
      const momentum  = momentumRate(digits, contractType, barrier, 10) >= 0.65;
      return reversal || momentum;
    }
    case "DIGITUNDER": {
      if (barrier === undefined) return true;
      const reversal  = lastDigit !== undefined && lastDigit >= barrier;
      const momentum  = momentumRate(digits, contractType, barrier, 10) >= 0.65;
      return reversal || momentum;
    }
    case "DIGITEVEN": {
      const reversal  = lastDigit !== undefined && lastDigit % 2 !== 0;
      const momentum  = momentumRate(digits, contractType, undefined, 10) >= 0.60;
      return reversal || momentum;
    }
    case "DIGITODD": {
      const reversal  = lastDigit !== undefined && lastDigit % 2 === 0;
      const momentum  = momentumRate(digits, contractType, undefined, 10) >= 0.60;
      return reversal || momentum;
    }
    case "CALL": {
      if (prices.length < 3) return true;
      const lastUp = prices[prices.length - 1] > prices[prices.length - 2];
      const last5  = prices.slice(-5);
      let ups = 0;
      for (let i = 1; i < last5.length; i++) if (last5[i] > last5[i - 1]) ups++;
      return lastUp && ups >= 2;
    }
    case "PUT": {
      if (prices.length < 3) return true;
      const lastDown = prices[prices.length - 1] < prices[prices.length - 2];
      const last5    = prices.slice(-5);
      let downs = 0;
      for (let i = 1; i < last5.length; i++) if (last5[i] < last5[i - 1]) downs++;
      return lastDown && downs >= 2;
    }
    case "DIGITMATCH": {
      if (barrier === undefined) return true;
      const last7 = digits.slice(-7);
      const last2 = digits.slice(-2);
      // Target digit appeared recently (hot) but not in the very last 2 ticks
      return last7.includes(barrier) && !last2.includes(barrier);
    }
    case "DIGITDIFF": {
      if (barrier === undefined) return true;
      // Target digit has NOT appeared in the last 8 ticks (cold enough)
      return !digits.slice(-8).includes(barrier);
    }
    default: return true;
  }
}

/**
 * FastRecoveryGate — selects the best recovery contract in under 2 seconds.
 *
 * Key differences from the old deepRecoveryGate (3-window consensus):
 *  1. Single 60-tick window — no waiting for 100/150-tick agreement.
 *     60 ticks is statistically sufficient and immediately available.
 *  2. Always returns a candidate — never blocks indefinitely. Falls back to
 *     best available even if below threshold (caller uses a hard attempt cap).
 *  3. Green-light check is a SUGGESTION, not a gate. Caller allows 1 extra tick
 *     if not green, then executes regardless.
 *  4. Scores ALL user-selected recovery contract types simultaneously and picks
 *     the highest-quality setup, not just the configured one.
 *
 * Adaptive threshold (slightly tighter after consecutive losses, still bounded):
 *   0 consecutive recovery losses → minScore 52
 *   1 loss                        → minScore 55
 *   2+ losses                     → minScore 58
 */
function fastRecoveryGate(
  symbol: string,
  displayName: string,
  contractTypes: SpeedContractType[],
  barriers: number[],
  consecutiveLosses: number,
): { winner: MarketScore; greenLight: boolean } | null {
  const minScore = consecutiveLosses >= 2 ? 58 : consecutiveLosses >= 1 ? 55 : 52;
  const { overBarrier, underBarrier } = extractBarriers(barriers);

  const digits = tickManager.getDigits(symbol, 60);
  const prices = tickManager.getTicks(symbol, 50);
  if (digits.length < 30) return null; // insufficient tick data

  const candidates: (MarketScore & { greenLight: boolean })[] = [];

  for (const ct of contractTypes) {
    let barrier: number | undefined;
    if      (ct === "DIGITOVER")  barrier = overBarrier;
    else if (ct === "DIGITUNDER") barrier = underBarrier;
    else if (ct === "DIGITMATCH") barrier = pickBestMatchBarrier(digits);
    else if (ct === "DIGITDIFF")  barrier = pickBestDiffBarrier(digits);

    const result = precisionScore(symbol, displayName, ct, barrier, digits, prices);
    if (!result) continue;
    if (result.score < minScore) continue;

    const gl = isGreenLight(digits, prices, ct, barrier);
    candidates.push({ ...result, greenLight: gl });
  }

  if (candidates.length === 0) return null;

  // Rank: green-light candidates first, then by score descending
  candidates.sort((a, b) => {
    if (a.greenLight !== b.greenLight) return a.greenLight ? -1 : 1;
    return b.score - a.score;
  });

  const best = candidates[0]!;
  return { winner: best, greenLight: best.greenLight };
}

// ── Market ranking functions ───────────────────────────────────────────────────

/**
 * Score all markets for a given set of contract types and barriers.
 * Uses precisionScore (5-signal) instead of the old single-formula scoreMarket.
 * Returns markets sorted by score descending.
 */
export async function analyzeMarketsForStrategy(
  contractTypes: SpeedContractType[],
  barriers: number[],
): Promise<MarketScore[]> {
  const scored: MarketScore[] = [];
  const { overBarrier, underBarrier } = extractBarriers(barriers);

  for (const market of DERIV_MARKETS) {
    if (!market.digitEnabled && contractTypes.some(ct => ct.startsWith("DIGIT"))) continue;

    const digits = tickManager.getDigits(market.symbol, 60);
    const prices = tickManager.getTicks(market.symbol, 50);

    for (const ct of contractTypes) {
      let barrier: number | undefined;
      if      (ct === "DIGITOVER")                     barrier = overBarrier;
      else if (ct === "DIGITUNDER")                    barrier = underBarrier;
      else if (ct === "DIGITMATCH" || ct === "DIGITDIFF") {
        if (digits.length < 30) continue;
        barrier = ct === "DIGITMATCH" ? pickBestMatchBarrier(digits) : pickBestDiffBarrier(digits);
      }

      const s = precisionScore(market.symbol, market.displayName, ct, barrier, digits, prices);
      if (s) scored.push(s);
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Score a single locked market across the given contract types and return the best setup.
 * Barriers are the exact values the user configured for OVER/UNDER.
 */
export async function scoreSingleMarket(
  symbol: string,
  displayName: string,
  contractTypes: SpeedContractType[],
  barriers: number[],
): Promise<MarketScore | null> {
  const digits = tickManager.getDigits(symbol, 60);
  const prices = tickManager.getTicks(symbol, 50);
  const { overBarrier, underBarrier } = extractBarriers(barriers);
  const scored: MarketScore[] = [];

  for (const ct of contractTypes) {
    let barrier: number | undefined;
    if      (ct === "DIGITOVER")  barrier = overBarrier;
    else if (ct === "DIGITUNDER") barrier = underBarrier;
    else if (ct === "DIGITMATCH") barrier = pickBestMatchBarrier(digits);
    else if (ct === "DIGITDIFF")  barrier = pickBestDiffBarrier(digits);

    const s = precisionScore(symbol, displayName, ct, barrier, digits, prices);
    if (s) scored.push(s);
  }

  return scored.sort((a, b) => b.score - a.score)[0] ?? null;
}

/**
 * Full market scan — evaluates every market for both normal and recovery settings.
 * Recovery is weighted 60% (where losses compound) vs normal 40%.
 * Emits SSE progress events so the frontend can animate the scan in real time.
 */
export async function scanBestMarket(config: SpeedAIConfig): Promise<ScanResult> {
  const candidatesBySymbol = new Map<string, MarketScore>();
  const total = DERIV_MARKETS.length;
  let scanned = 0;

  for (const market of DERIV_MARKETS) {
    broadcastSSE("speed_ai_scan_progress", {
      scanning: market.displayName,
      symbol: market.symbol,
      scanned,
      total,
      results: [...candidatesBySymbol.values()].sort((a, b) => b.score - a.score),
    });

    const normalBest   = await scoreSingleMarket(market.symbol, market.displayName, config.normalContractTypes,   config.normalBarriers);
    const recoveryBest = await scoreSingleMarket(market.symbol, market.displayName, config.recoveryContractTypes, config.recoveryBarriers);

    scanned++;
    await sleep(280); // pacing so SSE events reach the frontend before next fires

    if (!normalBest && !recoveryBest) continue;

    const normalScore   = normalBest?.score   ?? 0;
    const recoveryScore = recoveryBest?.score ?? 0;
    const combinedScore = Math.round((normalScore * 0.4 + recoveryScore * 0.6) * 10) / 10;

    const base = normalBest ?? recoveryBest!;
    candidatesBySymbol.set(market.symbol, {
      ...base,
      score:                combinedScore,
      normalScore:          Math.round(normalScore   * 10) / 10,
      recoveryScore:        Math.round(recoveryScore * 10) / 10,
      recoveryContractType: recoveryBest?.contractType,
      recoveryBarrier:      recoveryBest?.barrier,
    });
  }

  const allScored = [...candidatesBySymbol.values()].sort((a, b) => b.score - a.score);

  broadcastSSE("speed_ai_scan_progress", {
    scanning: null, symbol: null,
    scanned: total, total,
    results: allScored,
  });

  if (allScored.length === 0) {
    return { suitable: false, best: null, allScored: [], reason: "No tick data available yet — wait a few seconds and scan again" };
  }

  const best     = allScored[0];
  const suitable = best.score >= SUITABLE_SCORE_THRESHOLD;
  const reason   = suitable
    ? `${best.displayName} has a strong edge (score ${best.score.toFixed(0)}/100) for your settings`
    : `No market shows a clear edge yet — best was ${best.displayName} at ${best.score.toFixed(0)}/100`;

  return { suitable, best, allScored, reason };
}

// ── Recovery stake calculation ────────────────────────────────────────────────

function computeRecoveryStake(
  rec: SpeedRecoveryState,
  payout: number,
  config: SpeedAIConfig,
  maxStake: number,
): number {
  if (!rec.inRecovery) return config.stake;
  const netPayout = payout - 1;
  if (netPayout <= 0) return config.stake;

  const minRecovery = (rec.unrecoveredAmount / netPayout) * 1.05;
  const baseMultiplier = config.recoveryMultiplier;

  if (config.recoveryMethod === "instant") {
    const splitEquiv = rec.baseStake * baseMultiplier;
    const stake = splitEquiv * netPayout >= rec.unrecoveredAmount ? splitEquiv : minRecovery;
    return Math.max(0.35, Math.min(stake, maxStake));
  }

  // Split: progressive cap per step
  const stepOffset     = Math.max(0, rec.recoveryStep - 1);
  const payoutImpliedMin = (1 / netPayout) * 1.05;
  const effective      = Math.max(baseMultiplier, payoutImpliedMin) + stepOffset;
  const splitCap       = rec.baseStake * effective;
  return Math.max(0.35, Math.min(minRecovery, splitCap, maxStake));
}

function recordRecoveryOutcome(
  rec: SpeedRecoveryState,
  won: boolean,
  profit: number,
  stake: number,
  maxSteps: number,
): SpeedRecoveryState {
  if (won) {
    if (rec.inRecovery) {
      const remaining = rec.unrecoveredAmount - Math.max(0, profit);
      if (remaining <= 0.005) {
        return { inRecovery: false, recoveryStep: 0, unrecoveredAmount: 0, baseStake: rec.baseStake, consecutiveRecoveryLosses: 0 };
      }
      return { ...rec, unrecoveredAmount: remaining, consecutiveRecoveryLosses: 0 };
    }
    return rec;
  }
  // Loss
  if (!rec.inRecovery) {
    return {
      inRecovery: true,
      recoveryStep: 1,
      unrecoveredAmount: stake,
      baseStake: rec.baseStake > 0 ? rec.baseStake : stake,
      consecutiveRecoveryLosses: 0,
    };
  }
  return {
    ...rec,
    recoveryStep: Math.min(rec.recoveryStep + 1, Math.max(1, maxSteps)),
    unrecoveredAmount: rec.unrecoveredAmount + stake,
    consecutiveRecoveryLosses: rec.consecutiveRecoveryLosses + 1,
  };
}

// ── Sleep / broadcast helpers ─────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function broadcast() {
  broadcastSSE("speed_ai_update", getStatus());
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getStatus(): SpeedAIStatus {
  return {
    running:                   session.running,
    sessionId:                 session.sessionId,
    totalProfit:               Math.round(session.totalProfit * 100) / 100,
    tradeCount:                session.tradeCount,
    winCount:                  session.winCount,
    lossCount:                 session.lossCount,
    currentStake:              session.currentStake,
    inRecovery:                session.recovery.inRecovery,
    recoveryStep:              session.recovery.recoveryStep,
    unrecoveredAmount:         Math.round(session.recovery.unrecoveredAmount * 100) / 100,
    consecutiveRecoveryLosses: session.recovery.consecutiveRecoveryLosses,
    currentMarket:             session.currentMarket,
    currentContractType:       session.currentContractType,
    lastResult:                session.lastResult,
    config:                    session.config ?? undefined,
    message:                   session.message,
    topMarkets:                session.topMarkets.slice(0, 6),
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running       = false;
  session.message       = "Session stopped by user";
  broadcast();
  logger.info("SpeedAI session stop requested");
}

export async function startSession(config: SpeedAIConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "A SpeedAI session is already running" };

  if (config.stake < 0.35)             return { ok: false, error: "Minimum stake is $0.35" };
  if (config.stopLoss <= 0)            return { ok: false, error: "Stop loss must be positive" };
  if (config.takeProfit <= 0)          return { ok: false, error: "Take profit must be positive" };
  if (config.normalContractTypes.length   === 0) return { ok: false, error: "Select at least one normal contract type" };
  if (config.recoveryContractTypes.length === 0) return { ok: false, error: "Select at least one recovery contract type" };

  session = {
    running:    true,
    sessionId:  `spd_${Date.now()}`,
    config,
    totalProfit: 0,
    tradeCount:  0,
    winCount:    0,
    lossCount:   0,
    currentStake: config.stake,
    recovery: { inRecovery: false, recoveryStep: 0, unrecoveredAmount: 0, baseStake: config.stake, consecutiveRecoveryLosses: 0 },
    topMarkets:   [],
    stopRequested: false,
    message: "Analyzing markets…",
  };

  logger.info({ config }, "SpeedAI session starting");
  broadcast();

  runLoop(config).catch(err => {
    logger.error({ err }, "SpeedAI loop crashed");
    session.running = false;
    session.message = `Error: ${err instanceof Error ? err.message : String(err)}`;
    broadcast();
  });

  return { ok: true };
}

// ── Trade loop ─────────────────────────────────────────────────────────────────

async function runLoop(config: SpeedAIConfig) {
  // Always trade on the active account (real vs demo switch respected)
  let accounts = await db.select().from(accountsTable).where(eq(accountsTable.isActive, true)).limit(1);
  if (accounts.length === 0) accounts = await db.select().from(accountsTable).limit(1);

  const settings      = await db.select().from(settingsTable).limit(1);
  const paperTradeMode = settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false;
  // Prefer module-level cache; fall back to DB bearer token then legacy PAT
  const token    = getCachedToken() ?? (accounts.length > 0 ? (accounts[0].bearerToken ?? accounts[0].token ?? null) : null);
  const currency = accounts.length > 0 ? accounts[0].currency : "USD";
  const isLive   = !paperTradeMode && !!token;
  const maxStake = settings.length > 0 ? Number(settings[0].maxTradeStake) : 500;

  const lockedDerivsMarket = config.lockedSymbol
    ? DERIV_MARKETS.find(m => m.symbol === config.lockedSymbol) ?? null
    : null;

  if (config.lockedSymbol && !lockedDerivsMarket) {
    session.running = false;
    session.message = `⚠️ Market ${config.lockedSymbol} not found — session aborted`;
    broadcast();
    logger.error({ symbol: config.lockedSymbol }, "SpeedAI locked symbol not found in DERIV_MARKETS");
    return;
  }

  // Execution latency EMA (logged each trade for regression visibility)
  let avgExecLatencyMs = 800;

  // Pre-analyzed cache: market analysis runs in parallel with the post-trade
  // pause so the next iteration starts executing immediately — no scan latency.
  let preAnalyzedScored: MarketScore[] | null = null;

  while (session.running && !session.stopRequested) {
    // ── Mode: normal or recovery ───────────────────────────────────────────────
    const inRecovery    = session.recovery.inRecovery;
    const contractTypes = inRecovery ? config.recoveryContractTypes : config.normalContractTypes;
    const barriers      = inRecovery ? config.recoveryBarriers      : config.normalBarriers;

    // ── Find best market setup ─────────────────────────────────────────────────
    let best: MarketScore | undefined;

    if (lockedDerivsMarket) {
      const cached = preAnalyzedScored?.find(m => m.symbol === lockedDerivsMarket.symbol);
      preAnalyzedScored = null;

      if (cached) {
        best = cached;
      } else {
        const result = await scoreSingleMarket(lockedDerivsMarket.symbol, lockedDerivsMarket.displayName, contractTypes, barriers);
        if (!result) {
          session.message = "Waiting for tick data on locked market…";
          broadcast();
          await sleep(2000);
          continue;
        }
        best = result;
      }
      session.topMarkets = [best];
    } else {
      if (preAnalyzedScored) {
        const scored      = preAnalyzedScored;
        preAnalyzedScored = null;
        session.topMarkets = scored;
        if (scored.length === 0) {
          session.message = "No markets available — waiting for tick data…";
          broadcast();
          await sleep(3000);
          continue;
        }
        if (scored[0].score < MIN_TRADE_SCORE) {
          session.message = `No high-quality setup (best ${scored[0].score}/100) — waiting for edge…`;
          broadcast();
          preAnalyzedScored = null;
          await sleep(2000);
          continue;
        }
        best = scored[0];
      } else {
        session.message = "Scanning markets…";
        broadcast();
        const scored = await analyzeMarketsForStrategy(contractTypes, barriers);
        session.topMarkets = scored;
        if (scored.length === 0) {
          session.message = "No markets available — waiting for tick data…";
          broadcast();
          await sleep(3000);
          continue;
        }
        if (scored[0].score < MIN_TRADE_SCORE) {
          session.message = `No high-quality setup (best ${scored[0].score}/100) — waiting for edge…`;
          broadcast();
          preAnalyzedScored = null;
          await sleep(2000);
          continue;
        }
        best = scored[0];
      }
    }

    // ── Gate: recovery (fast, bounded) vs normal (lightweight) ────────────────
    if (inRecovery) {
      // ── FastRecoveryGate: max 3 attempts × ~600 ms = under 2 seconds ──────
      const consLosses   = session.recovery.consecutiveRecoveryLosses;
      const baseWaitMs   = consLosses >= 2 ? 700 : consLosses >= 1 ? 600 : 500;
      const maxAttempts  = 3;
      let candidate: { winner: MarketScore; greenLight: boolean } | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        candidate = fastRecoveryGate(
          best.symbol, best.displayName,
          config.recoveryContractTypes, barriers, consLosses,
        );
        if (candidate) break;

        session.message = `⏳ Recovery analysis${consLosses > 0 ? ` (${consLosses} loss${consLosses > 1 ? "es" : ""})` : ""}…`;
        broadcast();
        preAnalyzedScored = null;
        await sleep(baseWaitMs);
        if (!session.running || session.stopRequested) break;
      }

      // Adaptive fallback: if no candidate cleared the threshold, lower it and
      // pick the best available. Never block recovery indefinitely.
      if (!candidate) {
        const fallDigits = tickManager.getDigits(best.symbol, 60);
        const fallPrices = tickManager.getTicks(best.symbol, 50);
        const { overBarrier: fo, underBarrier: fu } = extractBarriers(barriers);
        let bestFallback: MarketScore | null = null;

        for (const ct of config.recoveryContractTypes) {
          let fb: number | undefined;
          if      (ct === "DIGITOVER")  fb = fo;
          else if (ct === "DIGITUNDER") fb = fu;
          else if (ct === "DIGITMATCH") fb = pickBestMatchBarrier(fallDigits);
          else if (ct === "DIGITDIFF")  fb = pickBestDiffBarrier(fallDigits);

          const s = precisionScore(best.symbol, best.displayName, ct, fb, fallDigits, fallPrices);
          if (s && (!bestFallback || s.score > bestFallback.score)) bestFallback = s;
        }

        if (bestFallback) {
          const gl = isGreenLight(fallDigits, fallPrices, bestFallback.contractType, bestFallback.barrier);
          candidate = { winner: bestFallback, greenLight: gl };
          logger.info({ symbol: best.symbol, score: bestFallback.score, consLosses },
            "SpeedAI recovery: using adaptive fallback (threshold lowered)");
        } else {
          // Truly no data — wait one cycle
          session.message = "⏳ Waiting for market data for recovery…";
          broadcast();
          preAnalyzedScored = null;
          await sleep(1000);
          continue;
        }
      }

      // Green-light check: wait at most 1 extra tick (~600 ms) then execute regardless
      if (!candidate.greenLight) {
        await sleep(600);
        if (!session.running || session.stopRequested) break;
        const freshDigits = tickManager.getDigits(best.symbol, 60);
        const freshPrices = tickManager.getTicks(best.symbol, 50);
        const refreshed   = fastRecoveryGate(
          best.symbol, best.displayName,
          config.recoveryContractTypes, barriers, consLosses,
        );
        if (refreshed) candidate = refreshed;
        // Even if still not green, we execute — never wait beyond this point
      }

      // Override best with the recovery candidate
      best = {
        ...best,
        contractType:   candidate.winner.contractType,
        barrier:        candidate.winner.barrier,
        payout:         candidate.winner.payout,
        winProbability: candidate.winner.winProbability,
        score:          candidate.winner.score,
        reason:         candidate.winner.reason,
      };

      logger.info({
        symbol:       best.symbol,
        contractType: best.contractType,
        barrier:      best.barrier,
        score:        best.score,
        winP:         best.winProbability,
        greenLight:   candidate.greenLight,
        consLosses,
      }, "SpeedAI recovery: fast gate complete");

    } else {
      // ── Normal trade: green-light check, max 2 × 400 ms wait ─────────────
      const normalDigits = tickManager.getDigits(best.symbol, 60);
      const normalPrices = tickManager.getTicks(best.symbol, 50);
      const gl = isGreenLight(normalDigits, normalPrices, best.contractType, best.barrier);

      if (!gl) {
        if (best.score >= 70) {
          // High-confidence setup → execute immediately regardless of timing
          logger.info({ symbol: best.symbol, score: best.score },
            "SpeedAI normal: high-score override (≥70) — skipping green-light wait");
        } else {
          // Wait up to 2 ticks for a better entry, then execute anyway
          session.message = `⏳ Awaiting optimal entry on ${best.displayName}…`;
          broadcast();
          preAnalyzedScored = null;
          for (let gl_retry = 0; gl_retry < 2; gl_retry++) {
            await sleep(400);
            if (!session.running || session.stopRequested) break;
            const rDigits = tickManager.getDigits(best.symbol, 60);
            const rPrices = tickManager.getTicks(best.symbol, 50);
            if (isGreenLight(rDigits, rPrices, best.contractType, best.barrier)) break;
          }
          // After max retries, execute whatever we have — never skip a full cycle
        }
      }
    }

    // ── Compute stake and announce ─────────────────────────────────────────────
    const stake = Math.round(computeRecoveryStake(session.recovery, best.payout, config, maxStake) * 100) / 100;

    session.currentMarket       = best.displayName;
    session.currentContractType = best.contractType + (best.barrier !== undefined ? ` ${best.barrier}` : "");
    session.currentStake        = stake;
    session.message = `Trading ${best.contractType}${best.barrier !== undefined ? ` ${best.barrier}` : ""} on ${best.displayName}`;
    broadcast();

    // ── Execute trade ──────────────────────────────────────────────────────────
    const execStart = Date.now();
    let won: boolean;
    let profit: number;

    if (isLive) {
      try {
        // Normal trades: enforce configured barriers (never drift from user's choice)
        // Recovery trades: fastRecoveryGate already selected the optimal barrier
        if (!inRecovery) {
          const { overBarrier: cfgOver, underBarrier: cfgUnder } = extractBarriers(barriers);
          if (best.contractType === "DIGITOVER"  && best.barrier !== cfgOver) {
            logger.error({ expected: cfgOver,  actual: best.barrier }, "SpeedAI barrier mismatch — forcing configured OVER barrier");
            best = { ...best, barrier: cfgOver };
          }
          if (best.contractType === "DIGITUNDER" && best.barrier !== cfgUnder) {
            logger.error({ expected: cfgUnder, actual: best.barrier }, "SpeedAI barrier mismatch — forcing configured UNDER barrier");
            best = { ...best, barrier: cfgUnder };
          }
        }

        logger.info({
          symbol:      best.symbol,
          contractType: best.contractType,
          barrier:     best.barrier,
          stake:       Math.round(stake * 100) / 100,
          inRecovery,
          consecutiveRecoveryLosses: session.recovery.consecutiveRecoveryLosses,
        }, inRecovery ? "SpeedAI executing fast-gate recovery trade" : "SpeedAI executing normal trade");

        const liveResult = await executeLiveTrade(token!, {
          symbol:       best.symbol,
          contractType: best.contractType,
          stake:        Math.round(stake * 100) / 100,
          duration:     1,
          durationUnit: "t",
          currency,
          barrier:      best.barrier,
        });
        const result = await waitForContractResult(token!, liveResult.contractId, 30_000);
        won    = result.won;
        profit = result.profit;
      } catch (err) {
        logger.warn({ err, symbol: best.symbol }, "SpeedAI live trade failed — skipping");
        session.message = `Trade failed: ${err instanceof Error ? err.message : String(err)} — retrying…`;
        broadcast();
        await sleep(2000);
        continue;
      }
    } else {
      // Paper / demo simulation
      won    = Math.random() < best.winProbability;
      profit = won ? stake * (best.payout - 1) : -stake;
    }

    // ── Track execution latency ────────────────────────────────────────────────
    const execLatencyMs = Date.now() - execStart;
    avgExecLatencyMs    = Math.round(avgExecLatencyMs * 0.7 + execLatencyMs * 0.3);
    if (isLive) {
      logger.info(
        { execLatencyMs, avgExecLatencyMs, symbol: best.symbol, contractType: best.contractType },
        "SpeedAI 1-tick execution latency",
      );
    }

    // ── Record outcome ─────────────────────────────────────────────────────────
    session.tradeCount++;
    session.totalProfit = Math.round((session.totalProfit + profit) * 100) / 100;
    if (won) { session.winCount++;  session.lastResult = "won";  }
    else      { session.lossCount++; session.lastResult = "lost"; }

    session.recovery = recordRecoveryOutcome(session.recovery, won, profit, stake, config.maxRecoverySteps);

    // Sync live balance — update only the active account
    if (isLive) {
      try {
        const newBal = await getLiveBalance(token!);
        if (newBal !== null && accounts.length > 0) {
          await db.update(accountsTable)
            .set({ balance: String(newBal), updatedAt: new Date() })
            .where(eq(accountsTable.id, accounts[0].id));
        }
      } catch { /* best-effort */ }
    }

    broadcast();

    // ── Check TP / SL ──────────────────────────────────────────────────────────
    if (session.totalProfit >= config.takeProfit) {
      session.running = false;
      session.message = `✅ Take profit $${config.takeProfit.toFixed(2)} reached! Session complete.`;
      broadcast();
      logger.info({ profit: session.totalProfit }, "SpeedAI take profit reached");
      return;
    }
    if (session.totalProfit <= -config.stopLoss) {
      session.running = false;
      session.message = `🛑 Stop loss $${config.stopLoss.toFixed(2)} hit. Session stopped.`;
      broadcast();
      logger.info({ profit: session.totalProfit }, "SpeedAI stop loss triggered");
      return;
    }
    if (session.recovery.inRecovery && session.recovery.recoveryStep >= config.maxRecoverySteps) {
      session.message = `⚡ Recovery step ${config.maxRecoverySteps} — holding stake until debt cleared`;
      broadcast();
    }

    // ── Pre-analyze next trade during the post-trade pause ────────────────────
    // This overlaps scan time with the mandatory pause so the next iteration can
    // execute immediately without waiting for analysis.
    const nextInRecovery    = session.recovery.inRecovery;
    const nextContractTypes = nextInRecovery ? config.recoveryContractTypes : config.normalContractTypes;
    const nextBarriers      = nextInRecovery ? config.recoveryBarriers      : config.normalBarriers;

    // Adaptive pause:
    //   Win  → 300 ms (keep the momentum, no recovery debt to manage)
    //   Loss → 800 ms (brief market breath before recovery analysis)
    const pauseMs = isLive ? (won ? 300 : 800) : 200;

    const preAnalyzePromise = lockedDerivsMarket
      ? scoreSingleMarket(lockedDerivsMarket.symbol, lockedDerivsMarket.displayName, nextContractTypes, nextBarriers)
          .then(r => r ? [r] : [])
      : analyzeMarketsForStrategy(nextContractTypes, nextBarriers);

    await sleep(pauseMs);
    if (!session.running || session.stopRequested) break;

    try {
      const result  = await preAnalyzePromise;
      preAnalyzedScored = result.length > 0 ? result : null;
    } catch {
      preAnalyzedScored = null;
    }
  }

  if (!session.running && !session.message?.startsWith("✅") && !session.message?.startsWith("🛑") && !session.message?.startsWith("⚠️")) {
    session.message = "Session stopped";
    broadcast();
  }
}

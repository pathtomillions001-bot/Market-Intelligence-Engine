/**
 * SpeedAI Engine — 1-tick ultra-fast trading engine  (PrecisionAI v3)
 *
 * Analyzes all markets in real-time to find the best setup for each selected
 * contract type, then executes 1-tick trades in a continuous loop until the
 * user-set Take Profit or Stop Loss is reached.
 *
 * Recovery state is ISOLATED from the global recovery engine so SpeedAI
 * sessions do not interfere with the main autonomous engine.
 *
 * PrecisionAI v3 changes (vs v2):
 *  • Contract-type-specific signal weights in precisionScore — each type's
 *    predictors are weighted by their actual statistical relevance:
 *      OVER/UNDER:  Markov ↑ (digit dependencies are real)
 *      EVEN/ODD:    Momentum ↑ (streak patterns dominate)
 *      MATCH:       Markov-to-target ↑↑ (direct current→target transition)
 *      DIFF:        Empirical + Markov balanced (both must confirm cold digit)
 *      CALL/PUT:    Momentum ↑↑ (recency-weighted price momentum is primary)
 *  • signalBonus per contract type (±15 pts added to score):
 *      OVER/UNDER:  streak-against depth bonus (consecutive reversal ticks)
 *      EVEN/ODD:    streak-against depth bonus (consecutive opposite-parity ticks)
 *      MATCH:       gap-since-last bonus (3-10 ticks = hot window; <3 = penalised)
 *      DIFF:        gap-since-last bonus (≥8 ticks = very cold; <2 = penalised)
 *      CALL/PUT:    recency-weighted price momentum bonus (±15 pts)
 *  • Enhanced isGreenLight(): streak depth for OVER/UNDER (2+ of last 5),
 *    direct Markov-to-target check for MATCH, recency-weighted momentum for CALL/PUT.
 *  • fastRecoveryGate v2: three-window combined scoring (30/60/100 ticks,
 *    weights 0.25/0.50/0.25) — statistically robust without blocking indefinitely.
 *  • scoreSingleMarket + analyzeMarketsForStrategy also use three-window scoring
 *    so normal trades benefit from the same analysis depth as recovery trades.
 *  • pickBestMatchBarrier + pickBestDiffBarrier now factor in gap analysis for
 *    smarter barrier auto-selection.
 *  • Normal-trade green-light retry extended: max 3 × 400 ms (was 2 × 400 ms).
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

// ── PrecisionAI v3 — new signal helpers ───────────────────────────────────────

/**
 * Count consecutive recent ticks that did NOT satisfy the bet condition.
 * Measures the unbroken reversal-setup streak from the most recent tick backwards.
 *
 *   Example: digits=[…,3,2,1], DIGITOVER barrier=4  →  streakAgainstLength=3
 *
 * Used as signalBonus for OVER/UNDER (consecutive lows/highs = reversal setup)
 * and EVEN/ODD (consecutive opposite-parity ticks = alternation play).
 */
function streakAgainstLength(
  digits: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
): number {
  let count = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digits[i];
    let satisfies: boolean;
    switch (contractType) {
      case "DIGITOVER":  satisfies = barrier !== undefined && d > barrier; break;
      case "DIGITUNDER": satisfies = barrier !== undefined && d < barrier; break;
      case "DIGITEVEN":  satisfies = d % 2 === 0; break;
      case "DIGITODD":   satisfies = d % 2 !== 0; break;
      case "DIGITMATCH": satisfies = barrier !== undefined && d === barrier; break;
      case "DIGITDIFF":  satisfies = barrier !== undefined && d !== barrier; break;
      default:           satisfies = false;
    }
    if (!satisfies) count++;
    else break; // unbroken "against" streak ends at first "for" tick
  }
  return count;
}

/**
 * How many ticks ago did a specific digit last appear?
 *   0 = it was the most recent tick.
 *   Returns digits.length when the digit has never appeared in the buffer.
 *
 * Critical for DIGITMATCH (optimal "hot-but-not-just-hit" window: 3-10 ticks)
 * and DIGITDIFF (cold-digit confirmation: longer gap = safer exclusion).
 */
function digitGapSinceLast(digits: number[], targetDigit: number): number {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] === targetDigit) return digits.length - 1 - i;
  }
  return digits.length;
}

/**
 * Markov probability of transitioning FROM the current last digit TO a specific target.
 * More precise than markovNextProb()[target] because it builds the specific row for the
 * actual current-last digit using the full buffer, with Laplace smoothing.
 *
 * This is the most direct next-digit prediction available for MATCH (barrier = target).
 */
function markovToTarget(digits: number[], targetDigit: number): number {
  if (digits.length < 2) return 0.1;
  const last = digits[digits.length - 1];
  if (last < 0 || last > 9) return 0.1;
  const counts = new Array(10).fill(0);
  let total = 0;
  for (let i = 1; i < digits.length; i++) {
    if (digits[i - 1] === last) {
      counts[digits[i]]++;
      total++;
    }
  }
  return (counts[targetDigit] + 1) / (total + 10); // Laplace smoothed
}

/**
 * Recency-weighted price momentum for CALL/PUT.
 * Linear recency weights (recent ticks count more) give a better signal than
 * the flat equal-weight used by momentumRate for price ticks.
 * Returns 0–1: >0.5 = upward bias, <0.5 = downward bias.
 */
function priceMomentumScore(prices: number[], direction: "CALL" | "PUT", window = 12): number {
  const recent = prices.slice(-window);
  if (recent.length < 4) return 0.5;
  let weightedScore = 0;
  let weightSum     = 0;
  for (let i = 1; i < recent.length; i++) {
    const w  = i; // linear recency weight: later ticks count more
    const up = recent[i] > recent[i - 1];
    weightedScore += w * (up ? 1 : 0);
    weightSum     += w;
  }
  const upBias = weightSum > 0 ? weightedScore / weightSum : 0.5;
  return direction === "CALL" ? upBias : 1 - upBias;
}

/**
 * Auto-select barrier for DIGITMATCH: highest Markov + recent-frequency digit,
 * with a gap-analysis bonus for the "hot window" (3-10 ticks since last hit).
 * Penalises digits that just appeared (gap < 3) — too soon to reappear.
 */
function pickBestMatchBarrier(digits: number[]): number {
  const markov = markovNextProb(digits);
  const freq30 = digitFrequency(digits.slice(-30));
  const hotScore = markov.map((m, i) => {
    const gap      = digitGapSinceLast(digits, i);
    const gapBonus = gap >= 3 && gap <= 10 ? 0.12
                   : gap >= 11 && gap <= 20 ? 0.04
                   : gap < 3 ? -0.08 : -0.02;
    return m * 0.50 + (freq30[i] ?? 0) * 0.30 + gapBonus;
  });
  return hotScore.indexOf(Math.max(...hotScore));
}

/**
 * Auto-select barrier for DIGITDIFF: lowest Markov + recent-frequency digit,
 * with a recency penalty so digits that appeared recently are avoided
 * (short gap = "hot" = risky for DIFF).
 */
function pickBestDiffBarrier(digits: number[]): number {
  const markov = markovNextProb(digits);
  const freq30 = digitFrequency(digits.slice(-30));
  const coldScore = markov.map((m, i) => {
    const gap         = digitGapSinceLast(digits, i);
    // Recent appearances inflate the coldness score → digit is not safe for DIFF
    const gapPenalty  = Math.max(0, 8 - Math.min(gap, 8)) / 8 * 0.12;
    return m * 0.50 + (freq30[i] ?? 0) * 0.38 + gapPenalty;
  });
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
 * PrecisionAI v3 — contract-type-aware five-signal market scorer.
 *
 * Signals per contract type:
 *   1. Empirical win rate  (recent ticks) — actual observed market behaviour
 *   2. Short-term momentum (last 15 ticks) — what the market is doing RIGHT NOW
 *   3. Markov chain        (full buffer)   — probabilistic next-digit prediction
 *   4. Entry timing        (last 3-5 ticks) — optimal entry moment?
 *   5. Pattern stability   (30t vs 15t)    — reliable signal or noise?
 *   6. signalBonus         (contract-specific, ±15 pts) — see below
 *
 * Contract-type-specific signal weights (v3 change from uniform v2 weights):
 *   OVER/UNDER:  empirical 0.40 + Markov 0.35 + momentum 0.25  (Markov ↑, digit deps real)
 *   EVEN/ODD:    empirical 0.40 + momentum 0.35 + Markov 0.25  (momentum ↑, streaks dominate)
 *   MATCH:       Markov-to-target 0.55 + empirical 0.30 + momentum 0.15 (direct transition ↑↑)
 *   DIFF:        empirical 0.40 + Markov 0.40 + momentum 0.20  (both must confirm cold digit)
 *   CALL/PUT:    momentum 0.50 + empirical 0.30 + Markov 0.20  (recency momentum dominates)
 *
 * signalBonus per type:
 *   OVER/UNDER:  streak-against depth × 4, cap +12
 *   EVEN/ODD:    streak-against depth × 5, cap +15
 *   MATCH:       gap-since-last: [3-10]→+10, [11-20]→+3, <3→−8, >20→−4
 *   DIFF:        gap-since-last: ≥8→+8, ≥5→+3, ≤1→−8, else→−3
 *   CALL/PUT:    recency-weighted price momentum ±15
 *
 * Score formula:
 *   base  = 50 + clamp((winP − theoretical) / 0.15, −1, 1) × 50
 *   bonus = timingBonus (±10) + stabilityBonus (±5) + signalBonus
 *   score = clamp(base + bonus, 0, 100)
 */
function precisionScore(
  symbol: string,
  displayName: string,
  contractType: SpeedContractType,
  barrier: number | undefined,
  digits: number[],
  prices: number[],
): MarketScore | null {
  if (contractType.startsWith("DIGIT") && digits.length < 30) return null;
  if ((contractType === "CALL" || contractType === "PUT") && prices.length < 15) return null;

  const winLen       = Math.min(50, digits.length);
  const freq50       = digitFrequency(digits.slice(-winLen));
  const markov       = markovNextProb(digits);
  const momentum     = momentumRate(digits, contractType, barrier, 15);
  const timing       = entryTimingScore(digits, prices, contractType, barrier);
  const mom30        = momentumRate(digits, contractType, barrier, Math.min(30, digits.length));
  const stabilityRaw = Math.max(0, 1 - Math.abs(mom30 - momentum) / 0.30);

  let empirical:  number;
  let markovWin:  number;
  let payout:     number;
  let signalBonus = 0;

  switch (contractType) {
    case "DIGITOVER": {
      if (barrier === undefined) return null;
      empirical = freq50.slice(barrier + 1).reduce((a, b) => a + b, 0);
      markovWin = markov.slice(barrier + 1).reduce((a, b) => a + b, 0);
      payout    = DIGIT_PAYOUTS_OVER[barrier] ?? 1.63;
      // Streak-against bonus: consecutive recent digits at/below barrier = building reversal pressure
      signalBonus = Math.min(12, streakAgainstLength(digits, "DIGITOVER", barrier) * 4);
      break;
    }
    case "DIGITUNDER": {
      if (barrier === undefined) return null;
      empirical = freq50.slice(0, barrier).reduce((a, b) => a + b, 0);
      markovWin = markov.slice(0, barrier).reduce((a, b) => a + b, 0);
      payout    = DIGIT_PAYOUTS_UNDER[barrier] ?? 1.63;
      signalBonus = Math.min(12, streakAgainstLength(digits, "DIGITUNDER", barrier) * 4);
      break;
    }
    case "DIGITEVEN": {
      empirical = [0, 2, 4, 6, 8].reduce((s, d) => s + (freq50[d] ?? 0), 0);
      markovWin = [0, 2, 4, 6, 8].reduce((s, d) => s + (markov[d] ?? 0), 0);
      payout    = 1.96;
      // Consecutive odd ticks = alternation setup — the longer the odd streak, the stronger the signal
      signalBonus = Math.min(15, streakAgainstLength(digits, "DIGITEVEN", undefined) * 5);
      break;
    }
    case "DIGITODD": {
      empirical = [1, 3, 5, 7, 9].reduce((s, d) => s + (freq50[d] ?? 0), 0);
      markovWin = [1, 3, 5, 7, 9].reduce((s, d) => s + (markov[d] ?? 0), 0);
      payout    = 1.96;
      signalBonus = Math.min(15, streakAgainstLength(digits, "DIGITODD", undefined) * 5);
      break;
    }
    case "DIGITMATCH": {
      if (barrier === undefined) return null;
      empirical = freq50[barrier] ?? 0.1;
      // Direct Markov transition FROM current digit TO target — the most predictive signal for MATCH
      markovWin = markovToTarget(digits, barrier);
      payout    = 9.0;
      // Gap-since-last: hot window [3-10 ticks] = optimal MATCH setup
      const matchGap = digitGapSinceLast(digits, barrier);
      signalBonus = matchGap >= 3 && matchGap <= 10 ? 10
                  : matchGap >= 11 && matchGap <= 20 ? 3
                  : matchGap < 3 ? -8 : -4;
      break;
    }
    case "DIGITDIFF": {
      if (barrier === undefined) return null;
      empirical = 1 - (freq50[barrier] ?? 0.1);
      // P(≠ barrier | current last digit) — how likely is the market to avoid this digit next tick?
      markovWin = 1 - markovToTarget(digits, barrier);
      payout    = 1.04;
      // Gap-since-last: longer = colder = safer exclusion
      const diffGap = digitGapSinceLast(digits, barrier);
      signalBonus = diffGap >= 8 ? 8 : diffGap >= 5 ? 3 : diffGap <= 1 ? -8 : -3;
      break;
    }
    case "CALL": {
      let ups = 0;
      for (let i = 1; i < prices.length; i++) if (prices[i] > prices[i - 1]) ups++;
      empirical = ups / Math.max(1, prices.length - 1);
      markovWin = empirical;
      payout    = 1.91;
      // Recency-weighted momentum: recent up moves matter far more than old ones
      signalBonus = Math.round((priceMomentumScore(prices, "CALL") - 0.5) * 30); // ±15 pts
      break;
    }
    case "PUT": {
      let downs = 0;
      for (let i = 1; i < prices.length; i++) if (prices[i] < prices[i - 1]) downs++;
      empirical = downs / Math.max(1, prices.length - 1);
      markovWin = empirical;
      payout    = 1.91;
      signalBonus = Math.round((priceMomentumScore(prices, "PUT") - 0.5) * 30);
      break;
    }
    default: return null;
  }

  // ── Contract-type-specific signal weights ─────────────────────────────────
  let winP: number;
  switch (contractType) {
    case "DIGITOVER":
    case "DIGITUNDER":
      winP = empirical * 0.40 + markovWin * 0.35 + momentum * 0.25;
      break;
    case "DIGITEVEN":
    case "DIGITODD":
      winP = empirical * 0.40 + momentum * 0.35 + markovWin * 0.25;
      break;
    case "DIGITMATCH":
      // Markov-to-target is the most direct predictor: weight it heavily
      winP = markovWin * 0.55 + empirical * 0.30 + momentum * 0.15;
      break;
    case "DIGITDIFF":
      winP = empirical * 0.40 + markovWin * 0.40 + momentum * 0.20;
      break;
    case "CALL":
    case "PUT":
      winP = momentum * 0.50 + empirical * 0.30 + markovWin * 0.20;
      break;
    default:
      winP = empirical * 0.50 + markovWin * 0.25 + momentum * 0.25;
  }

  const theoretical    = theoreticalWinRate(contractType, barrier);
  const edgeNorm       = Math.max(-1, Math.min(1, (winP - theoretical) / 0.15));
  const timingBonus    = (timing - 50) * 0.20;       // ±10 pts
  const stabilityBonus = (stabilityRaw - 0.5) * 10;  // ±5 pts

  const score = Math.min(100, Math.max(0,
    50 + edgeNorm * 50 + timingBonus + stabilityBonus + signalBonus,
  ));

  const ev     = winP * (payout - 1) - (1 - winP);
  const reason = [
    `${(winP * 100).toFixed(1)}% win-p`,
    `timing ${timing.toFixed(0)}/100`,
    `EV ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}%`,
    `stab ${(stabilityRaw * 100).toFixed(0)}%`,
    signalBonus !== 0 ? `sig${signalBonus >= 0 ? "+" : ""}${signalBonus}` : "",
  ].filter(Boolean).join(" · ");

  return { symbol, displayName, contractType, barrier, score, winProbability: winP, payout, reason };
}

/**
 * Green-light entry check — is this the OPTIMAL moment to execute this contract?
 *
 * PrecisionAI v3 enhancements over v2:
 *   OVER/UNDER: streak depth replaces single-tick check.
 *     2+ of last 5 digits in reversal territory (not just 1) = stronger setup.
 *     Unbroken streak ≥ 2 is an alternative green-light path.
 *   EVEN/ODD: unchanged in condition but now uses streakAgainstLength internally.
 *   CALL/PUT:  recency-weighted priceMomentumScore added as second green-light path.
 *   MATCH:     Markov-to-target probability added as alternative to hot-window check.
 *   DIFF:      threshold relaxed to 5 ticks (was 8) — less strict, trades more often.
 */
function isGreenLight(
  digits: number[],
  prices: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
): boolean {
  switch (contractType) {
    case "DIGITOVER": {
      if (barrier === undefined) return true;
      // Reversal pressure: 2+ of last 5 digits at/below barrier, OR unbroken streak ≥ 2, OR momentum
      const last5         = digits.slice(-5);
      const reversalCount = last5.filter(d => d <= barrier).length;
      const streak        = streakAgainstLength(digits, "DIGITOVER", barrier);
      const highMomentum  = momentumRate(digits, "DIGITOVER", barrier, 10) >= 0.65;
      return reversalCount >= 2 || streak >= 2 || highMomentum;
    }
    case "DIGITUNDER": {
      if (barrier === undefined) return true;
      const last5         = digits.slice(-5);
      const reversalCount = last5.filter(d => d >= barrier).length;
      const streak        = streakAgainstLength(digits, "DIGITUNDER", barrier);
      const highMomentum  = momentumRate(digits, "DIGITUNDER", barrier, 10) >= 0.65;
      return reversalCount >= 2 || streak >= 2 || highMomentum;
    }
    case "DIGITEVEN": {
      // Alternation: last digit was ODD (1+ unbroken odd streak) OR strong even freq
      const oddStreak = streakAgainstLength(digits, "DIGITEVEN", undefined);
      const highFreq  = momentumRate(digits, "DIGITEVEN", undefined, 10) >= 0.60;
      return oddStreak >= 1 || highFreq;
    }
    case "DIGITODD": {
      const evenStreak = streakAgainstLength(digits, "DIGITODD", undefined);
      const highFreq   = momentumRate(digits, "DIGITODD", undefined, 10) >= 0.60;
      return evenStreak >= 1 || highFreq;
    }
    case "CALL": {
      if (prices.length < 3) return true;
      const lastUp      = prices[prices.length - 1] > prices[prices.length - 2];
      const last5       = prices.slice(-5);
      let ups = 0;
      for (let i = 1; i < last5.length; i++) if (last5[i] > last5[i - 1]) ups++;
      // Original path: last tick up + 2+ of last 5 up
      // New path: recency-weighted momentum strongly bullish (≥0.65)
      return (lastUp && ups >= 2) || priceMomentumScore(prices, "CALL") >= 0.65;
    }
    case "PUT": {
      if (prices.length < 3) return true;
      const lastDown = prices[prices.length - 1] < prices[prices.length - 2];
      const last5    = prices.slice(-5);
      let downs = 0;
      for (let i = 1; i < last5.length; i++) if (last5[i] < last5[i - 1]) downs++;
      return (lastDown && downs >= 2) || priceMomentumScore(prices, "PUT") >= 0.65;
    }
    case "DIGITMATCH": {
      if (barrier === undefined) return true;
      const gap        = digitGapSinceLast(digits, barrier);
      const markovProb = markovToTarget(digits, barrier);
      // Hot-but-not-just-hit window [3-12] OR strong Markov transition to target
      return (gap >= 3 && gap <= 12) || markovProb > 0.15;
    }
    case "DIGITDIFF": {
      if (barrier === undefined) return true;
      // Digit hasn't appeared in last 5 ticks (cold enough) — relaxed from 8 for more trades
      return digitGapSinceLast(digits, barrier) >= 5;
    }
    default: return true;
  }
}

/**
 * FastRecoveryGate v2 — three-window combined scoring for recovery contracts.
 *
 * Upgrade over v1 (single 60-tick window):
 *  • Fetches 100 ticks and scores each candidate at THREE windows:
 *      30-tick  (very recent snapshot)      — weight 0.25
 *      60-tick  (current-state baseline)    — weight 0.50
 *      100-tick (medium-term confirmation)  — weight 0.25
 *  • Combined score is a weighted average — statistically more robust than a
 *    single window, filters one-window flukes without blocking indefinitely.
 *  • Barrier selection uses the 60-tick window (stable, avoids 30-tick noise).
 *  • Green-light uses the 60-tick window for best recency/stability balance.
 *  • Adaptive threshold unchanged: 52 / 55 / 58 based on consecutive losses.
 *  • Always falls back to best available (adaptive fallback is caller's job).
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

  // Wider buffer for three-window analysis
  const digits100 = tickManager.getDigits(symbol, 100);
  const prices50  = tickManager.getTicks(symbol, 50);
  if (digits100.length < 30) return null;

  const digits60 = digits100.slice(-60);
  const digits30 = digits100.slice(-30);

  const candidates: (MarketScore & { greenLight: boolean })[] = [];

  for (const ct of contractTypes) {
    // Barrier selection on 60-tick window (stable, not noisy like 30-tick)
    let barrier: number | undefined;
    if      (ct === "DIGITOVER")  barrier = overBarrier;
    else if (ct === "DIGITUNDER") barrier = underBarrier;
    else if (ct === "DIGITMATCH") barrier = pickBestMatchBarrier(digits60);
    else if (ct === "DIGITDIFF")  barrier = pickBestDiffBarrier(digits60);

    // Three-window scoring
    const r100 = precisionScore(symbol, displayName, ct, barrier, digits100, prices50);
    const r60  = precisionScore(symbol, displayName, ct, barrier, digits60,  prices50);
    const r30  = precisionScore(symbol, displayName, ct, barrier, digits30,  prices50);
    if (!r60) continue; // 60-tick is the required baseline

    const s100 = r100?.score ?? r60.score;
    const s60  = r60.score;
    const s30  = r30?.score  ?? r60.score;

    // Weighted combined: recent (25%) + baseline (50%) + trend (25%)
    const combinedScore = Math.round((s30 * 0.25 + s60 * 0.50 + s100 * 0.25) * 10) / 10;
    if (combinedScore < minScore) continue;

    // Green-light on the 60-tick window (best balance of recency and stability)
    const gl = isGreenLight(digits60, prices50, ct, barrier);
    candidates.push({
      ...r60,
      score:  combinedScore,
      reason: `${r60.reason} | 3W ${s30.toFixed(0)}/${s60.toFixed(0)}/${s100.toFixed(0)}`,
      greenLight: gl,
    });
  }

  if (candidates.length === 0) return null;

  // Green-light candidates first, then highest combined score
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
 * Uses PrecisionAI v3 three-window scoring (30/60/100 ticks, weights 0.25/0.50/0.25)
 * for the same analysis depth as the recovery gate and single-market scorer.
 * Returns markets sorted by combined score descending.
 */
export async function analyzeMarketsForStrategy(
  contractTypes: SpeedContractType[],
  barriers: number[],
): Promise<MarketScore[]> {
  const scored: MarketScore[] = [];
  const { overBarrier, underBarrier } = extractBarriers(barriers);

  for (const market of DERIV_MARKETS) {
    if (!market.digitEnabled && contractTypes.some(ct => ct.startsWith("DIGIT"))) continue;

    const digits100 = tickManager.getDigits(market.symbol, 100);
    const digits60  = digits100.slice(-60);
    const digits30  = digits100.slice(-30);
    const prices    = tickManager.getTicks(market.symbol, 50);

    for (const ct of contractTypes) {
      let barrier: number | undefined;
      if      (ct === "DIGITOVER")  barrier = overBarrier;
      else if (ct === "DIGITUNDER") barrier = underBarrier;
      else if (ct === "DIGITMATCH" || ct === "DIGITDIFF") {
        if (digits60.length < 30) continue;
        barrier = ct === "DIGITMATCH" ? pickBestMatchBarrier(digits60) : pickBestDiffBarrier(digits60);
      }

      const r100 = precisionScore(market.symbol, market.displayName, ct, barrier, digits100, prices);
      const r60  = precisionScore(market.symbol, market.displayName, ct, barrier, digits60,  prices);
      const r30  = precisionScore(market.symbol, market.displayName, ct, barrier, digits30,  prices);
      if (!r60) continue;

      const combinedScore = Math.round(
        ((r30?.score ?? r60.score) * 0.25 + r60.score * 0.50 + (r100?.score ?? r60.score) * 0.25) * 10,
      ) / 10;
      scored.push({ ...r60, score: combinedScore });
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Score a single locked market across the given contract types and return the best setup.
 * Uses PrecisionAI v3 three-window scoring (30/60/100 ticks) for the same analysis
 * depth as fastRecoveryGate — consistent quality between normal and recovery paths.
 * Barriers are the exact values the user configured for OVER/UNDER.
 */
export async function scoreSingleMarket(
  symbol: string,
  displayName: string,
  contractTypes: SpeedContractType[],
  barriers: number[],
): Promise<MarketScore | null> {
  const digits100 = tickManager.getDigits(symbol, 100);
  const digits60  = digits100.slice(-60);
  const digits30  = digits100.slice(-30);
  const prices    = tickManager.getTicks(symbol, 50);
  const { overBarrier, underBarrier } = extractBarriers(barriers);
  const scored: MarketScore[] = [];

  for (const ct of contractTypes) {
    // Barrier selection on 60-tick window (stable baseline)
    let barrier: number | undefined;
    if      (ct === "DIGITOVER")  barrier = overBarrier;
    else if (ct === "DIGITUNDER") barrier = underBarrier;
    else if (ct === "DIGITMATCH") barrier = pickBestMatchBarrier(digits60);
    else if (ct === "DIGITDIFF")  barrier = pickBestDiffBarrier(digits60);

    const r100 = precisionScore(symbol, displayName, ct, barrier, digits100, prices);
    const r60  = precisionScore(symbol, displayName, ct, barrier, digits60,  prices);
    const r30  = precisionScore(symbol, displayName, ct, barrier, digits30,  prices);
    if (!r60) continue;

    const combinedScore = Math.round(
      ((r30?.score ?? r60.score) * 0.25 + r60.score * 0.50 + (r100?.score ?? r60.score) * 0.25) * 10,
    ) / 10;
    scored.push({ ...r60, score: combinedScore });
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
          for (let gl_retry = 0; gl_retry < 3; gl_retry++) {
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

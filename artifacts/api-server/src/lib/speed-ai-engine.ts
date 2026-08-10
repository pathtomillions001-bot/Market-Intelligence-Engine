/**
 * SpeedAI Engine — 1-tick trading engine  (PrecisionAI v4 — Statistical Quality Gates)
 *
 * v4 philosophy: FEWER trades, STATISTICALLY-DEFENSIBLE trades.
 *
 * Why v4 exists: v2/v3 scored setups from 30–100 ticks and traded anything with
 * score ≥ 50. On synthetic indices (designed as random walks), short-window win
 * rates fluctuate ±5–7% around the theoretical rate purely by sampling noise.
 * The engine was fitting that noise, trading constantly at negative expected
 * value, and its Martingale-style recovery (lower standards + bigger stakes
 * after every loss) converted small variance into guaranteed account ruin.
 *
 * v4 changes:
 *  • Wilson score lower bound replaces the raw empirical win rate — a
 *    conservative estimate that shrinks with small sample sizes.
 *  • One-sided binomial significance test vs the theoretical rate: a setup's
 *    edge only counts if it is statistically significant (p < 0.10).
 *  • Payout break-even gating: every trade must have positive expected value
 *    using the CONSERVATIVE win rate vs the actual payout (1 / payout). This
 *    alone kills the money leaks (e.g. DIFF at 1.04x needs >96% win rate).
 *  • Chi-square digit-uniformity test — refuses to trade a near-uniform
 *    distribution (i.e. "no reliable bias") regardless of what raw counts say.
 *  • Walk-forward validation — the observed edge must persist out-of-sample;
 *    if it doesn't, the setup is rejected (anti-overfitting).
 *  • Markov order-1 support test — the Markov signal is neutralised when
 *    transitions are statistically indistinguishable from independent draws.
 *  • Live EV gate — before every live trade the engine fetches the REAL payout
 *    via the proposal API and re-checks EV; no quote = no trade.
 *  • Recovery safety — recovery trades must pass the SAME quality gates as
 *    normal trades; 2 consecutive recovery losses halt the session; recovery
 *    debt is capped at a fraction of the account balance; the old "adaptive
 *    fallback" that traded with lowered standards is removed.
 *  • Circuit breakers — 4 consecutive losses halts; drawdown from session peak
 *    halts; minimum inter-trade pacing prevents degenerate loops.
 */

import {
  tickManager,
  DERIV_MARKETS,
  executeLiveTrade,
  waitForContractResult,
  getContractProposal,
  getCachedToken,
  getLiveBalance,
} from "./deriv";
import { broadcastSSE } from "./sse";
import { db, accountsTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum score for a normal trade to execute */
const MIN_TRADE_SCORE = 50;

/** Minimum score for recovery — quality gates below dominate this value */
const MIN_RECOVERY_SCORE = 55;

// ── PrecisionAI v4 statistical gates ─────────────────────────────────────────
/** One-sided significance threshold for an edge claim */
const MIN_EDGE_PVALUE = 0.10;
/** Extra win-rate margin required above the payout break-even (EV > 0 cushion) */
const BREAKEVEN_MARGIN = 0.005;
/** Conservative confidence for the Wilson bound (95%) */
const WILSON_Z = 1.96;
/** Minimum digit sample before a digit setup can be scored */
const MIN_DIGIT_SAMPLE = 60;
/** Minimum price sample for CALL/PUT setups */
const MIN_PRICE_SAMPLE = 30;
/** Chi-square p above which the digit distribution counts as "uniform" (no bias) */
const UNIFORM_P_CEILING = 0.25;
/** Consecutive total losses that hard-stop the session */
const MAX_CONSECUTIVE_LOSSES = 4;
/** Consecutive recovery losses that hard-stop the session */
const RECOVERY_HALT_AFTER_LOSSES = 2;
/** Recovery debt cap as a fraction of account balance */
const RECOVERY_DEBT_FRACTION = 0.12;
/** Per-trade stake cap as a fraction of account balance */
const STAKE_FRACTION = 0.02;
/** Session drawdown-from-peak stop as a fraction of account balance */
const MAX_DRAWDOWN_FRACTION = 0.05;
/** Minimum ms between consecutive trades (pacing — prevents degenerate loops) */
const MIN_TRADE_GAP_MS = 1200;

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
  /** PrecisionAI v4 — statistical evidence attached by precisionScore */
  stats?: SetupStats;
}

/** Statistical evidence behind a scored setup (PrecisionAI v4). */
export interface SetupStats {
  /** Relevant sample size (ticks evaluated) */
  sampleN: number;
  /** Hits (win-condition ticks) observed */
  hits: number;
  /** Conservative win rate — Wilson 95% lower bound */
  wilsonWinP: number;
  /** One-sided binomial p-value vs the theoretical rate */
  pValue: number;
  /** Theoretical win rate for this contract+barrier */
  theoretical: number;
  /** Win rate needed for break-even given payout = 1/payout */
  breakeven: number;
  /** Chi-square p-value of digit uniformity (1 = perfectly uniform) */
  uniformityP: number;
  /** Whether the edge survived walk-forward (out-of-sample) validation */
  walkForwardPass: boolean;
  /** Markov order-1 support: mean |P(d|prev) − P(d)| over transitions */
  markovLift: number;
  /** True when the edge is statistically significant AND above break-even */
  significant: boolean;
}

interface RecoveryTradeRecord {
  contractType: SpeedContractType;
  barrier: number | undefined;
  won: boolean;
}

interface SpeedRecoveryState {
  inRecovery: boolean;
  recoveryStep: number;
  unrecoveredAmount: number;
  baseStake: number;
  /** Losses taken while already IN recovery (resets to 0 on any recovery win) */
  consecutiveRecoveryLosses: number;
  /** Last 8 recovery trade outcomes — feeds anti-pattern penalty in fastRecoveryGate */
  recentRecoveryTrades: RecoveryTradeRecord[];
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
  consecutiveLosses: number;
  /** Setups rejected by the PrecisionAI v4 quality gate this session */
  skippedCount: number;
  lastSkipReason?: string;
  peakProfit: number;
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
  consecutiveLosses: number;
  skippedCount: number;
  lastSkipReason?: string;
  peakProfit: number;
  lastTradeAt: number;
  startingBalance: number;
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
  recovery: { inRecovery: false, recoveryStep: 0, unrecoveredAmount: 0, baseStake: 0, consecutiveRecoveryLosses: 0, recentRecoveryTrades: [] },
  consecutiveLosses: 0,
  skippedCount: 0,
  peakProfit: 0,
  lastTradeAt: 0,
  startingBalance: 1000,
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

// ═══════════════════════════════════════════════════════════════════════════
// PrecisionAI v4 — statistical core
//
// The v2/v3 engine estimated "edge" as (observed win rate − theoretical rate)
// over 30–100 ticks. On a random walk that difference is sampling noise, so
// the engine traded noise at negative EV. v4 replaces the raw estimate with
// conservative estimators and hard statistical gates:
//
//   1. wilsonLowerBound()  — Wilson 95% CI lower bound. Small samples can no
//      longer claim large edges; the bound shrinks toward 0.5 as n ↓.
//   2. binomialEdgeP()     — one-sided binomial p-value vs the theoretical
//      rate (continuity-corrected normal approx). The "edge" must be real
//      enough that random chance is unlikely to explain it.
//   3. digitUniformityP()  — chi-square goodness-of-fit vs a uniform digit
//      distribution. A near-uniform market has NO exploitable bias; the
//      engine refuses to trade it regardless of what raw counts suggest.
//   4. markovLift()        — mean |P(d_t | d_{t-1}) − P(d_t)|. If transitions
//      are statistically indistinguishable from independent draws, the Markov
//      signal is noise and is neutralised toward the theoretical rate.
//   5. walkForwardValidated() — fit on the older 60% of the buffer, verify on
//      the newer 40%. If the claimed edge does not persist out-of-sample it is
//      overfit and rejected.
// ═══════════════════════════════════════════════════════════════════════════

/** Abramowitz–Stegun erf approximation (error < 1.5e-7). */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

/** Standard normal CDF. */
function normCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/**
 * Wilson score lower bound — the conservative estimate of a true win rate
 * given `hits / n` observations. Used everywhere a win probability drives a
 * decision (EV gate, recovery stake, paper outcomes) so optimism is bounded.
 */
function wilsonLowerBound(hits: number, n: number, z = WILSON_Z): number {
  if (n <= 0) return 0.5;
  const p = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return Math.max(0, Math.min(1, centre - halfWidth));
}

/**
 * One-sided binomial p-value with continuity correction:
 * P(X ≥ hits | X ~ Bin(n, p0)) — the probability that random chance alone
 * produced at least this many wins if the true rate were `p0`.
 * Small p ⇒ observed rate is unlikely under the theoretical rate ⇒ edge.
 */
function binomialEdgeP(hits: number, n: number, p0: number): number {
  if (n <= 0) return 1;
  const p = hits / n;
  if (p <= p0) return 1; // no edge direction — definitely not significant
  const se = Math.sqrt((p0 * (1 - p0)) / n) || 1e-9;
  const z = (p - p0 - 1 / (2 * n)) / se; // continuity correction
  return Math.max(0, Math.min(1, 1 - normCdf(z)));
}

/**
 * Chi-square goodness-of-fit of the digit distribution vs uniform (df=9),
 * Wilson–Hilferty normal approximation. Returns the p-value:
 *   small p → digits deviate significantly from uniform (potential bias)
 *   large p → near-uniform → no exploitable bias.
 */
function digitUniformityP(digits: number[]): number {
  const n = digits.length;
  if (n < 40) return 1; // too little data — assume uniform (no signal)
  const counts = Array(10).fill(0);
  for (const d of digits) if (d >= 0 && d <= 9) counts[d]++;
  const exp = n / 10;
  let chi2 = 0;
  for (let i = 0; i < 10; i++) chi2 += (counts[i] - exp) ** 2 / exp;
  const df = 9;
  const z = (Math.cbrt(chi2 / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return Math.max(0, Math.min(1, 1 - normCdf(z)));
}

/**
 * Markov order-1 support: mean |P(d_t | d_{t-1}) − P(d_t)| weighted by how
 * often each previous digit occurs. A lift near 0 means transitions carry no
 * information beyond the marginal distribution → the Markov signal is noise.
 */
function markovLift(digits: number[]): number {
  if (digits.length < 60) return 0;
  const freq = digitFrequency(digits);
  const mat = Array.from({ length: 10 }, () => Array(10).fill(0));
  const rowTot = Array(10).fill(0);
  for (let i = 1; i < digits.length; i++) {
    const f = digits[i - 1], t = digits[i];
    if (f >= 0 && f <= 9 && t >= 0 && t <= 9) { mat[f][t]++; rowTot[f]++; }
  }
  let lift = 0, weight = 0;
  for (let f = 0; f < 10; f++) {
    if (rowTot[f] < 5) continue;
    for (let t = 0; t < 10; t++) {
      const p1 = mat[f][t] / rowTot[f];
      lift += (rowTot[f] / digits.length) * Math.abs(p1 - freq[t]);
      weight += rowTot[f] / digits.length;
    }
  }
  return weight > 0 ? lift / weight : 0;
}

/** Count ticks satisfying the bet's win condition (digit or price direction). */
function countHits(
  digits: number[],
  prices: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
): { hits: number; n: number } {
  switch (contractType) {
    case "DIGITOVER": {
      let hits = 0;
      for (const d of digits) if (barrier !== undefined && d > barrier) hits++;
      return { hits, n: digits.length };
    }
    case "DIGITUNDER": {
      let hits = 0;
      for (const d of digits) if (barrier !== undefined && d < barrier) hits++;
      return { hits, n: digits.length };
    }
    case "DIGITEVEN": {
      let hits = 0;
      for (const d of digits) if (d % 2 === 0) hits++;
      return { hits, n: digits.length };
    }
    case "DIGITODD": {
      let hits = 0;
      for (const d of digits) if (d % 2 !== 0) hits++;
      return { hits, n: digits.length };
    }
    case "DIGITMATCH": {
      let hits = 0;
      for (const d of digits) if (barrier !== undefined && d === barrier) hits++;
      return { hits, n: digits.length };
    }
    case "DIGITDIFF": {
      let hits = 0;
      for (const d of digits) if (barrier !== undefined && d !== barrier) hits++;
      return { hits, n: digits.length };
    }
    case "CALL": {
      let hits = 0;
      const n = Math.max(0, prices.length - 1);
      for (let i = 1; i < prices.length; i++) if (prices[i] > prices[i - 1]) hits++;
      return { hits, n };
    }
    case "PUT": {
      let hits = 0;
      const n = Math.max(0, prices.length - 1);
      for (let i = 1; i < prices.length; i++) if (prices[i] < prices[i - 1]) hits++;
      return { hits, n };
    }
    default:
      return { hits: 0, n: 0 };
  }
}

/**
 * Walk-forward validation: does the observed edge persist out-of-sample?
 * The older 60% of the buffer is the "training" half; the newer 40% is the
 * "test" half. The edge is only accepted when the test rate does not fall
 * back to the theoretical rate (or collapse below the training rate by a
 * meaningful margin). This is the primary anti-overfitting filter.
 */
function walkForwardValidated(
  digits: number[],
  prices: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
): { pass: boolean; trainRate: number; testRate: number } {
  const usePrices = contractType === "CALL" || contractType === "PUT";
  const arr = usePrices ? prices : digits;
  if (arr.length < 80) return { pass: true, trainRate: 0.5, testRate: 0.5 }; // not enough data — don't block on this alone

  const split = Math.floor(arr.length * 0.6);
  const trainArr = arr.slice(0, split);
  const testArr = arr.slice(split);
  const train = usePrices
    ? countHits([], trainArr, contractType, barrier)
    : countHits(trainArr, [], contractType, barrier);
  const test = usePrices
    ? countHits([], testArr, contractType, barrier)
    : countHits(testArr, [], contractType, barrier);
  const trainRate = train.n > 0 ? train.hits / train.n : 0.5;
  const testRate = test.n > 0 ? test.hits / test.n : 0.5;
  const p0 = theoreticalWinRate(contractType, barrier);

  const pass = testRate >= p0 - 0.01 || testRate >= trainRate - 0.04;
  return { pass, trainRate, testRate };
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
  if (contractType.startsWith("DIGIT") && digits.length < MIN_DIGIT_SAMPLE) return null;
  if ((contractType === "CALL" || contractType === "PUT") && prices.length < MIN_PRICE_SAMPLE) return null;

  const winLen       = Math.min(80, digits.length);
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

  const theoretical = theoreticalWinRate(contractType, barrier);

  // ── v4: neutralize the Markov signal when transitions carry no information ──
  if (markovLift(digits) < 0.015) markovWin = theoretical;

  // ── v4: statistical evidence for THIS setup ─────────────────────────────────
  const { hits, n } = countHits(digits, prices, contractType, barrier);
  const wilson      = wilsonLowerBound(hits, n);
  const pValue      = binomialEdgeP(hits, n, theoretical);
  const breakeven   = payout > 1 ? 1 / payout : 1;
  const uniformityP = contractType.startsWith("DIGIT") ? digitUniformityP(digits) : 1;
  const wf          = walkForwardValidated(digits, prices, contractType, barrier);
  const significant = pValue < MIN_EDGE_PVALUE && wilson > theoretical && wilson > breakeven + BREAKEVEN_MARGIN;

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

  // ── v4: significance-weighted score ────────────────────────────────────────
  // edgeNorm uses the CONSERVATIVE Wilson bound, scaled by 6% absolute edge.
  // Non-significant edges contribute only 15% of their weight — a setup cannot
  // reach tradeable territory on noise alone.
  const edgeRaw        = wilson - theoretical;
  const edgeNorm       = Math.max(-1, Math.min(1, edgeRaw / 0.06));
  const timingBonus    = (timing - 50) * 0.20;       // ±10 pts
  const stabilityBonus = (stabilityRaw - 0.5) * 10;  // ±5 pts

  let score = 50 + edgeNorm * 50 * (significant ? 1 : 0.15)
            + timingBonus + stabilityBonus + signalBonus;

  // Near-uniform digit distribution → no exploitable bias → strong penalty
  if (uniformityP > UNIFORM_P_CEILING) score -= 8;
  else if (uniformityP < 0.05) score += 4;
  // Edge failed out-of-sample validation → overfit → strong penalty
  if (!wf.pass) score -= 12;

  score = Math.min(100, Math.max(0, score));

  const ev = wilson * (payout - 1) - (1 - wilson);
  const reason = [
    `${(wilson * 100).toFixed(1)}% win-p (n=${n})`,
    significant ? `sig p=${pValue.toFixed(3)}` : `p=${pValue.toFixed(2)}`,
    `EV ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}%`,
    `timing ${timing.toFixed(0)}/100`,
    !wf.pass ? "⨯ OOS" : "",
    signalBonus !== 0 ? `sig${signalBonus >= 0 ? "+" : ""}${signalBonus}` : "",
  ].filter(Boolean).join(" · ");

  return {
    symbol, displayName, contractType, barrier, score,
    winProbability: wilson,
    payout,
    reason,
    stats: {
      sampleN: n,
      hits,
      wilsonWinP: wilson,
      pValue,
      theoretical,
      breakeven,
      uniformityP,
      walkForwardPass: wf.pass,
      markovLift: markovLift(digits),
      significant,
    },
  };
}

/**
 * PrecisionAI v4 — hard quality gate.
 *
 * A setup must clear ALL of these to be tradable:
 *   1. score ≥ MIN_TRADE_SCORE
 *   2. conservative win rate (Wilson 95% LB) above the payout break-even
 *   3. edge statistically significant vs the theoretical rate (p < 0.10)
 *   4. edge survived walk-forward (out-of-sample) validation
 *   5. digit distribution is NOT near-uniform (no bias ⇒ no trade)
 *
 * Returns the list of reasons when rejected, so the session can tell the user
 * exactly why it is holding. This is the "fewer but better trades" gate.
 */
function evaluateSetup(
  setup: MarketScore | null | undefined,
): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!setup) return { pass: false, reasons: ["no setup available"] };

  const s = setup.stats;
  if (!s) { reasons.push("insufficient statistics"); return { pass: false, reasons }; }

  if (setup.score < MIN_TRADE_SCORE) {
    reasons.push(`score ${setup.score.toFixed(0)}/100 below ${MIN_TRADE_SCORE}`);
  }
  if (s.wilsonWinP <= s.breakeven + BREAKEVEN_MARGIN) {
    reasons.push(
      `win-rate ${(s.wilsonWinP * 100).toFixed(1)}% ≤ break-even ${(s.breakeven * 100).toFixed(1)}%`,
    );
  }
  if (!s.significant) {
    reasons.push(`edge not significant (p=${s.pValue.toFixed(3)})`);
  }
  if (!s.walkForwardPass) {
    reasons.push("edge failed out-of-sample validation");
  }
  if (s.uniformityP > UNIFORM_P_CEILING) {
    reasons.push("digit distribution near-uniform — no reliable bias");
  }

  return { pass: reasons.length === 0, reasons };
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
 * FastRecoveryGate v3 — enhanced recovery analysis.
 *
 * Upgrades over v2 (three-window):
 *  • FOUR tick windows: 15t(0.20) + 30t(0.30) + 60t(0.35) + 100t(0.15)
 *    — weights ultra-recent data more aggressively for tighter entry timing.
 *  • deepSignalBonus: contract-type-specific analysis on top of precisionScore
 *    (+20/-15 pts using Z-score/chi-square/gap-quality signals not in v2).
 *  • Anti-pattern penalty: −8 pts per consecutive recovery loss for the same
 *    contract-type+barrier combo — steers away from setups that keep failing
 *    within the current recovery episode.
 *  • MATCH evaluates top-3 barrier candidates (not just 1) so the best
 *    gap+Markov digit is always preferred over a stale single pick.
 *  • Adaptive threshold unchanged: 52 / 55 / 58; deepSignalBonus naturally
 *    elevates genuinely strong setups above baseline.
 */
function fastRecoveryGate(
  symbol: string,
  displayName: string,
  contractTypes: SpeedContractType[],
  barriers: number[],
  consecutiveLosses: number,
  recentRecoveryTrades: RecoveryTradeRecord[],
): { winner: MarketScore; greenLight: boolean } | null {
  // v4: two consecutive recovery losses = the recovery strategy itself is
  // failing. Never keep gambling with rising stakes — the loop halts the
  // session; the gate refuses to pick a setup as a second line of defence.
  if (consecutiveLosses >= RECOVERY_HALT_AFTER_LOSSES) return null;

  const minScore = consecutiveLosses >= 1 ? 58 : MIN_RECOVERY_SCORE;
  const { overBarrier, underBarrier } = extractBarriers(barriers);

  // Four-window buffers
  const digits100 = tickManager.getDigits(symbol, 100);
  const prices50  = tickManager.getTicks(symbol, 50);
  if (digits100.length < MIN_DIGIT_SAMPLE) return null;

  const digits60 = digits100.slice(-60);
  const digits30 = digits100.slice(-30);
  const digits15 = digits100.slice(-15);

  // ── Anti-pattern penalty map ─────────────────────────────────────────────
  // Each consecutive loss for a contract+barrier combo accrues a penalty.
  // More recent losses penalise more; a win resets the combo's penalty.
  const penaltyMap = new Map<string, number>();
  for (let i = recentRecoveryTrades.length - 1; i >= 0; i--) {
    const t   = recentRecoveryTrades[i];
    const key = `${t.contractType}_${t.barrier ?? ""}`;
    if (!t.won) {
      const existing   = penaltyMap.get(key) ?? 0;
      const agePenalty = Math.max(0, 8 - (recentRecoveryTrades.length - 1 - i) * 2);
      penaltyMap.set(key, Math.max(existing, agePenalty));
    } else {
      penaltyMap.delete(key); // win resets penalty for this combo
    }
  }

  // ── Expand contract types: MATCH gets top-3 barrier candidates ───────────
  const expandedEntries: Array<{ ct: SpeedContractType; barrier: number | undefined }> = [];
  for (const ct of contractTypes) {
    if      (ct === "DIGITOVER")  { expandedEntries.push({ ct, barrier: overBarrier }); }
    else if (ct === "DIGITUNDER") { expandedEntries.push({ ct, barrier: underBarrier }); }
    else if (ct === "DIGITMATCH") {
      for (const b of pickTopMatchBarriers(digits60, 3)) {
        expandedEntries.push({ ct, barrier: b });
      }
    }
    else if (ct === "DIGITDIFF")  { expandedEntries.push({ ct, barrier: pickBestDiffBarrier(digits60) }); }
    else                          { expandedEntries.push({ ct, barrier: undefined }); }
  }

  const candidates: (MarketScore & { greenLight: boolean })[] = [];

  for (const { ct, barrier } of expandedEntries) {
    // Four-window scoring — 15-tick is the immediate snapshot
    const r100 = precisionScore(symbol, displayName, ct, barrier, digits100, prices50);
    const r60  = precisionScore(symbol, displayName, ct, barrier, digits60,  prices50);
    const r30  = precisionScore(symbol, displayName, ct, barrier, digits30,  prices50);
    const r15  = digits15.length >= 15
      ? precisionScore(symbol, displayName, ct, barrier, digits15, prices50)
      : null;
    if (!r60) continue;

    const s100 = r100?.score ?? r60.score;
    const s60  = r60.score;
    const s30  = r30?.score  ?? r60.score;
    const s15  = r15?.score  ?? s30;

    // 4-window weights: immediate(0.20) + short(0.30) + baseline(0.35) + trend(0.15)
    const baseScore = Math.round((s15 * 0.20 + s30 * 0.30 + s60 * 0.35 + s100 * 0.15) * 10) / 10;

    // Deep contract-type-specific bonus
    const dBonus  = deepSignalBonus(ct, barrier, digits60, prices50);

    // Anti-pattern penalty for this exact combo
    const penalty = penaltyMap.get(`${ct}_${barrier ?? ""}`) ?? 0;

    const adjustedScore = baseScore + dBonus - penalty;
    if (adjustedScore < minScore) continue;

    // v4: recovery trades must clear the SAME statistical bar as normal trades.
    // Rising stakes after a loss demand MORE evidence, never less.
    const st = (r60 as MarketScore).stats;
    if (!st) continue;
    if (!st.significant || st.wilsonWinP <= st.breakeven + BREAKEVEN_MARGIN) continue;
    if (!st.walkForwardPass) continue;
    if (st.uniformityP > UNIFORM_P_CEILING) continue;

    const gl = isGreenLight(digits60, prices50, ct, barrier);
    candidates.push({
      ...r60,
      barrier,
      score:  adjustedScore,
      reason: `${r60.reason} | 4W ${s15.toFixed(0)}/${s30.toFixed(0)}/${s60.toFixed(0)}/${s100.toFixed(0)} d${dBonus >= 0 ? "+" : ""}${dBonus}${penalty > 0 ? ` p-${penalty}` : ""}`,
      greenLight: gl,
    });
  }

  if (candidates.length === 0) return null;

  // Green-light candidates first, then highest adjusted score
  candidates.sort((a, b) => {
    if (a.greenLight !== b.greenLight) return a.greenLight ? -1 : 1;
    return b.score - a.score;
  });

  const best = candidates[0]!;
  return { winner: best, greenLight: best.greenLight };
}

/**
 * Polls for a green-light entry condition on a tight tick interval instead of
 * sleeping a flat 600 ms. Returns true as soon as the condition is satisfied,
 * or false after maxWaitMs elapses (the caller must then execute anyway — never
 * block recovery indefinitely on timing).
 */
async function waitForGreenLight(
  symbol: string,
  contractType: SpeedContractType,
  barrier: number | undefined,
  maxWaitMs = 1500,
  pollMs    = 80,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (!session.running || session.stopRequested) return false;
    const d = tickManager.getDigits(symbol, 60);
    const p = tickManager.getTicks(symbol, 50);
    if (isGreenLight(d, p, contractType, barrier)) return true;
    await sleep(pollMs);
  }
  return false;
}

// ── Recovery analysis helpers (v3) ───────────────────────────────────────────

/**
 * Returns the top N best MATCH barrier candidates sorted by combined
 * Markov-transition + 30-tick frequency + gap-quality score.
 * Used in the enhanced recovery gate to evaluate multiple digit targets
 * rather than committing to a single barrier that could keep losing.
 */
function pickTopMatchBarriers(digits: number[], topN = 3): number[] {
  if (digits.length < 15) return [pickBestMatchBarrier(digits)];
  const markov = markovNextProb(digits);
  const freq30 = digitFrequency(digits.slice(-30));
  const scored = markov.map((m, i) => {
    const gap  = digitGapSinceLast(digits, i);
    const gapQ = gap >= 4 && gap <= 9  ? 0.15
               : gap >= 3 && gap <= 11 ? 0.08
               : gap < 3               ? -0.12
               : -0.03;
    return { digit: i, score: m * 0.50 + (freq30[i] ?? 0) * 0.30 + gapQ };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(s => s.digit);
}

/**
 * Deep signal bonus for recovery-gate analysis — contract-type-specific signals
 * NOT already present in precisionScore, adding up to +20 / down to -15 pts.
 *
 *   OVER:   Running-digit Z-score (negative = low bias = OVER edge)
 *           + 20-tick rate-above-barrier confirmation
 *   UNDER:  Running-digit Z-score (positive = high bias = UNDER edge)
 *           + 20-tick rate-below-barrier confirmation
 *   EVEN:   40-tick odd-rate bias + chi-square parity significance test
 *   ODD:    40-tick even-rate bias + chi-square parity significance test
 *   MATCH:  Tighter gap sweet-spot (4-9 ticks = +12) + 30-tick freq check
 *   DIFF:   Stricter cold-gap bonus (≥10 ticks = +15) + 30-tick low-freq check
 *   CALL/PUT: Volatility penalty (high vol = unpredictable) + momentum bonus
 */
function deepSignalBonus(
  contractType: SpeedContractType,
  barrier: number | undefined,
  digits: number[],
  prices: number[],
): number {
  switch (contractType) {

    case "DIGITOVER": {
      if (barrier === undefined) return 0;
      const n  = Math.min(50, digits.length);
      const d  = digits.slice(-n);
      if (d.length < 10) return 0;
      const mean     = d.reduce((a, b) => a + b, 0) / d.length;
      const variance = d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length;
      const z = (mean - 4.5) / (Math.sqrt(variance / d.length) || 0.1);
      // Negative Z = digits running low = OVER edge is stronger
      const zB = z < -2.0 ? 12 : z < -1.5 ? 8 : z < -1.0 ? 4 : z > 1.5 ? -10 : z > 1.0 ? -5 : 0;
      const d20 = digits.slice(-20);
      const aboveRate = d20.length > 0 ? d20.filter(v => v > barrier).length / d20.length : 0;
      const fB = aboveRate >= 0.65 ? 5 : aboveRate >= 0.55 ? 2 : aboveRate <= 0.25 ? -6 : 0;
      return Math.max(-15, Math.min(20, zB + fB));
    }

    case "DIGITUNDER": {
      if (barrier === undefined) return 0;
      const n  = Math.min(50, digits.length);
      const d  = digits.slice(-n);
      if (d.length < 10) return 0;
      const mean     = d.reduce((a, b) => a + b, 0) / d.length;
      const variance = d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length;
      const z = (mean - 4.5) / (Math.sqrt(variance / d.length) || 0.1);
      // Positive Z = digits running high = UNDER edge is stronger
      const zB = z > 2.0 ? 12 : z > 1.5 ? 8 : z > 1.0 ? 4 : z < -1.5 ? -10 : z < -1.0 ? -5 : 0;
      const d20 = digits.slice(-20);
      const belowRate = d20.length > 0 ? d20.filter(v => v < barrier).length / d20.length : 0;
      const fB = belowRate >= 0.65 ? 5 : belowRate >= 0.55 ? 2 : belowRate <= 0.25 ? -6 : 0;
      return Math.max(-15, Math.min(20, zB + fB));
    }

    case "DIGITEVEN": {
      const n = Math.min(40, digits.length);
      const d = digits.slice(-n);
      if (d.length < 10) return 0;
      const evenCnt = d.filter(v => v % 2 === 0).length;
      const oddRate = (d.length - evenCnt) / d.length;
      // High odd rate = EVEN is due
      const bB = oddRate >= 0.65 ? 15 : oddRate >= 0.58 ? 8 : oddRate >= 0.52 ? 3
               : oddRate <= 0.35 ? -10 : oddRate <= 0.42 ? -5 : 0;
      // Chi-square test: significant odd bias confirms EVEN signal (df=1, α=0.05 → χ²=3.84)
      const exp  = d.length / 2;
      const chi2 = (evenCnt - exp) ** 2 / exp + ((d.length - evenCnt) - exp) ** 2 / exp;
      const cB = chi2 > 3.84 && evenCnt < exp ? 5 : chi2 > 3.84 && evenCnt > exp ? -5 : 0;
      return Math.max(-15, Math.min(20, bB + cB));
    }

    case "DIGITODD": {
      const n = Math.min(40, digits.length);
      const d = digits.slice(-n);
      if (d.length < 10) return 0;
      const evenCnt = d.filter(v => v % 2 === 0).length;
      const evenRate = evenCnt / d.length;
      // High even rate = ODD is due
      const bB = evenRate >= 0.65 ? 15 : evenRate >= 0.58 ? 8 : evenRate >= 0.52 ? 3
               : evenRate <= 0.35 ? -10 : evenRate <= 0.42 ? -5 : 0;
      const exp  = d.length / 2;
      const chi2 = (evenCnt - exp) ** 2 / exp + ((d.length - evenCnt) - exp) ** 2 / exp;
      const cB = chi2 > 3.84 && evenCnt > exp ? 5 : chi2 > 3.84 && evenCnt < exp ? -5 : 0;
      return Math.max(-15, Math.min(20, bB + cB));
    }

    case "DIGITMATCH": {
      if (barrier === undefined) return 0;
      const gap = digitGapSinceLast(digits, barrier);
      // Tighter sweet-spot than precisionScore's 3-10: 4-9 is optimal
      const gB = gap >= 4 && gap <= 9 ? 12 : gap >= 3 && gap <= 11 ? 6 : gap < 3 ? -12 : gap <= 14 ? 2 : -5;
      const d30  = digits.slice(-30);
      const freq = d30.length > 0 ? d30.filter(v => v === barrier).length / d30.length : 0;
      // Expected ~10%; bonus if near-expected and not just hit
      const fB = freq >= 0.07 && freq <= 0.18 ? 5 : freq > 0.25 ? -8 : freq < 0.02 ? -4 : 0;
      return Math.max(-15, Math.min(20, gB + fB));
    }

    case "DIGITDIFF": {
      if (barrier === undefined) return 0;
      const gap = digitGapSinceLast(digits, barrier);
      // Stricter cold threshold: ≥10 ticks cold is very safe for DIFF
      const gB = gap >= 10 ? 15 : gap >= 7 ? 8 : gap >= 5 ? 3 : gap <= 2 ? -12 : -3;
      const d30  = digits.slice(-30);
      const freq = d30.length > 0 ? d30.filter(v => v === barrier).length / d30.length : 0;
      const fB = freq <= 0.04 ? 8 : freq <= 0.08 ? 3 : freq >= 0.20 ? -10 : 0;
      return Math.max(-15, Math.min(20, gB + fB));
    }

    case "CALL":
    case "PUT": {
      if (prices.length < 10) return 0;
      const p10 = prices.slice(-10);
      const changes: number[] = [];
      for (let i = 1; i < p10.length; i++) {
        const base = Math.abs(p10[i - 1]) || 1;
        changes.push(Math.abs(p10[i] - p10[i - 1]) / base);
      }
      const avgVol = changes.reduce((a, b) => a + b, 0) / Math.max(1, changes.length);
      // High volatility = unpredictable direction for 1-tick CALL/PUT
      const vP = avgVol > 0.002 ? -10 : avgVol > 0.001 ? -4 : 0;
      const mScore = priceMomentumScore(prices, contractType, 12);
      const mB = mScore >= 0.75 ? 12 : mScore >= 0.65 ? 6 : mScore <= 0.35 ? -8 : 0;
      return Math.max(-15, Math.min(20, vP + mB));
    }

    default: return 0;
  }
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

  // v4: "suitable" now means the best market clears the SAME statistical
  // quality gates the running session enforces — score alone is no longer
  // enough. A market can rank #1 but still be untradeable (insignificant
  // edge / negative EV), and the scan says so honestly.
  const best     = allScored[0];
  const verdict  = evaluateSetup(best);
  const suitable = verdict.pass;
  const reason   = suitable
    ? `${best.displayName} has a statistically supported edge (score ${best.score.toFixed(0)}/100) for your settings`
    : `No market cleared the quality gate — best was ${best.displayName} at ${best.score.toFixed(0)}/100 (${verdict.reasons[0] ?? "low quality"})`;

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
  tradeContractType?: SpeedContractType,
  tradeBarrier?: number,
): SpeedRecoveryState {
  // Track trades placed while already in recovery (tradeContractType is only
  // passed from the loop when inRecovery was true at execution time).
  let recentTrades = rec.recentRecoveryTrades;
  if (tradeContractType) {
    const record: RecoveryTradeRecord = { contractType: tradeContractType, barrier: tradeBarrier, won };
    recentTrades = [...recentTrades, record].slice(-8); // keep last 8
  }

  if (won) {
    if (rec.inRecovery) {
      const remaining = rec.unrecoveredAmount - Math.max(0, profit);
      if (remaining <= 0.005) {
        // Debt fully cleared — reset recovery state and history for next episode
        return { inRecovery: false, recoveryStep: 0, unrecoveredAmount: 0, baseStake: rec.baseStake, consecutiveRecoveryLosses: 0, recentRecoveryTrades: [] };
      }
      return { ...rec, unrecoveredAmount: remaining, consecutiveRecoveryLosses: 0, recentRecoveryTrades: recentTrades };
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
      recentRecoveryTrades: recentTrades,
    };
  }
  return {
    ...rec,
    recoveryStep: Math.min(rec.recoveryStep + 1, Math.max(1, maxSteps)),
    unrecoveredAmount: rec.unrecoveredAmount + stake,
    consecutiveRecoveryLosses: rec.consecutiveRecoveryLosses + 1,
    recentRecoveryTrades: recentTrades,
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
    consecutiveLosses:         session.consecutiveLosses,
    skippedCount:              session.skippedCount,
    lastSkipReason:            session.lastSkipReason,
    peakProfit:                Math.round(session.peakProfit * 100) / 100,
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
    recovery: { inRecovery: false, recoveryStep: 0, unrecoveredAmount: 0, baseStake: config.stake, consecutiveRecoveryLosses: 0, recentRecoveryTrades: [] },
    consecutiveLosses: 0,
    skippedCount: 0,
    peakProfit: 0,
    lastTradeAt: 0,
    startingBalance: 1000,
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

  // ── v4: account-aware risk envelope ──────────────────────────────────────
  // Every risk limit is derived from the actual account balance so a losing
  // session can never scale into ruin:
  //   per-trade stake   ≤ balance × STAKE_FRACTION        (2%)
  //   recovery debt     ≤ balance × RECOVERY_DEBT_FRACTION (12%)
  //   session drawdown  ≤ balance × MAX_DRAWDOWN_FRACTION  (5% from peak)
  let startingBalance = 1000;
  if (isLive) {
    const bal = await getLiveBalance(token!);
    if (bal !== null && bal > 0) startingBalance = bal;
  }
  session.startingBalance = startingBalance;
  const balance        = startingBalance;
  const maxStake       = Math.min(
    settings.length > 0 ? Number(settings[0].maxTradeStake) : 500,
    balance * STAKE_FRACTION,
  );
  const recoveryDebtCap = Math.max(20, balance * RECOVERY_DEBT_FRACTION);
  const maxDrawdown     = Math.max(10, Math.min(Math.abs(config.stopLoss) * 0.5, balance * MAX_DRAWDOWN_FRACTION));

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

    // ── PrecisionAI v4 quality gate (normal trades) ─────────────────────────
    // Only statistically-defensible setups execute. Everything else is skipped
    // with the reason surfaced to the UI — this is the "fewer but better".
    if (!inRecovery) {
      const verdict = evaluateSetup(best);
      if (!verdict.pass) {
        session.skippedCount++;
        session.lastSkipReason = verdict.reasons[0] ?? "low quality";
        session.message = `⏳ Holding — ${best.displayName} ${best.contractType} skipped (${session.lastSkipReason})`;
        broadcast();
        preAnalyzedScored = null;
        await sleep(1200);
        continue;
      }
    }

    // ── Gate: recovery (fast, bounded) vs normal (lightweight) ────────────────
    if (inRecovery) {
      // ── v4: hard safety halts BEFORE any recovery attempt ──────────────────
      // Recovery that keeps losing is a broken strategy — stop, don't gamble.
      if (session.recovery.consecutiveRecoveryLosses >= RECOVERY_HALT_AFTER_LOSSES) {
        session.running = false;
        session.message = `🛑 Recovery lost ${RECOVERY_HALT_AFTER_LOSSES}× consecutively — session halted to protect capital`;
        broadcast();
        logger.warn({ consLosses: session.recovery.consecutiveRecoveryLosses }, "SpeedAI recovery halted by consecutive-loss breaker");
        return;
      }
      if (session.recovery.unrecoveredAmount > recoveryDebtCap) {
        session.running = false;
        session.message = `🛑 Recovery debt $${session.recovery.unrecoveredAmount.toFixed(2)} exceeded cap $${recoveryDebtCap.toFixed(2)} — session halted to protect capital`;
        broadcast();
        logger.warn({ unrecoveredAmount: session.recovery.unrecoveredAmount, cap: recoveryDebtCap }, "SpeedAI recovery halted by debt cap");
        return;
      }

      // ── FastRecoveryGate: max 3 attempts — candidate must pass the same
      //    statistical quality gates as normal trades ───────────────────────
      const consLosses  = session.recovery.consecutiveRecoveryLosses;
      const maxAttempts = 3;
      let candidate: { winner: MarketScore; greenLight: boolean } | null = null;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        candidate = fastRecoveryGate(
          best.symbol, best.displayName,
          config.recoveryContractTypes, barriers, consLosses,
          session.recovery.recentRecoveryTrades,
        );
        if (candidate) break;

        session.message = `⏳ Waiting for statistically-valid recovery setup${consLosses > 0 ? ` (${consLosses} loss streak)` : ""}…`;
        broadcast();
        preAnalyzedScored = null;
        await sleep(700);
        if (!session.running || session.stopRequested) break;
      }

      // v4: NO adaptive fallback. If no recovery setup cleared the quality
      // gates, wait — never trade with lowered standards at higher stakes.
      if (!candidate) {
        session.message = "⏳ No recovery setup passed quality gates — waiting…";
        broadcast();
        preAnalyzedScored = null;
        await sleep(1000);
        continue;
      }

      // Green-light check: poll on actual tick events (80 ms intervals, max 1.5 s)
      // instead of a flat 600 ms sleep — exits the moment the condition is met.
      if (!candidate.greenLight) {
        const glAchieved = await waitForGreenLight(
          best.symbol, candidate.winner.contractType, candidate.winner.barrier, 1500, 80,
        );
        if (!session.running || session.stopRequested) break;
        // If green-light was achieved, re-run the full gate for freshest scores;
        // if timeout, keep current candidate and execute anyway — never block indefinitely.
        if (glAchieved) {
          const refreshed = fastRecoveryGate(
            best.symbol, best.displayName,
            config.recoveryContractTypes, barriers, consLosses,
            session.recovery.recentRecoveryTrades,
          );
          if (refreshed) candidate = refreshed;
        }
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
        stats:          candidate.winner.stats,
      };

      // ── v4: final gate check on the recovery candidate ─────────────────────
      const recVerdict = evaluateSetup(best);
      if (!recVerdict.pass) {
        session.skippedCount++;
        session.lastSkipReason = recVerdict.reasons[0] ?? "low quality";
        session.message = `⏳ Holding — recovery setup skipped (${session.lastSkipReason})`;
        broadcast();
        preAnalyzedScored = null;
        await sleep(1200);
        continue;
      }

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

    // ── v4: pacing — never fire trades back-to-back faster than the market ──
    //    can produce fresh information.
    {
      const nowMs = Date.now();
      if (session.lastTradeAt > 0 && nowMs - session.lastTradeAt < MIN_TRADE_GAP_MS) {
        await sleep(MIN_TRADE_GAP_MS - (nowMs - session.lastTradeAt));
      }
    }

    // ── v4: LIVE EV gate — verify the REAL payout before risking money ───────
    // The hardcoded payout tables are stale approximations. In live mode we
    // fetch the actual payout Deriv is offering right now and only proceed if
    // the conservative win rate still clears break-even. No quote = no trade.
    if (isLive) {
      const prop = await getContractProposal(token, {
        symbol:       best.symbol,
        contractType: best.contractType,
        stake:        Math.max(config.stake, 0.35),
        duration:     1,
        durationUnit: "t",
        currency,
        barrier:      best.barrier,
      });
      if (!prop || !(prop.payoutMultiplier > 1)) {
        session.skippedCount++;
        session.lastSkipReason = "payout quote unavailable";
        session.message = `⏳ No payout quote for ${best.displayName} — holding`;
        broadcast();
        preAnalyzedScored = null;
        await sleep(1500);
        continue;
      }
      const liveMult     = prop.payoutMultiplier > 1 ? prop.payoutMultiplier : best.payout;
      const liveBreakeven = 1 / liveMult;
      const wilson       = best.stats?.wilsonWinP ?? best.winProbability;
      if (wilson <= liveBreakeven + BREAKEVEN_MARGIN) {
        session.skippedCount++;
        session.lastSkipReason = `live payout ${liveMult.toFixed(3)}x can't cover ${(wilson * 100).toFixed(1)}% win-rate`;
        session.message = `⏳ ${best.displayName}: live payout ${liveMult.toFixed(3)}x is negative-EV at ${(wilson * 100).toFixed(1)}% win-rate — holding`;
        broadcast();
        preAnalyzedScored = null;
        await sleep(1500);
        continue;
      }
      best = { ...best, payout: liveMult };
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

    session.recovery = recordRecoveryOutcome(
      session.recovery, won, profit, stake, config.maxRecoverySteps,
      inRecovery ? best.contractType : undefined,
      inRecovery ? best.barrier      : undefined,
    );

    // ── v4: session risk tracking ─────────────────────────────────────────────
    session.consecutiveLosses = won ? 0 : session.consecutiveLosses + 1;
    session.peakProfit        = Math.max(session.peakProfit, session.totalProfit);
    session.lastTradeAt       = Date.now();

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

    // ── v4: circuit breakers — the session refuses to keep losing ─────────────
    if (session.consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
      session.running = false;
      session.message = `🛑 ${MAX_CONSECUTIVE_LOSSES} consecutive losses — session halted to protect capital`;
      broadcast();
      logger.warn({ consecutiveLosses: session.consecutiveLosses }, "SpeedAI consecutive-loss breaker triggered");
      return;
    }
    if (session.peakProfit - session.totalProfit > maxDrawdown) {
      session.running = false;
      session.message = `🛑 Drawdown from peak exceeded $${maxDrawdown.toFixed(2)} — session halted to protect capital`;
      broadcast();
      logger.warn({ peakProfit: session.peakProfit, totalProfit: session.totalProfit, maxDrawdown }, "SpeedAI drawdown breaker triggered");
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

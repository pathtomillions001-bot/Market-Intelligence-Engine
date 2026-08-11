/**
 * NeuroAI FAB Engine (SpeedAI Engine v4 — Institutional Quantum Edition)
 *
 * Ultra-fast 1-tick algorithmic trading engine with:
 *  1. Contract Analysis Profiles & Barrier-Aware Precision Scoring
 *  2. 2nd-Order Bayesian Markov Tensor Transitions with Laplace Dirichlet prior
 *  3. Geometric Run-Length Hazard Rate & Fatigue Inflection Point Detection
 *  4. Shannon Information Entropy (H(X)) Noise Gating & Structural Clustering
 *  5. Micro-Tick Kinematics & Discrete Lag-1 Autocorrelation (ρ₁)
 *  6. Net Expected Value (+EV) Micro-Gating with Full Submission Re-Validation
 *  7. Sniper Recovery Protocol with Per-Attempt Fresh Analysis & Loser Rotation
 *  8. Multi-Loss Anti-Pattern Memory & Exponential Decay Penalisers
 *  9. Strict User Contract Sovereignty (Zero deviation from user contract family)
 * 10. Explicit User Market Mode: Locked Single Asset vs Smart Strategy Switching
 */

import {
  tickManager,
  DERIV_MARKETS,
  executeLiveTrade,
  waitForContractResult,
  getCachedToken,
  getLiveBalance,
  type TickEvent,
} from "./deriv";
import { broadcastSSE } from "./sse";
import { db, accountsTable, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import {
  OVER_PAYOUTS,
  UNDER_PAYOUTS,
  EVEN_ODD_PAYOUT,
  RISE_FALL_PAYOUT,
  MATCH_PAYOUT,
  DIFF_PAYOUT,
} from "./payouts";
import { resolveRecoveryPayout } from "./recovery-payout";
import { applyRecoveryStakeLimits, calculateRecoveryStakeRequest } from "./recovery-math";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum score (0–100) for a market to be deemed "suitable" during initial scan */
const SUITABLE_SCORE_THRESHOLD = 54;

/** Minimum score for a normal trade to execute */
const MIN_TRADE_SCORE = 50;

/** Minimum EV for normal trade execution (+1.5% edge) */
const MIN_NORMAL_EV = 0.015;

/** Maximum entropy threshold (bits): above this is pure white noise */
const ENTROPY_WHITE_NOISE_LIMIT = 3.275;

// ── Types ─────────────────────────────────────────────────────────────────────

export type SpeedContractType =
  | "DIGITOVER" | "DIGITUNDER"
  | "DIGITEVEN" | "DIGITODD"
  | "DIGITMATCH" | "DIGITDIFF"
  | "CALL" | "PUT";

export interface SpeedAIConfig {
  normalContractTypes: SpeedContractType[];
  normalBarriers: number[];       // For OVER/UNDER — e.g. [1,2] for OVER, [7,8] for UNDER
  recoveryContractTypes: SpeedContractType[];
  recoveryBarriers: number[];     // For OVER/UNDER recovery
  stake: number;
  stopLoss: number;
  takeProfit: number;
  recoveryAutoMode: boolean;
  recoveryMultiplier: number;
  recoveryMethod: "split" | "instant";
  maxRecoverySteps: number;
  /** When set, the loop trades ONLY this symbol — no per-trade market re-scanning */
  lockedSymbol?: string;
  marketMode?: "locked" | "switching";
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
  normalScore?: number;
  recoveryScore?: number;
  recoveryContractType?: SpeedContractType;
  recoveryBarrier?: number;
  winProbability: number;
  payout: number;
  expectedValue: number;
  entropyBits: number;
  isStructured: boolean;
  reason: string;
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
  targetProfit: number;
  remainingTargetProfit: number;
  originPayoutMultiplier: number;
  consecutiveRecoveryLosses: number;
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
  recoveryTargetProfit: number;
  recoveryRemainingTargetProfit: number;
  recoveryOriginPayout: number;
  consecutiveRecoveryLosses: number;
  currentMarket?: string;
  currentContractType?: string;
  lastResult?: "won" | "lost";
  config?: SpeedAIConfig;
  message?: string;
  topMarkets?: MarketScore[];
  entropyBits?: number;
  expectedValue?: number;
}

export type ContractProfileTier = "RARE_EVENT" | "LOW_PROB" | "MID_PROB" | "HIGH_PROB";

export interface ContractProfile {
  profile: ContractProfileTier;
  theoretical: number;
  minWindowShort: number; // shortest allowed scoring window in ticks
  edgeDenominator: number; // for (winP - theoretical) / edgeDenominator
  requiredScore: number;
  requiredEv: number;
  markovWeight: number;
  empiricalWeight: number;
  momentumWeight: number;
  timingWeight: number;
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
  lastEntropyBits: number;
  lastEv: number;
} = {
  running: false,
  sessionId: null,
  config: null,
  totalProfit: 0,
  tradeCount: 0,
  winCount: 0,
  lossCount: 0,
  currentStake: 0,
  recovery: {
    inRecovery: false,
    recoveryStep: 0,
    unrecoveredAmount: 0,
    baseStake: 0,
    targetProfit: 0,
    remainingTargetProfit: 0,
    originPayoutMultiplier: 1,
    consecutiveRecoveryLosses: 0,
    recentRecoveryTrades: [],
  },
  topMarkets: [],
  stopRequested: false,
  lastEntropyBits: 3.32,
  lastEv: 0,
};

// ── Fresh Ticks Tracker ───────────────────────────────────────────────────────

const totalDigitsReceived = new Map<string, number>();
const totalPricesReceived = new Map<string, number>();

tickManager.on("tick", (e: TickEvent) => {
  totalPricesReceived.set(e.symbol, (totalPricesReceived.get(e.symbol) ?? 0) + 1);
  if (e.lastDigit >= 0) {
    totalDigitsReceived.set(e.symbol, (totalDigitsReceived.get(e.symbol) ?? 0) + 1);
  }
});

const lastTradeClosedDigitCount = new Map<string, number>();
const lastTradeClosedPriceCount = new Map<string, number>();
let lastTradeClosedAt = 0;

async function waitForFreshBuffer(symbol: string, isDigitContract: boolean): Promise<boolean> {
  const targetFresh = isDigitContract ? 40 : 20;
  const startDigits = lastTradeClosedDigitCount.get(symbol) ?? 0;
  const startPrices = lastTradeClosedPriceCount.get(symbol) ?? 0;

  while (session.running && !session.stopRequested) {
    const currentDigits = totalDigitsReceived.get(symbol) ?? 0;
    const currentPrices = totalPricesReceived.get(symbol) ?? 0;
    const freshCount = isDigitContract
      ? (currentDigits - startDigits)
      : (currentPrices - startPrices);

    if (freshCount >= targetFresh) {
      return true;
    }

    session.message = "Analysing fresh window…";
    broadcast();
    await sleep(250);
  }
  return false;
}

// ── Contract Analysis Profiles ────────────────────────────────────────────────

export function getContractProfile(
  contractType: SpeedContractType,
  barrier?: number,
): ContractProfile {
  const theoretical = theoreticalWinRate(contractType, barrier);

  if (theoretical <= 0.20) {
    // RARE_EVENT: theoretical <= 0.20 (MATCH, OVER 7-8, UNDER 1-2)
    return {
      profile: "RARE_EVENT",
      theoretical,
      minWindowShort: 50,
      edgeDenominator: 0.08,
      requiredScore: 64,
      requiredEv: 0.045,
      markovWeight: 0.50,
      empiricalWeight: 0.20,
      momentumWeight: 0.10,
      timingWeight: 0.20,
    };
  } else if (theoretical <= 0.40) {
    // LOW_PROB: 0.20 < theoretical <= 0.40 (OVER 5-6, UNDER 3-4)
    return {
      profile: "LOW_PROB",
      theoretical,
      minWindowShort: 25,
      edgeDenominator: 0.12,
      requiredScore: 62,
      requiredEv: 0.030,
      markovWeight: 0.40,
      empiricalWeight: 0.30,
      momentumWeight: 0.15,
      timingWeight: 0.15,
    };
  } else if (theoretical < 0.70) {
    // MID_PROB: 0.40 < theoretical < 0.70 (OVER 3-4, UNDER 5-6, EVEN, ODD, CALL, PUT)
    return {
      profile: "MID_PROB",
      theoretical,
      minWindowShort: 15,
      edgeDenominator: 0.15,
      requiredScore: 60,
      requiredEv: 0.020,
      markovWeight: 0.35,
      empiricalWeight: 0.30,
      momentumWeight: 0.20,
      timingWeight: 0.15,
    };
  } else {
    // HIGH_PROB: theoretical >= 0.70 (OVER 1-2, UNDER 7-8, DIGITDIFF)
    return {
      profile: "HIGH_PROB",
      theoretical,
      minWindowShort: 15,
      edgeDenominator: 0.12,
      requiredScore: 60,
      requiredEv: 0.018,
      markovWeight: 0.20,
      empiricalWeight: 0.25,
      momentumWeight: 0.20,
      timingWeight: 0.35,
    };
  }
}

// ── Mathematical & Statistical Subsystems ─────────────────────────────────────

function digitFrequency(digits: number[]): number[] {
  const counts = Array(10).fill(0);
  for (const d of digits) if (d >= 0 && d <= 9) counts[d]++;
  const n = digits.length || 1;
  return counts.map(c => c / n);
}

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

function markov2ndOrderNextProb(digits: number[]): { probs: number[]; sampleCount: number } {
  if (digits.length < 3) return { probs: Array(10).fill(0.1), sampleCount: 0 };
  const prev1 = digits[digits.length - 2];
  const prev2 = digits[digits.length - 1];
  if (prev1 < 0 || prev1 > 9 || prev2 < 0 || prev2 > 9) {
    return { probs: Array(10).fill(0.1), sampleCount: 0 };
  }

  const counts = Array(10).fill(0);
  let total = 0;
  for (let i = 2; i < digits.length; i++) {
    if (digits[i - 2] === prev1 && digits[i - 1] === prev2) {
      const target = digits[i];
      if (target >= 0 && target <= 9) {
        counts[target]++;
        total++;
      }
    }
  }

  const probs = counts.map(c => (c + 1) / (total + 10));
  return { probs, sampleCount: total };
}

function bayesianMarkovProb(digits: number[]): number[] {
  const p1 = markovNextProb(digits);
  const p2Data = markov2ndOrderNextProb(digits);
  const w2 = Math.min(0.60, p2Data.sampleCount * 0.15);
  const w1 = 1 - w2;
  return p1.map((val, idx) => val * w1 + p2Data.probs[idx] * w2);
}

function bayesianMarkovToTarget(digits: number[], targetDigit: number): number {
  const probs = bayesianMarkovProb(digits);
  return probs[targetDigit] ?? 0.1;
}

export interface ShannonEntropyResult {
  bits: number;
  ratio: number;
  isWhiteNoise: boolean;
  isStructured: boolean;
  bonus: number;
}

export function computeShannonEntropy(digits: number[], window = 50): ShannonEntropyResult {
  const d = digits.slice(-window);
  if (d.length < 15) {
    return { bits: 3.32, ratio: 1, isWhiteNoise: false, isStructured: false, bonus: 0 };
  }
  const counts = Array(10).fill(0);
  for (const v of d) if (v >= 0 && v <= 9) counts[v]++;
  const n = d.length;
  let h = 0;
  for (const c of counts) {
    if (c > 0) {
      const p = c / n;
      h -= p * Math.log2(p);
    }
  }
  const maxH = Math.log2(10);
  const ratio = h / maxH;
  const isWhiteNoise = h >= ENTROPY_WHITE_NOISE_LIMIT;
  const isStructured = h <= 3.12;

  let bonus = 0;
  if (isWhiteNoise) {
    bonus = -12;
  } else if (isStructured) {
    bonus = Math.min(15, Math.round((3.15 - h) * 50));
  } else {
    bonus = Math.round((3.22 - h) * 20);
  }

  return {
    bits: Math.round(h * 1000) / 1000,
    ratio: Math.round(ratio * 100) / 100,
    isWhiteNoise,
    isStructured,
    bonus: Math.max(-15, Math.min(15, bonus)),
  };
}

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
    else break;
  }
  return count;
}

function calculateStreakFatigue(
  digits: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
): { streakAgainst: number; fatigueScore: number; hazardBonus: number; isInflection: boolean } {
  const k = streakAgainstLength(digits, contractType, barrier);
  if (k === 0) return { streakAgainst: 0, fatigueScore: 0, hazardBonus: 0, isInflection: false };

  let histStreak = 0;
  const streakLengths: number[] = [];
  for (let i = 0; i < digits.length; i++) {
    const d = digits[i];
    let satisfies = false;
    switch (contractType) {
      case "DIGITOVER":  satisfies = barrier !== undefined && d > barrier; break;
      case "DIGITUNDER": satisfies = barrier !== undefined && d < barrier; break;
      case "DIGITEVEN":  satisfies = d % 2 === 0; break;
      case "DIGITODD":   satisfies = d % 2 !== 0; break;
      case "DIGITMATCH": satisfies = barrier !== undefined && d === barrier; break;
      case "DIGITDIFF":  satisfies = barrier !== undefined && d !== barrier; break;
    }
    if (!satisfies) {
      histStreak++;
    } else {
      if (histStreak > 0) streakLengths.push(histStreak);
      histStreak = 0;
    }
  }

  const avgStreak = streakLengths.length > 0
    ? streakLengths.reduce((a, b) => a + b, 0) / streakLengths.length
    : 1.6;

  const fatigueScore = Math.min(100, Math.round((k / Math.max(1, avgStreak)) * 50));
  const isInflection = k >= 2;
  const hazardBonus = k === 1 ? 4 : k === 2 ? 9 : k === 3 ? 14 : Math.min(15, 12 + Math.floor(k / 2));

  return { streakAgainst: k, fatigueScore, hazardBonus, isInflection };
}

function digitGapSinceLast(digits: number[], targetDigit: number): number {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] === targetDigit) return digits.length - 1 - i;
  }
  return digits.length;
}

function digitGapSinceLastSet(digits: number[], targetSet: number[]): number {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (targetSet.includes(digits[i])) return digits.length - 1 - i;
  }
  return digits.length;
}

function computePriceKinematics(
  prices: number[],
  direction: "CALL" | "PUT",
  window = 20,
): { lag1Autocorr: number; velocity: number; acceleration: number; isPersistent: boolean; isMeanReverting: boolean; signalBonus: number } {
  const p = prices.slice(-window);
  if (p.length < 5) {
    return { lag1Autocorr: 0, velocity: 0, acceleration: 0, isPersistent: false, isMeanReverting: false, signalBonus: 0 };
  }

  const returns: number[] = [];
  for (let i = 1; i < p.length; i++) returns.push(p[i] - p[i - 1]);

  const n = returns.length;
  const meanR = returns.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let t = 1; t < n; t++) num += (returns[t] - meanR) * (returns[t - 1] - meanR);
  for (let t = 0; t < n; t++) den += Math.pow(returns[t] - meanR, 2);

  const rho1 = den > 1e-12 ? Math.max(-1, Math.min(1, num / den)) : 0;
  const lastReturn = returns[returns.length - 1] ?? 0;
  const prevReturn = returns[returns.length - 2] ?? 0;
  const acceleration = lastReturn - prevReturn;
  const isPersistent = rho1 > 0.25;
  const isMeanReverting = rho1 < -0.25;

  let bonus = 0;
  const isCall = direction === "CALL";
  const upAligned = lastReturn > 0;
  const accAligned = isCall ? acceleration > 0 : acceleration < 0;

  if (isPersistent) {
    if ((isCall && upAligned) || (!isCall && !upAligned)) {
      bonus = accAligned ? 15 : 10;
    } else {
      bonus = -10;
    }
  } else if (isMeanReverting) {
    const last3 = returns.slice(-3);
    const consecutiveAdverse = isCall
      ? last3.filter(r => r < 0).length
      : last3.filter(r => r > 0).length;
    if (consecutiveAdverse >= 2) bonus = 12;
    else bonus = -5;
  } else {
    bonus = -8;
  }

  return {
    lag1Autocorr: Math.round(rho1 * 100) / 100,
    velocity: lastReturn,
    acceleration,
    isPersistent,
    isMeanReverting,
    signalBonus: bonus,
  };
}

function momentumRate(
  digits: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
  window = 15,
): number {
  if (contractType === "CALL" || contractType === "PUT") return 0.5;
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
  return ([20, 50, 80, 100][against]) ?? 50;
}

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

function pickBestMatchBarrier(digits: number[]): number {
  const bayes = bayesianMarkovProb(digits);
  const freq30 = digitFrequency(digits.slice(-30));
  const hotScore = bayes.map((m, i) => {
    const gap = digitGapSinceLast(digits, i);
    const gapBonus = gap >= 4 && gap <= 9 ? 0.15
                   : gap >= 3 && gap <= 12 ? 0.05
                   : gap < 3 ? -0.10 : -0.04;
    return m * 0.55 + (freq30[i] ?? 0) * 0.25 + gapBonus;
  });
  return hotScore.indexOf(Math.max(...hotScore));
}

function pickTopMatchBarriers(digits: number[], topN = 3): number[] {
  if (digits.length < 15) return [pickBestMatchBarrier(digits)];
  const bayes = bayesianMarkovProb(digits);
  const freq30 = digitFrequency(digits.slice(-30));
  const scored = bayes.map((m, i) => {
    const gap = digitGapSinceLast(digits, i);
    const gapQ = gap >= 4 && gap <= 9 ? 0.16
               : gap >= 3 && gap <= 12 ? 0.08
               : gap < 3 ? -0.14 : -0.04;
    return { digit: i, score: m * 0.55 + (freq30[i] ?? 0) * 0.25 + gapQ };
  });
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(s => s.digit);
}

function pickBestDiffBarrier(digits: number[]): number {
  const bayes = bayesianMarkovProb(digits);
  const freq50 = digitFrequency(digits.slice(-50));
  const coldScore = bayes.map((m, i) => {
    const gap = digitGapSinceLast(digits, i);
    const gapPenalty = Math.max(0, 10 - Math.min(gap, 10)) / 10 * 0.15;
    return m * 0.50 + (freq50[i] ?? 0) * 0.35 + gapPenalty;
  });
  return coldScore.indexOf(Math.min(...coldScore));
}

function extractBarriers(barriers: number[]): { overBarrier: number; underBarrier: number } {
  const overBarrier  = barriers.length > 0 ? barriers[0] : 1;
  const underBarrier = barriers.length > 1 ? barriers[1] : 8;
  return { overBarrier, underBarrier };
}

// ── Quantum Scorer (PrecisionAI v4 — Profile-Aware) ──────────────────────────

function precisionScore(
  symbol: string,
  displayName: string,
  contractType: SpeedContractType,
  barrier: number | undefined,
  digits: number[],
  prices: number[],
  minDigitSamples?: number,
): MarketScore | null {
  const profile = getContractProfile(contractType, barrier);
  const requiredMinSamples = minDigitSamples ?? profile.minWindowShort;

  if (contractType.startsWith("DIGIT") && digits.length < requiredMinSamples) return null;
  if ((contractType === "CALL" || contractType === "PUT") && prices.length < 15) return null;

  const empiricalWinLen = profile.profile === "RARE_EVENT" ? Math.min(100, digits.length) : Math.min(50, digits.length);
  const freqWin = digitFrequency(digits.slice(-empiricalWinLen));
  const bayesMarkov = bayesianMarkovProb(digits);
  const p2Data = markov2ndOrderNextProb(digits);

  const momentum = momentumRate(digits, contractType, barrier, 15);
  const timing = entryTimingScore(digits, prices, contractType, barrier);
  const mom30 = momentumRate(digits, contractType, barrier, Math.min(30, digits.length));
  const stabilityRaw = Math.max(0, 1 - Math.abs(mom30 - momentum) / 0.30);
  const entropy = computeShannonEntropy(digits, 50);

  let empirical: number;
  let markovWin: number;
  let payout: number;
  let signalBonus = 0;

  switch (contractType) {
    case "DIGITOVER": {
      if (barrier === undefined) return null;
      empirical = freqWin.slice(barrier + 1).reduce((a, b) => a + b, 0);
      markovWin = bayesMarkov.slice(barrier + 1).reduce((a, b) => a + b, 0);
      payout = OVER_PAYOUTS[barrier] ?? OVER_PAYOUTS[4];
      const fatigue = calculateStreakFatigue(digits, "DIGITOVER", barrier);
      signalBonus = fatigue.hazardBonus;

      if (profile.profile === "RARE_EVENT") {
        const targetSet = barrier === 7 ? [8, 9] : [9];
        const gap = digitGapSinceLastSet(digits, targetSet);
        if (gap >= 3 && gap <= 8) signalBonus += 12;
        else if (gap < 2) signalBonus -= 15;
        else if (gap > 12) signalBonus -= 10;

        if (p2Data.sampleCount < 3) signalBonus -= 15;
        if (markovWin < 1.3 * profile.theoretical) signalBonus -= 20;
      }
      break;
    }

    case "DIGITUNDER": {
      if (barrier === undefined) return null;
      empirical = freqWin.slice(0, barrier).reduce((a, b) => a + b, 0);
      markovWin = bayesMarkov.slice(0, barrier).reduce((a, b) => a + b, 0);
      payout = UNDER_PAYOUTS[barrier] ?? UNDER_PAYOUTS[5];
      const fatigue = calculateStreakFatigue(digits, "DIGITUNDER", barrier);
      signalBonus = fatigue.hazardBonus;

      if (profile.profile === "RARE_EVENT") {
        const targetSet = barrier === 1 ? [0] : [0, 1];
        const gap = digitGapSinceLastSet(digits, targetSet);
        if (gap >= 3 && gap <= 8) signalBonus += 12;
        else if (gap < 2) signalBonus -= 15;
        else if (gap > 12) signalBonus -= 10;

        if (p2Data.sampleCount < 3) signalBonus -= 15;
        if (markovWin < 1.3 * profile.theoretical) signalBonus -= 20;
      }
      break;
    }

    case "DIGITEVEN": {
      empirical = [0, 2, 4, 6, 8].reduce((s, d) => s + (freqWin[d] ?? 0), 0);
      markovWin = [0, 2, 4, 6, 8].reduce((s, d) => s + (bayesMarkov[d] ?? 0), 0);
      payout = EVEN_ODD_PAYOUT;
      const fatigue = calculateStreakFatigue(digits, "DIGITEVEN", undefined);
      signalBonus = fatigue.hazardBonus;
      break;
    }

    case "DIGITODD": {
      empirical = [1, 3, 5, 7, 9].reduce((s, d) => s + (freqWin[d] ?? 0), 0);
      markovWin = [1, 3, 5, 7, 9].reduce((s, d) => s + (bayesMarkov[d] ?? 0), 0);
      payout = EVEN_ODD_PAYOUT;
      const fatigue = calculateStreakFatigue(digits, "DIGITODD", undefined);
      signalBonus = fatigue.hazardBonus;
      break;
    }

    case "DIGITMATCH": {
      if (barrier === undefined) return null;
      empirical = freqWin[barrier] ?? 0.1;
      markovWin = bayesianMarkovToTarget(digits, barrier);
      payout = MATCH_PAYOUT;

      const matchGap = digitGapSinceLast(digits, barrier);
      if (matchGap >= 4 && matchGap <= 9) signalBonus += 14;
      else if (matchGap < 2) signalBonus -= 18;
      else if (matchGap > 12) signalBonus -= 12;
      else signalBonus -= 5;

      if (p2Data.sampleCount < 3) signalBonus -= 15;
      if (markovWin < 0.13) signalBonus -= 25;
      break;
    }

    case "DIGITDIFF": {
      if (barrier === undefined) return null;
      empirical = 1 - (freqWin[barrier] ?? 0.1);
      markovWin = 1 - bayesianMarkovToTarget(digits, barrier);
      payout = DIFF_PAYOUT;

      const diffGap = digitGapSinceLast(digits, barrier);
      if (diffGap >= 10) signalBonus += 12;
      else if (diffGap >= 6) signalBonus += 6;
      else if (diffGap <= 1) signalBonus -= 15;
      else signalBonus -= 4;
      break;
    }

    case "CALL": {
      let ups = 0;
      for (let i = 1; i < prices.length; i++) if (prices[i] > prices[i - 1]) ups++;
      empirical = ups / Math.max(1, prices.length - 1);
      markovWin = empirical;
      payout = RISE_FALL_PAYOUT;

      const k15 = computePriceKinematics(prices, "CALL", 15);
      const k30 = computePriceKinematics(prices, "CALL", 30);
      const k60 = computePriceKinematics(prices, "CALL", 60);

      signalBonus = k15.signalBonus;
      if (k60.velocity < 0 && k60.isPersistent) signalBonus -= 15;
      if (k15.velocity > 0 && k30.velocity > 0 && k60.velocity > 0) signalBonus += 6;
      break;
    }

    case "PUT": {
      let downs = 0;
      for (let i = 1; i < prices.length; i++) if (prices[i] < prices[i - 1]) downs++;
      empirical = downs / Math.max(1, prices.length - 1);
      markovWin = empirical;
      payout = RISE_FALL_PAYOUT;

      const k15 = computePriceKinematics(prices, "PUT", 15);
      const k30 = computePriceKinematics(prices, "PUT", 30);
      const k60 = computePriceKinematics(prices, "PUT", 60);

      signalBonus = k15.signalBonus;
      if (k60.velocity > 0 && k60.isPersistent) signalBonus -= 15;
      if (k15.velocity < 0 && k30.velocity < 0 && k60.velocity < 0) signalBonus += 6;
      break;
    }

    default: return null;
  }

  const timingRatio = timing / 100;
  const winP =
    markovWin * profile.markovWeight +
    empirical * profile.empiricalWeight +
    momentum * profile.momentumWeight +
    timingRatio * profile.timingWeight;

  const edgeNorm = Math.max(-1, Math.min(1, (winP - profile.theoretical) / profile.edgeDenominator));
  const timingBonus = (timing - 50) * 0.20;
  const stabilityBonus = (stabilityRaw - 0.5) * 10;
  const entropyBonus = entropy.bonus;

  const ev = winP * (payout - 1) - (1 - winP);
  const evBonus = ev >= 0.05 ? 8 : ev >= MIN_NORMAL_EV ? 3 : ev < 0 ? -12 : 0;

  const score = Math.min(100, Math.max(0,
    50 + edgeNorm * 45 + timingBonus + stabilityBonus + signalBonus + entropyBonus + evBonus,
  ));

  const reason = [
    `${(winP * 100).toFixed(1)}% win-p`,
    `EV ${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}%`,
    `H ${entropy.bits}b`,
  ].join(" · ");

  return {
    symbol,
    displayName,
    contractType,
    barrier,
    score,
    winProbability: winP,
    payout,
    expectedValue: ev,
    entropyBits: entropy.bits,
    isStructured: entropy.isStructured,
    reason,
  };
}

/**
 * Green-Light Barrier-Aware Sub-Tick Entry Validator
 */
function isGreenLight(
  digits: number[],
  prices: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
): boolean {
  if (digits.length < 10 && contractType.startsWith("DIGIT")) return false;
  if (prices.length < 5 && (contractType === "CALL" || contractType === "PUT")) return false;

  switch (contractType) {
    case "DIGITOVER": {
      if (barrier === undefined) return false;
      const last5 = digits.slice(-5);
      const reversalCount = last5.filter(d => d <= barrier).length;
      const streakAgainst = streakAgainstLength(digits, "DIGITOVER", barrier);

      if (barrier === 8) {
        const gap = digitGapSinceLast(digits, 9);
        const post = bayesianMarkovToTarget(digits, 9);
        const lastDigit = digits[digits.length - 1];
        return gap >= 4 && gap <= 9 && post >= 0.13 && lastDigit !== 9;
      } else if (barrier === 7) {
        const gap = digitGapSinceLastSet(digits, [8, 9]);
        const post = bayesianMarkovToTarget(digits, 8) + bayesianMarkovToTarget(digits, 9);
        return gap >= 3 && gap <= 8 && post >= 0.26;
      } else if (barrier === 5 || barrier === 6) {
        const targetSet = Array.from({ length: 9 - barrier }, (_, i) => barrier + 1 + i);
        const post = targetSet.reduce((s, d) => s + bayesianMarkovToTarget(digits, d), 0);
        return streakAgainst >= 3 || (reversalCount >= 3 && post > 0.45);
      } else if (barrier === 3 || barrier === 4) {
        const mom10 = momentumRate(digits, "DIGITOVER", barrier, 10);
        const mom20 = momentumRate(digits, "DIGITOVER", barrier, Math.min(20, digits.length));
        return streakAgainst >= 2 || (reversalCount >= 2 && mom10 > mom20);
      } else {
        return reversalCount >= 2 || streakAgainst >= 2;
      }
    }

    case "DIGITUNDER": {
      if (barrier === undefined) return false;
      const last5 = digits.slice(-5);
      const reversalCount = last5.filter(d => d >= barrier).length;
      const streakAgainst = streakAgainstLength(digits, "DIGITUNDER", barrier);

      if (barrier === 1) {
        const gap = digitGapSinceLast(digits, 0);
        const post = bayesianMarkovToTarget(digits, 0);
        const lastDigit = digits[digits.length - 1];
        return gap >= 4 && gap <= 9 && post >= 0.13 && lastDigit !== 0;
      } else if (barrier === 2) {
        const gap = digitGapSinceLastSet(digits, [0, 1]);
        const post = bayesianMarkovToTarget(digits, 0) + bayesianMarkovToTarget(digits, 1);
        return gap >= 3 && gap <= 8 && post >= 0.26;
      } else if (barrier === 3 || barrier === 4) {
        const targetSet = Array.from({ length: barrier }, (_, i) => i);
        const post = targetSet.reduce((s, d) => s + bayesianMarkovToTarget(digits, d), 0);
        return streakAgainst >= 3 || (reversalCount >= 3 && post > 0.45);
      } else if (barrier === 5 || barrier === 6) {
        const mom10 = momentumRate(digits, "DIGITUNDER", barrier, 10);
        const mom20 = momentumRate(digits, "DIGITUNDER", barrier, Math.min(20, digits.length));
        return streakAgainst >= 2 || (reversalCount >= 2 && mom10 > mom20);
      } else {
        return reversalCount >= 2 || streakAgainst >= 2;
      }
    }

    case "DIGITEVEN": {
      const oddStreak = streakAgainstLength(digits, "DIGITEVEN", undefined);
      const mom10 = momentumRate(digits, "DIGITEVEN", undefined, 10);
      const bayes = bayesianMarkovProb(digits);
      const evenPost = [0, 2, 4, 6, 8].reduce((s, d) => s + (bayes[d] ?? 0), 0);
      return oddStreak >= 2 || (mom10 >= 0.58 && evenPost > 0.55);
    }

    case "DIGITODD": {
      const evenStreak = streakAgainstLength(digits, "DIGITODD", undefined);
      const mom10 = momentumRate(digits, "DIGITODD", undefined, 10);
      const bayes = bayesianMarkovProb(digits);
      const oddPost = [1, 3, 5, 7, 9].reduce((s, d) => s + (bayes[d] ?? 0), 0);
      return evenStreak >= 2 || (mom10 >= 0.58 && oddPost > 0.55);
    }

    case "CALL": {
      if (prices.length < 15) return false;
      const k15 = computePriceKinematics(prices, "CALL", 15);
      const k30 = computePriceKinematics(prices, "CALL", 30);
      const k60 = computePriceKinematics(prices, "CALL", 60);

      if (k60.velocity < 0 && k60.isPersistent) return false;

      const bothUp = k15.velocity > 0 && k30.velocity > 0;
      const bothPersistent = k15.isPersistent && k30.isPersistent;
      const meanRevOk = (k15.isMeanReverting || k30.isMeanReverting) && k30.lag1Autocorr < -0.20 && k15.signalBonus > 0;

      return (bothUp && (bothPersistent || k15.signalBonus > 0)) || meanRevOk;
    }

    case "PUT": {
      if (prices.length < 15) return false;
      const k15 = computePriceKinematics(prices, "PUT", 15);
      const k30 = computePriceKinematics(prices, "PUT", 30);
      const k60 = computePriceKinematics(prices, "PUT", 60);

      if (k60.velocity > 0 && k60.isPersistent) return false;

      const bothDown = k15.velocity < 0 && k30.velocity < 0;
      const bothPersistent = k15.isPersistent && k30.isPersistent;
      const meanRevOk = (k15.isMeanReverting || k30.isMeanReverting) && k30.lag1Autocorr < -0.20 && k15.signalBonus > 0;

      return (bothDown && (bothPersistent || k15.signalBonus > 0)) || meanRevOk;
    }

    case "DIGITMATCH": {
      if (barrier === undefined) return false;
      const gap = digitGapSinceLast(digits, barrier);
      const post = bayesianMarkovToTarget(digits, barrier);
      const lastDigit = digits[digits.length - 1];
      return gap >= 4 && gap <= 9 && post >= 0.13 && lastDigit !== barrier;
    }

    case "DIGITDIFF": {
      if (barrier === undefined) return false;
      const gap = digitGapSinceLast(digits, barrier);
      const post = bayesianMarkovToTarget(digits, barrier);
      return gap >= 5 && post < 0.10;
    }

    default: return false;
  }
}

/**
 * Sniper Recovery Deep Signal Divergence (+20 / -15 pts)
 */
function deepSniperBonus(
  contractType: SpeedContractType,
  barrier: number | undefined,
  digits: number[],
  prices: number[],
): number {
  switch (contractType) {
    case "DIGITOVER": {
      if (barrier === undefined) return 0;
      const d = digits.slice(-50);
      if (d.length < 10) return 0;
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      const variance = d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length;
      const z = (mean - 4.5) / (Math.sqrt(variance / d.length) || 0.1);
      const zB = z < -1.85 ? 14 : z < -1.4 ? 8 : z < -1.0 ? 4 : z > 1.5 ? -12 : z > 1.0 ? -6 : 0;
      const d20 = digits.slice(-20);
      const aboveRate = d20.length > 0 ? d20.filter(v => v > barrier).length / d20.length : 0;
      const fB = aboveRate >= 0.65 ? 6 : aboveRate >= 0.55 ? 2 : aboveRate <= 0.25 ? -8 : 0;
      return Math.max(-15, Math.min(20, zB + fB));
    }
    case "DIGITUNDER": {
      if (barrier === undefined) return 0;
      const d = digits.slice(-50);
      if (d.length < 10) return 0;
      const mean = d.reduce((a, b) => a + b, 0) / d.length;
      const variance = d.reduce((s, v) => s + (v - mean) ** 2, 0) / d.length;
      const z = (mean - 4.5) / (Math.sqrt(variance / d.length) || 0.1);
      const zB = z > 1.85 ? 14 : z > 1.4 ? 8 : z > 1.0 ? 4 : z < -1.5 ? -12 : z < -1.0 ? -6 : 0;
      const d20 = digits.slice(-20);
      const belowRate = d20.length > 0 ? d20.filter(v => v < barrier).length / d20.length : 0;
      const fB = belowRate >= 0.65 ? 6 : belowRate >= 0.55 ? 2 : belowRate <= 0.25 ? -8 : 0;
      return Math.max(-15, Math.min(20, zB + fB));
    }
    case "DIGITEVEN": {
      const d = digits.slice(-40);
      if (d.length < 10) return 0;
      const evenCnt = d.filter(v => v % 2 === 0).length;
      const oddRate = (d.length - evenCnt) / d.length;
      const bB = oddRate >= 0.65 ? 15 : oddRate >= 0.58 ? 8 : oddRate >= 0.52 ? 3
               : oddRate <= 0.35 ? -12 : oddRate <= 0.42 ? -6 : 0;
      const exp = d.length / 2;
      const chi2 = (evenCnt - exp) ** 2 / exp + ((d.length - evenCnt) - exp) ** 2 / exp;
      const cB = chi2 > 3.84 && evenCnt < exp ? 5 : chi2 > 3.84 && evenCnt > exp ? -5 : 0;
      return Math.max(-15, Math.min(20, bB + cB));
    }
    case "DIGITODD": {
      const d = digits.slice(-40);
      if (d.length < 10) return 0;
      const evenCnt = d.filter(v => v % 2 === 0).length;
      const evenRate = evenCnt / d.length;
      const bB = evenRate >= 0.65 ? 15 : evenRate >= 0.58 ? 8 : evenRate >= 0.52 ? 3
               : evenRate <= 0.35 ? -12 : evenRate <= 0.42 ? -6 : 0;
      const exp = d.length / 2;
      const chi2 = (evenCnt - exp) ** 2 / exp + ((d.length - evenCnt) - exp) ** 2 / exp;
      const cB = chi2 > 3.84 && evenCnt > exp ? 5 : chi2 > 3.84 && evenCnt < exp ? -5 : 0;
      return Math.max(-15, Math.min(20, bB + cB));
    }
    case "DIGITMATCH": {
      if (barrier === undefined) return 0;
      const gap = digitGapSinceLast(digits, barrier);
      const gB = gap >= 4 && gap <= 9 ? 14 : gap >= 3 && gap <= 11 ? 7 : gap < 3 ? -14 : -5;
      const d30 = digits.slice(-30);
      const freq = d30.length > 0 ? d30.filter(v => v === barrier).length / d30.length : 0;
      const fB = freq >= 0.08 && freq <= 0.18 ? 6 : freq > 0.25 ? -10 : 0;
      return Math.max(-15, Math.min(20, gB + fB));
    }
    case "DIGITDIFF": {
      if (barrier === undefined) return 0;
      const gap = digitGapSinceLast(digits, barrier);
      const gB = gap >= 12 ? 15 : gap >= 8 ? 8 : gap <= 2 ? -15 : -4;
      const d50 = digits.slice(-50);
      const freq = d50.length > 0 ? d50.filter(v => v === barrier).length / d50.length : 0;
      const fB = freq <= 0.04 ? 8 : freq <= 0.08 ? 3 : freq >= 0.18 ? -12 : 0;
      return Math.max(-15, Math.min(20, gB + fB));
    }
    case "CALL":
    case "PUT": {
      const k = computePriceKinematics(prices, contractType, 15);
      return k.signalBonus;
    }
    default: return 0;
  }
}

function recoveryGateRequirements(
  contractType: SpeedContractType,
  barrier: number | undefined,
): { requiredScore: number; requiredEv: number } {
  const profile = getContractProfile(contractType, barrier);
  return {
    requiredScore: Math.min(68, profile.requiredScore),
    requiredEv: Math.min(0.06, profile.requiredEv),
  };
}

/**
 * FastRecoveryGate v4 (Sniper Protocol — Fresh Analysis per Attempt)
 */
function fastRecoveryGate(
  symbol: string,
  displayName: string,
  contractTypes: SpeedContractType[],
  barriers: number[],
  consecutiveLosses: number,
  recentRecoveryTrades: RecoveryTradeRecord[],
  excludedPair?: { contractType: SpeedContractType; barrier?: number } | null,
  nudgeActive = false,
): { winner: MarketScore; greenLight: boolean } | null {
  const { overBarrier, underBarrier } = extractBarriers(barriers);

  const digits100 = tickManager.getDigits(symbol, 100);
  const prices50  = tickManager.getTicks(symbol, 50);
  if (digits100.length < 25) return null;

  // Anti-pattern decaying penalty map
  const penaltyMap = new Map<string, number>();
  for (let i = recentRecoveryTrades.length - 1; i >= 0; i--) {
    const t = recentRecoveryTrades[i];
    const key = `${t.contractType}_${t.barrier ?? ""}`;
    if (!t.won) {
      const existing = penaltyMap.get(key) ?? 0;
      const agePenalty = Math.max(0, 10 - (recentRecoveryTrades.length - 1 - i) * 2);
      penaltyMap.set(key, Math.max(existing, agePenalty));
    } else {
      penaltyMap.delete(key);
    }
  }

  // Expand candidates
  const expandedEntries: Array<{ ct: SpeedContractType; barrier: number | undefined }> = [];
  for (const ct of contractTypes) {
    if      (ct === "DIGITOVER")  { expandedEntries.push({ ct, barrier: overBarrier }); }
    else if (ct === "DIGITUNDER") { expandedEntries.push({ ct, barrier: underBarrier }); }
    else if (ct === "DIGITMATCH") {
      for (const b of pickTopMatchBarriers(digits100.slice(-60), 3)) {
        expandedEntries.push({ ct, barrier: b });
      }
    }
    else if (ct === "DIGITDIFF")  { expandedEntries.push({ ct, barrier: pickBestDiffBarrier(digits100.slice(-60)) }); }
    else                          { expandedEntries.push({ ct, barrier: undefined }); }
  }

  const candidates: (MarketScore & { greenLight: boolean })[] = [];

  for (const { ct, barrier } of expandedEntries) {
    // Single-attempt loser rotation check
    const isExcludedPair =
      excludedPair &&
      excludedPair.contractType === ct &&
      excludedPair.barrier === barrier;

    if (isExcludedPair && expandedEntries.length > 1) {
      continue;
    }

    const profile = getContractProfile(ct, barrier);
    const minWin = profile.minWindowShort;

    const digitsWindow = tickManager.getDigits(symbol, Math.max(minWin, 60));
    if (digitsWindow.length < minWin && ct.startsWith("DIGIT")) continue;

    const rScored = precisionScore(symbol, displayName, ct, barrier, digitsWindow, prices50);
    if (!rScored) continue;

    const entropy = computeShannonEntropy(digitsWindow, 50);
    if (entropy.isWhiteNoise) continue;

    // On 2nd consecutive recovery loss, require entropy.isStructured
    if (consecutiveLosses >= 2 && !entropy.isStructured) continue;

    let reqScore = profile.requiredScore;
    let reqEv = profile.requiredEv;

    // If only one pair configured and it was lost, apply +2 score, +0.005 EV penalty
    if (isExcludedPair && expandedEntries.length <= 1) {
      reqScore += 2;
      reqEv += 0.005;
    }

    // Apply 7-cycle nudge if active
    if (nudgeActive && !isExcludedPair) {
      reqScore = Math.max(profile.requiredScore, reqScore - 2);
      reqEv = Math.max(profile.requiredEv, reqEv - 0.003);
    }

    reqScore = Math.min(68, reqScore);
    reqEv = Math.min(0.06, reqEv);

    const penalty = penaltyMap.get(`${ct}_${barrier ?? ""}`) ?? 0;
    const sBonus = deepSniperBonus(ct, barrier, digitsWindow, prices50);
    const adjustedScore = rScored.score + sBonus - penalty;

    if (adjustedScore < reqScore || rScored.expectedValue < reqEv) continue;

    const gl = isGreenLight(digitsWindow, prices50, ct, barrier);
    candidates.push({
      ...rScored,
      barrier,
      score: adjustedScore,
      reason: rScored.reason,
      greenLight: gl,
    });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (a.greenLight !== b.greenLight) return a.greenLight ? -1 : 1;
    return b.score - a.score;
  });

  const best = candidates[0]!;
  return { winner: best, greenLight: best.greenLight };
}

/**
 * Micro-Polling Green-Light Waiter (90ms intervals, max 2.8s)
 */
async function waitForGreenLight(
  symbol: string,
  contractType: SpeedContractType,
  barrier: number | undefined,
  maxWaitMs = 2800,
  pollMs    = 90,
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

/**
 * Re-validate trade parameters immediately prior to order submission
 */
function revalidateAtSubmission(
  symbol: string,
  contractType: SpeedContractType,
  barrier: number | undefined,
  scored: MarketScore,
): { valid: boolean; reason?: string } {
  const digits = tickManager.getDigits(symbol, 100);
  const prices = tickManager.getTicks(symbol, 50);
  const profile = getContractProfile(contractType, barrier);

  const freshScored = precisionScore(symbol, scored.displayName, contractType, barrier, digits, prices);
  if (!freshScored) return { valid: false, reason: "Timing shifted — re-analysing…" };

  if (freshScored.score < profile.requiredScore || freshScored.expectedValue < profile.requiredEv) {
    return { valid: false, reason: "Timing shifted — re-analysing…" };
  }

  if (!isGreenLight(digits, prices, contractType, barrier)) {
    return { valid: false, reason: "Market structure changed — re-analysing…" };
  }

  const entropy = computeShannonEntropy(digits, 50);
  if (entropy.isWhiteNoise) {
    return { valid: false, reason: "Market structure changed — re-analysing…" };
  }

  if (profile.profile === "RARE_EVENT") {
    if (contractType === "DIGITMATCH" && barrier !== undefined) {
      const gap = digitGapSinceLast(digits, barrier);
      if (gap < 2) return { valid: false, reason: "Timing shifted — re-analysing…" };
    } else if (contractType === "DIGITOVER" && barrier !== undefined && barrier >= 7) {
      const targetSet = barrier === 7 ? [8, 9] : [9];
      const gap = digitGapSinceLastSet(digits, targetSet);
      if (gap < 2) return { valid: false, reason: "Timing shifted — re-analysing…" };
    } else if (contractType === "DIGITUNDER" && barrier !== undefined && barrier <= 2) {
      const targetSet = barrier === 1 ? [0] : [0, 1];
      const gap = digitGapSinceLastSet(digits, targetSet);
      if (gap < 2) return { valid: false, reason: "Timing shifted — re-analysing…" };
    }
  }

  return { valid: true };
}

// ── Manual Assist Evaluation (for manual trading) ─────────────────────────────

export function evaluateManualAssist(
  symbol: string,
  contractType: SpeedContractType,
  barrier: number | undefined,
  duration: number,
): { ready: boolean; score: number; winProbability: number; expectedValue: number; reason: string; greenLight: boolean; entropyBits: number } {
  const digits = tickManager.getDigits(symbol, 100);
  const prices = tickManager.getTicks(symbol, 50);
  const displayName = DERIV_MARKETS.find(m => m.symbol === symbol)?.displayName ?? symbol;

  const profile = getContractProfile(contractType, barrier);
  if (contractType.startsWith("DIGIT") && digits.length < profile.minWindowShort) {
    return { ready: false, score: 0, winProbability: 0, expectedValue: -1, reason: "Waiting for accurate setup…", greenLight: false, entropyBits: 3.32 };
  }
  if ((contractType === "CALL" || contractType === "PUT") && prices.length < 15) {
    return { ready: false, score: 0, winProbability: 0, expectedValue: -1, reason: "Waiting for accurate setup…", greenLight: false, entropyBits: 3.32 };
  }

  const scored = precisionScore(symbol, displayName, contractType, barrier, digits, prices);
  if (!scored) {
    return { ready: false, score: 0, winProbability: 0, expectedValue: -1, reason: "Waiting for accurate setup…", greenLight: false, entropyBits: 3.32 };
  }

  const greenLight = isGreenLight(digits, prices, contractType, barrier);
  const entropy = computeShannonEntropy(digits, 50);

  let requiredScore = profile.requiredScore;
  let requiredEv = profile.requiredEv;
  if (duration === 1) {
    requiredScore = Math.max(requiredScore, 62);
    requiredEv = Math.max(requiredEv, 0.02);
  }

  if (entropy.isWhiteNoise) {
    return { ready: false, score: scored.score, winProbability: scored.winProbability, expectedValue: scored.expectedValue, reason: "Waiting for accurate setup…", greenLight, entropyBits: entropy.bits };
  }

  const greenOk = duration === 1 ? greenLight : (greenLight || scored.score >= 68);
  const ready = scored.score >= requiredScore && scored.expectedValue >= requiredEv && greenOk && !entropy.isWhiteNoise;

  const reason = ready ? "Good timing — AI confirms setup." : "Waiting for accurate setup…";

  return { ready, score: scored.score, winProbability: scored.winProbability, expectedValue: scored.expectedValue, reason, greenLight, entropyBits: entropy.bits };
}

// ── Market Strategy Analysis ──────────────────────────────────────────────────

export async function analyzeMarketsForStrategy(
  contractTypes: SpeedContractType[],
  barriers: number[],
): Promise<MarketScore[]> {
  const scored: MarketScore[] = [];
  const { overBarrier, underBarrier } = extractBarriers(barriers);

  for (const market of DERIV_MARKETS) {
    if (!market.digitEnabled && contractTypes.some(ct => ct.startsWith("DIGIT"))) continue;

    const digits = tickManager.getDigits(market.symbol, 100);
    const prices = tickManager.getTicks(market.symbol, 50);

    for (const ct of contractTypes) {
      let barrier: number | undefined;
      if      (ct === "DIGITOVER")  barrier = overBarrier;
      else if (ct === "DIGITUNDER") barrier = underBarrier;
      else if (ct === "DIGITMATCH") {
        if (digits.length < 25) continue;
        barrier = pickBestMatchBarrier(digits);
      }
      else if (ct === "DIGITDIFF") {
        if (digits.length < 25) continue;
        barrier = pickBestDiffBarrier(digits);
      }

      const rScored = precisionScore(market.symbol, market.displayName, ct, barrier, digits, prices);
      if (rScored) scored.push(rScored);
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}

export async function scoreSingleMarket(
  symbol: string,
  displayName: string,
  contractTypes: SpeedContractType[],
  barriers: number[],
): Promise<MarketScore | null> {
  const digits = tickManager.getDigits(symbol, 100);
  const prices = tickManager.getTicks(symbol, 50);
  const { overBarrier, underBarrier } = extractBarriers(barriers);
  const scored: MarketScore[] = [];

  for (const ct of contractTypes) {
    let barrier: number | undefined;
    if      (ct === "DIGITOVER")  barrier = overBarrier;
    else if (ct === "DIGITUNDER") barrier = underBarrier;
    else if (ct === "DIGITMATCH") barrier = pickBestMatchBarrier(digits);
    else if (ct === "DIGITDIFF")  barrier = pickBestDiffBarrier(digits);

    const rScored = precisionScore(symbol, displayName, ct, barrier, digits, prices);
    if (rScored) scored.push(rScored);
  }

  return scored.sort((a, b) => b.score - a.score)[0] ?? null;
}

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
    await sleep(240);

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
    return {
      suitable: false,
      best: null,
      allScored: [],
      reason: "No tick data available yet — please wait a few seconds and scan again",
    };
  }

  const best     = allScored[0];
  const suitable = best.score >= SUITABLE_SCORE_THRESHOLD;
  const reason   = suitable
    ? `${best.displayName} shows high statistical edge`
    : `No market shows decisive edge yet — best was ${best.displayName}`;

  return { suitable, best, allScored, reason };
}

// ── Recovery Stake Calculation ────────────────────────────────────────────────

function computeRecoveryStake(
  rec: SpeedRecoveryState,
  payout: number,
  config: SpeedAIConfig,
  maxStake: number,
  availableBalance: number,
): number {
  if (!rec.inRecovery) return config.stake;

  const requestedStake = calculateRecoveryStakeRequest({
    unrecoveredAmount: rec.unrecoveredAmount,
    remainingTargetProfit: rec.remainingTargetProfit,
    payoutMultiplier: payout,
    baseStake: rec.baseStake > 0 ? rec.baseStake : config.stake,
    recoveryAutoMode: config.recoveryAutoMode,
    recoveryMethod: config.recoveryMethod,
    recoveryMultiplier: config.recoveryMultiplier,
    recoveryStep: rec.recoveryStep,
    maxRecoverySteps: config.maxRecoverySteps,
  });
  return applyRecoveryStakeLimits(requestedStake, maxStake, availableBalance);
}

function recordRecoveryOutcome(
  rec: SpeedRecoveryState,
  won: boolean,
  profit: number,
  stake: number,
  maxSteps: number,
  payoutMultiplier: number,
  tradeContractType?: SpeedContractType,
  tradeBarrier?: number,
): SpeedRecoveryState {
  let recentTrades = rec.recentRecoveryTrades;
  if (tradeContractType) {
    const record: RecoveryTradeRecord = { contractType: tradeContractType, barrier: tradeBarrier, won };
    recentTrades = [...recentTrades, record].slice(-8);
  }

  if (won) {
    if (rec.inRecovery) {
      const recovered = Math.max(0, profit);
      const debtRecovered = Math.min(rec.unrecoveredAmount, recovered);
      const profitAvailableForTarget = Math.max(0, recovered - debtRecovered);
      const remainingDebt = Math.max(0, rec.unrecoveredAmount - debtRecovered);
      const remainingTarget = Math.max(0, rec.remainingTargetProfit - profitAvailableForTarget);
      if (remainingDebt <= 0.01) {
        return {
          inRecovery: false,
          recoveryStep: 0,
          unrecoveredAmount: 0,
          baseStake: rec.baseStake,
          targetProfit: 0,
          remainingTargetProfit: 0,
          originPayoutMultiplier: 1,
          consecutiveRecoveryLosses: 0,
          recentRecoveryTrades: [],
        };
      }
      return {
        ...rec,
        unrecoveredAmount: remainingDebt,
        remainingTargetProfit: remainingTarget,
        consecutiveRecoveryLosses: 0,
        recentRecoveryTrades: recentTrades,
      };
    }
    return rec;
  }

  if (!rec.inRecovery) {
    return {
      inRecovery: true,
      recoveryStep: 1,
      unrecoveredAmount: stake,
      baseStake: rec.baseStake > 0 ? rec.baseStake : stake,
      targetProfit: stake * Math.max(0, payoutMultiplier - 1),
      remainingTargetProfit: stake * Math.max(0, payoutMultiplier - 1),
      originPayoutMultiplier: payoutMultiplier > 1 ? payoutMultiplier : 1,
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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
    recoveryTargetProfit:      Math.round(session.recovery.targetProfit * 100) / 100,
    recoveryRemainingTargetProfit: Math.round(session.recovery.remainingTargetProfit * 100) / 100,
    recoveryOriginPayout:      Math.round(session.recovery.originPayoutMultiplier * 1000) / 1000,
    consecutiveRecoveryLosses: session.recovery.consecutiveRecoveryLosses,
    currentMarket:             session.currentMarket,
    currentContractType:       session.currentContractType,
    lastResult:                session.lastResult,
    config:                    session.config ?? undefined,
    message:                   session.message,
    topMarkets:                session.topMarkets.slice(0, 6),
    entropyBits:               session.lastEntropyBits,
    expectedValue:             session.lastEv,
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running       = false;
  session.message       = "Session stopped by user";
  broadcast();
  logger.info("NeuroAI FAB session stopped");
}

export async function startSession(config: SpeedAIConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "A NeuroAI session is already active" };

  if (config.stake < 0.35)    return { ok: false, error: "Minimum stake is $0.35" };
  if (config.stopLoss <= 0)   return { ok: false, error: "Stop loss must be positive" };
  if (config.takeProfit <= 0) return { ok: false, error: "Take profit must be positive" };
  if (config.normalContractTypes.length   === 0) return { ok: false, error: "Select at least one normal contract type" };
  if (config.recoveryContractTypes.length === 0) return { ok: false, error: "Select at least one recovery contract type" };

  session = {
    running:      true,
    sessionId:    `neuro_${Date.now()}`,
    config,
    totalProfit:  0,
    tradeCount:   0,
    winCount:     0,
    lossCount:    0,
    currentStake: config.stake,
    recovery: {
      inRecovery: false,
      recoveryStep: 0,
      unrecoveredAmount: 0,
      baseStake: config.stake,
      targetProfit: 0,
      remainingTargetProfit: 0,
      originPayoutMultiplier: 1,
      consecutiveRecoveryLosses: 0,
      recentRecoveryTrades: [],
    },
    topMarkets:   [],
    stopRequested: false,
    message: "Analysing fresh window…",
    lastEntropyBits: 3.32,
    lastEv: 0,
  };

  logger.info({ config }, "NeuroAI FAB session starting");
  broadcast();

  runLoop(config).catch(err => {
    logger.error({ err }, "NeuroAI FAB runLoop error");
    session.running = false;
    session.message = `Error: ${err instanceof Error ? err.message : String(err)}`;
    broadcast();
  });

  return { ok: true };
}

// ── Quantum Execution Loop ────────────────────────────────────────────────────

async function runLoop(config: SpeedAIConfig) {
  let accounts = await db.select().from(accountsTable).where(eq(accountsTable.isActive, true)).limit(1);
  if (accounts.length === 0) accounts = await db.select().from(accountsTable).limit(1);

  const settings       = await db.select().from(settingsTable).limit(1);
  const paperTradeMode = settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false;
  const token          = getCachedToken() ?? (accounts.length > 0 ? (accounts[0].bearerToken ?? accounts[0].token ?? null) : null);
  const currency       = accounts.length > 0 ? accounts[0].currency : "USD";
  const isLive         = !paperTradeMode && !!token;
  const maxStake       = settings.length > 0 ? Number(settings[0].maxTradeStake) : 500;
  let availableBalance = accounts.length > 0 && Number(accounts[0].balance) > 0
    ? Number(accounts[0].balance)
    : Number.POSITIVE_INFINITY;

  const isLocked = config.marketMode === "locked" || (!!config.lockedSymbol && config.marketMode !== "switching");
  const lockedDerivsMarket = isLocked && config.lockedSymbol
    ? DERIV_MARKETS.find(m => m.symbol === config.lockedSymbol) ?? null
    : null;

  if (isLocked && config.lockedSymbol && !lockedDerivsMarket) {
    session.running = false;
    session.message = `Market ${config.lockedSymbol} not found — session aborted`;
    broadcast();
    return;
  }

  let consecutiveErrors = 0;
  let noTradeCycles = 0;
  let lastLostRecoveryPair: { contractType: SpeedContractType; barrier?: number } | null = null;

  while (session.running && !session.stopRequested) {
    try {
      const health = tickManager.getTickHealth();
      if (health.liveSymbols === 0 && !health.usingSimulated) {
        session.message = "Stabilizing tick feed — syncing markets…";
        broadcast();
        await sleep(1200);
        continue;
      }

      const inRecovery    = session.recovery.inRecovery;
      const contractTypes = inRecovery ? config.recoveryContractTypes : config.normalContractTypes;
      const barriers      = inRecovery ? config.recoveryBarriers      : config.normalBarriers;
      const isDigitContract = contractTypes.some(ct => ct.startsWith("DIGIT"));

      // Target market for analysis
      const targetSymbol = lockedDerivsMarket ? lockedDerivsMarket.symbol : (session.topMarkets[0]?.symbol ?? "R_100");

      // Wait for fresh buffer (40 digits or 20 prices since last trade close)
      if (lastTradeClosedAt > 0) {
        await waitForFreshBuffer(targetSymbol, isDigitContract);
      }

      const nudgeActive = noTradeCycles >= 6;

      let best: MarketScore | undefined;

      // Always score fresh LIVE on every loop iteration (NO preAnalyzedScored)
      if (lockedDerivsMarket) {
        best = (await scoreSingleMarket(lockedDerivsMarket.symbol, lockedDerivsMarket.displayName, contractTypes, barriers)) ?? undefined;
        if (!best) {
          session.message = "Waiting for accurate setup…";
          broadcast();
          await sleep(1000);
          continue;
        }
        session.topMarkets = [best];
      } else {
        session.message = "Analysing fresh window…";
        broadcast();
        const scored = await analyzeMarketsForStrategy(contractTypes, barriers);
        session.topMarkets = scored;

        if (scored.length === 0) {
          session.message = "Waiting for accurate setup…";
          broadcast();
          await sleep(1000);
          continue;
        }

        // Apply 3+ consecutive recovery loss market rotation in switching mode
        if (inRecovery && session.recovery.consecutiveRecoveryLosses >= 3 && scored.length > 1) {
          const previousMarket = session.currentMarket;
          const alternative = scored.find(m => m.displayName !== previousMarket);
          best = alternative ?? scored[0];
        } else {
          best = scored[0];
        }
      }

      session.lastEntropyBits = best.entropyBits;
      session.lastEv = Math.round(best.expectedValue * 1000) / 10;

      // ── Gating: Recovery Sniper vs Normal Mode ──────────────────────────────
      if (inRecovery) {
        const consLosses  = session.recovery.consecutiveRecoveryLosses;
        const maxAttempts = 4;
        let candidate: { winner: MarketScore; greenLight: boolean } | null = null;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          candidate = fastRecoveryGate(
            best.symbol, best.displayName,
            config.recoveryContractTypes, barriers, consLosses,
            session.recovery.recentRecoveryTrades,
            lastLostRecoveryPair,
            nudgeActive,
          );
          if (candidate) break;

          session.message = "Waiting for accurate setup…";
          broadcast();
          await sleep(750);
          if (!session.running || session.stopRequested) break;
        }

        // Single attempt loser rotation: clear excluded pair after attempts
        lastLostRecoveryPair = null;

        if (!candidate) {
          noTradeCycles++;
          session.message = "Waiting for accurate setup…";
          broadcast();
          await sleep(1200);
          continue;
        }

        if (!candidate.greenLight) {
          const glAchieved = await waitForGreenLight(
            best.symbol, candidate.winner.contractType, candidate.winner.barrier,
          );
          if (!session.running || session.stopRequested) break;
          if (!glAchieved) {
            noTradeCycles++;
            session.message = "Waiting for accurate setup…";
            broadcast();
            continue;
          }

          // Re-evaluate fastRecoveryGate on fresh read after green light
          const refreshed = fastRecoveryGate(
            best.symbol, best.displayName,
            config.recoveryContractTypes, barriers, consLosses,
            session.recovery.recentRecoveryTrades,
            null,
            nudgeActive,
          );
          if (refreshed && refreshed.greenLight) {
            candidate = refreshed;
          } else {
            noTradeCycles++;
            session.message = "Waiting for accurate setup…";
            broadcast();
            continue;
          }
        }

        best = {
          ...best,
          contractType:   candidate.winner.contractType,
          barrier:        candidate.winner.barrier,
          payout:         candidate.winner.payout,
          winProbability: candidate.winner.winProbability,
          score:          candidate.winner.score,
          expectedValue:  candidate.winner.expectedValue,
          reason:         candidate.winner.reason,
        };

      } else {
        // Normal Mode Gating
        const profile = getContractProfile(best.contractType, best.barrier);
        const normalDigits = tickManager.getDigits(best.symbol, 60);
        const normalPrices = tickManager.getTicks(best.symbol, 50);
        const entropy = computeShannonEntropy(normalDigits, 50);
        let gl = isGreenLight(normalDigits, normalPrices, best.contractType, best.barrier);

        let reqScore = profile.requiredScore;
        let reqEv = profile.requiredEv;
        if (nudgeActive) {
          reqScore = Math.max(profile.requiredScore, reqScore - 2);
          reqEv = Math.max(profile.requiredEv, reqEv - 0.003);
        }

        if (!gl) {
          gl = await waitForGreenLight(best.symbol, best.contractType, best.barrier);
          if (!session.running || session.stopRequested) break;
        }

        const passesNormal = best.score >= reqScore && best.expectedValue >= reqEv && gl && !entropy.isWhiteNoise;

        if (!passesNormal) {
          noTradeCycles++;
          session.message = "Waiting for accurate setup…";
          broadcast();
          await sleep(1200);
          continue;
        }
      }

      // Reset nudge counter when a setup qualifies
      noTradeCycles = 0;

      // Strict user contract sovereignty
      const allowedContracts = inRecovery ? config.recoveryContractTypes : config.normalContractTypes;
      if (!allowedContracts.includes(best.contractType)) {
        logger.warn({ got: best.contractType, allowed: allowedContracts, mode: inRecovery ? "recovery" : "normal" }, "Discarding trade outside configured contract family");
        session.message = "Waiting for accurate setup…";
        broadcast();
        await sleep(750);
        continue;
      }
      const { overBarrier: expectedOver, underBarrier: expectedUnder } = extractBarriers(barriers);
      if (best.contractType === "DIGITOVER" && best.barrier !== expectedOver) {
        logger.warn({ expected: expectedOver, got: best.barrier, mode: inRecovery ? "recovery" : "normal" }, "Discarding DIGITOVER with wrong barrier");
        session.message = "Waiting for accurate setup…";
        broadcast();
        await sleep(750);
        continue;
      }
      if (best.contractType === "DIGITUNDER" && best.barrier !== expectedUnder) {
        logger.warn({ expected: expectedUnder, got: best.barrier, mode: inRecovery ? "recovery" : "normal" }, "Discarding DIGITUNDER with wrong barrier");
        session.message = "Waiting for accurate setup…";
        broadcast();
        await sleep(750);
        continue;
      }

      // Full Gate Re-Validation at Submission
      const revalidation = revalidateAtSubmission(best.symbol, best.contractType, best.barrier, best);
      if (!revalidation.valid) {
        session.message = revalidation.reason ?? "Timing shifted — re-analysing…";
        broadcast();
        await sleep(300);
        continue;
      }

      // Pre-Warmed Proposal Quoting & EV re-check
      const payoutQuote = await resolveRecoveryPayout({
        symbol: best.symbol,
        contractType: best.contractType,
        barrier: best.barrier,
        duration: 1,
        durationUnit: "t",
        currency,
      });
      best = { ...best, payout: payoutQuote.payoutMultiplier };

      const freshEv = best.winProbability * (payoutQuote.payoutMultiplier - 1) - (1 - best.winProbability);
      const profile = getContractProfile(best.contractType, best.barrier);
      if (freshEv < best.expectedValue - 0.03 || freshEv < profile.requiredEv) {
        session.message = "Timing shifted — re-analysing…";
        broadcast();
        await sleep(300);
        continue;
      }

      const stake = computeRecoveryStake(session.recovery, best.payout, config, maxStake, availableBalance);

      session.currentMarket       = best.displayName;
      session.currentContractType = best.contractType + (best.barrier !== undefined ? ` ${best.barrier}` : "");
      session.currentStake        = stake;
      session.message = inRecovery
        ? `🎯 [Sniper R${session.recovery.recoveryStep}] ${best.contractType}${best.barrier !== undefined ? ` ${best.barrier}` : ""} on ${best.displayName}`
        : `⚡ Trading ${best.contractType}${best.barrier !== undefined ? ` ${best.barrier}` : ""} on ${best.displayName}`;
      broadcast();

      // Execute Trade
      let won: boolean;
      let profit: number;

      if (isLive) {
        try {
          logger.info({
            symbol:       best.symbol,
            contractType: best.contractType,
            barrier:      best.barrier,
            stake:        Math.round(stake * 100) / 100,
            inRecovery,
            step:         session.recovery.recoveryStep,
          }, inRecovery ? "NeuroAI executing sniper recovery trade" : "NeuroAI executing normal trade");

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
          logger.warn({ err, symbol: best.symbol }, "NeuroAI live trade execution error — retrying");
          session.message = "Timing shifted — re-analysing…";
          broadcast();
          await sleep(1200);
          continue;
        }
      } else {
        won    = Math.random() < best.winProbability;
        profit = won ? stake * (best.payout - 1) : -stake;
      }

      // Track completion timestamp and tick count at close
      lastTradeClosedAt = Date.now();
      lastTradeClosedDigitCount.set(best.symbol, totalDigitsReceived.get(best.symbol) ?? 0);
      lastTradeClosedPriceCount.set(best.symbol, totalPricesReceived.get(best.symbol) ?? 0);

      // Record Outcome & Settle Recovery State
      session.tradeCount++;
      session.totalProfit = Math.round((session.totalProfit + profit) * 100) / 100;
      if (won) {
        session.winCount++;
        session.lastResult = "won";
      } else {
        session.lossCount++;
        session.lastResult = "lost";
      }

      session.recovery = recordRecoveryOutcome(
        session.recovery, won, profit, stake, config.maxRecoverySteps, best.payout,
        inRecovery ? best.contractType : undefined,
        inRecovery ? best.barrier      : undefined,
      );

      // Single-attempt loser rotation or cooldown setting
      if (!won && inRecovery) {
        lastLostRecoveryPair = { contractType: best.contractType, barrier: best.barrier };
      } else {
        lastLostRecoveryPair = null;
      }

      if (!isLive && Number.isFinite(availableBalance)) {
        availableBalance = Math.max(0, availableBalance + profit);
      }

      if (isLive) {
        try {
          const newBal = await getLiveBalance(token!);
          if (newBal !== null && accounts.length > 0) {
            availableBalance = newBal;
            await db.update(accountsTable)
              .set({ balance: String(newBal), updatedAt: new Date() })
              .where(eq(accountsTable.id, accounts[0].id));
          }
        } catch { /* best-effort */ }
      }

      broadcast();

      // Boundary Checks
      if (session.totalProfit >= config.takeProfit) {
        session.running = false;
        session.message = `✅ Take profit target $${config.takeProfit.toFixed(2)} reached! Session complete.`;
        broadcast();
        logger.info({ profit: session.totalProfit }, "NeuroAI take profit reached");
        return;
      }
      if (session.totalProfit <= -config.stopLoss) {
        session.running = false;
        session.message = `🛑 Stop loss limit $${config.stopLoss.toFixed(2)} hit. Session stopped safely.`;
        broadcast();
        logger.info({ profit: session.totalProfit }, "NeuroAI stop loss triggered");
        return;
      }

      session.message = "Stabilizing after trade…";
      broadcast();
      await sleep(won ? 800 : 1500);
      consecutiveErrors = 0;

    } catch (err) {
      consecutiveErrors++;
      logger.error({ err, consecutiveErrors }, "NeuroAI runLoop stability catch");
      session.message = "Stabilizing after trade…";
      broadcast();
      await sleep(Math.min(2000, 500 * consecutiveErrors));
      if (consecutiveErrors >= 5) {
        session.running = false;
        session.message = "Engine paused for stability check — please restart";
        broadcast();
        logger.error("NeuroAI halted after 5 consecutive errors");
        return;
      }
      continue;
    }
  }

  if (!session.running && !session.message?.startsWith("✅") && !session.message?.startsWith("🛑") && !session.message?.startsWith("⚠️")) {
    session.message = "Session stopped";
    broadcast();
  }
}

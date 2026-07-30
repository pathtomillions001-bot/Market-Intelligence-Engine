/**
 * SpeedAI Engine — 1-tick ultra-fast trading engine
 *
 * Analyzes all markets in real-time to find the best setup for each selected
 * contract type, then executes 1-tick trades in a continuous loop until the
 * user-set Take Profit or Stop Loss is reached.
 *
 * Recovery state is ISOLATED from the global recovery engine so SpeedAI
 * sessions do not interfere with the main autonomous engine.
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
import { logger } from "./logger";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Minimum score (0–100) for a market to be considered "suitable" to trade */
const SUITABLE_SCORE_THRESHOLD = 54;

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

// ── Market analysis ───────────────────────────────────────────────────────────

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
  return row.map(v => (v + 1) / (total + 10)); // Laplace smoothing
}

/**
 * Score a single market for a given contract type + barrier.
 * Returns a score 0–100 and estimated win probability.
 */
function scoreMarket(
  symbol: string,
  displayName: string,
  contractType: SpeedContractType,
  barrier: number | undefined,
  digits: number[],
  prices: number[],
): MarketScore | null {
  if (digits.length < 50 && (contractType.startsWith("DIGIT"))) return null;
  if (prices.length < 30 && (contractType === "CALL" || contractType === "PUT")) return null;

  const freq = digitFrequency(digits);
  const markov = markovNextProb(digits);

  if (contractType === "DIGITOVER" && barrier !== undefined) {
    // Win if last digit > barrier
    const theoretical = (9 - barrier) / 10;
    const empirical = freq.slice(barrier + 1).reduce((a, b) => a + b, 0);
    const markovWin = markov.slice(barrier + 1).reduce((a, b) => a + b, 0);
    const winP = empirical * 0.5 + markovWin * 0.5;
    const edge = (winP - theoretical) * 100;
    const score = Math.min(100, Math.max(0, 50 + edge * 3 + (winP - 0.4) * 40));
    const payout = DIGIT_PAYOUTS_OVER[barrier] ?? 1.63;
    const ev = winP * (payout - 1) - (1 - winP);
    const reason = `${(winP * 100).toFixed(1)}% empirical win rate, EV ${ev > 0 ? "+" : ""}${(ev * 100).toFixed(1)}%`;
    return { symbol, displayName, contractType, barrier, score, winProbability: winP, payout, reason };
  }

  if (contractType === "DIGITUNDER" && barrier !== undefined) {
    const theoretical = barrier / 10;
    const empirical = freq.slice(0, barrier).reduce((a, b) => a + b, 0);
    const markovWin = markov.slice(0, barrier).reduce((a, b) => a + b, 0);
    const winP = empirical * 0.5 + markovWin * 0.5;
    const edge = (winP - theoretical) * 100;
    const score = Math.min(100, Math.max(0, 50 + edge * 3 + (winP - 0.4) * 40));
    const payout = DIGIT_PAYOUTS_UNDER[barrier] ?? 1.63;
    const ev = winP * (payout - 1) - (1 - winP);
    const reason = `${(winP * 100).toFixed(1)}% empirical win rate, EV ${ev > 0 ? "+" : ""}${(ev * 100).toFixed(1)}%`;
    return { symbol, displayName, contractType, barrier, score, winProbability: winP, payout, reason };
  }

  if (contractType === "DIGITEVEN") {
    const evenP = [0, 2, 4, 6, 8].reduce((s, d) => s + (freq[d] ?? 0), 0);
    const markovEvenP = [0, 2, 4, 6, 8].reduce((s, d) => s + (markov[d] ?? 0), 0);
    const winP = evenP * 0.6 + markovEvenP * 0.4;
    const edge = (winP - 0.5) * 100;
    const score = Math.min(100, Math.max(0, 50 + edge * 4));
    return { symbol, displayName, contractType, score, winProbability: winP, payout: 1.96, reason: `Even ${(winP * 100).toFixed(1)}% recent freq` };
  }

  if (contractType === "DIGITODD") {
    const oddP = [1, 3, 5, 7, 9].reduce((s, d) => s + (freq[d] ?? 0), 0);
    const markovOddP = [1, 3, 5, 7, 9].reduce((s, d) => s + (markov[d] ?? 0), 0);
    const winP = oddP * 0.6 + markovOddP * 0.4;
    const edge = (winP - 0.5) * 100;
    const score = Math.min(100, Math.max(0, 50 + edge * 4));
    return { symbol, displayName, contractType, score, winProbability: winP, payout: 1.96, reason: `Odd ${(winP * 100).toFixed(1)}% recent freq` };
  }

  if (contractType === "DIGITMATCH" && barrier !== undefined) {
    const matchP = freq[barrier] ?? 0.1;
    const markovMatchP = markov[barrier] ?? 0.1;
    const winP = matchP * 0.6 + markovMatchP * 0.4;
    const edge = (winP - 0.1) * 100;
    const score = Math.min(100, Math.max(0, 50 + edge * 3));
    return { symbol, displayName, contractType, barrier, score, winProbability: winP, payout: 9.0, reason: `Digit ${barrier} freq ${(winP * 100).toFixed(1)}%` };
  }

  if (contractType === "DIGITDIFF" && barrier !== undefined) {
    const matchP = freq[barrier] ?? 0.1;
    const markovMatchP = markov[barrier] ?? 0.1;
    const diffWinP = 1 - (matchP * 0.6 + markovMatchP * 0.4);
    const edge = (diffWinP - 0.9) * 100;
    const score = Math.min(100, Math.max(0, 50 + edge * 4));
    return { symbol, displayName, contractType, barrier, score, winProbability: diffWinP, payout: 1.04, reason: `Digit ${barrier} absent ${(diffWinP * 100).toFixed(1)}%` };
  }

  if (contractType === "CALL") {
    // Count rising ticks
    let upCount = 0;
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] > prices[i - 1]) upCount++;
    }
    const winP = upCount / (prices.length - 1 || 1);
    const edge = (winP - 0.5) * 100;
    const score = Math.min(100, Math.max(0, 50 + edge * 4));
    return { symbol, displayName, contractType, score, winProbability: winP, payout: 1.91, reason: `Rise ${(winP * 100).toFixed(1)}% of recent ticks` };
  }

  if (contractType === "PUT") {
    let downCount = 0;
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] < prices[i - 1]) downCount++;
    }
    const winP = downCount / (prices.length - 1 || 1);
    const edge = (winP - 0.5) * 100;
    const score = Math.min(100, Math.max(0, 50 + edge * 4));
    return { symbol, displayName, contractType, score, winProbability: winP, payout: 1.91, reason: `Fall ${(winP * 100).toFixed(1)}% of recent ticks` };
  }

  return null;
}

/**
 * Pick the best barrier for DIGITMATCH (hottest digit) or DIGITDIFF (coldest digit).
 */
function pickMatchDiffBarrier(freq: number[], contractType: "DIGITMATCH" | "DIGITDIFF"): number {
  if (contractType === "DIGITMATCH") {
    return freq.indexOf(Math.max(...freq));
  } else {
    return freq.indexOf(Math.min(...freq));
  }
}

/**
 * Extract OVER and UNDER barriers from the barriers array.
 * Convention (set by familyToContracts in the frontend):
 *   barriers[0] = OVER barrier, barriers[1] = UNDER barrier.
 *
 * IMPORTANT: each barrier has its OWN independent default.
 * We never reuse barriers[0] (the OVER value) as the UNDER fallback — that was a
 * prior bug that caused DIGITUNDER trades to use the OVER digit barrier when only
 * one element was supplied, silently trading the wrong digit.
 */
function extractBarriers(barriers: number[]): { overBarrier: number; underBarrier: number } {
  const overBarrier  = barriers.length > 0 ? barriers[0] : 1;  // default OVER 1  (~90% win)
  const underBarrier = barriers.length > 1 ? barriers[1] : 8;  // default UNDER 8 (~80% win) — NEVER fall back to barriers[0]
  return { overBarrier, underBarrier };
}

// ── Intelligent recovery scanner ─────────────────────────────────────────────

/**
 * Minimum win probability for an intelligent recovery setup.
 * 60% = meaningful edge above chance for digit contracts (~50% theoretical).
 */
const SMART_RECOVERY_MIN_WIN_P = 0.60;

/**
 * Full-universe intelligent recovery scanner — activated after 2+ consecutive
 * recovery losses. Scans all markets for the best opportunity using the user's
 * configured contract family, with tiered fallbacks.
 *
 * PRIORITY ORDER (strict tiers — only falls to the next tier if the current has zero candidates):
 *   1. OVER/UNDER on any market — but ONLY barriers with equal or better payout
 *      than what the user configured in recovery settings:
 *        • OVER: barriers ≥ user's recoveryOverBarrier (higher barrier = higher payout)
 *        • UNDER: barriers ≤ user's recoveryUnderBarrier (lower barrier = higher payout)
 *      This means we may switch markets, but never trade a weaker payout than the user chose.
 *   2. EVEN/ODD — only if no OVER/UNDER candidate passes
 *   3. DIGITMATCH — only if EVEN/ODD also finds nothing
 *   ✗ DIGITDIFF and RISE/FALL are never used — they over-expose capital.
 *
 * Each candidate must pass ALL of:
 *   1. winProbability ≥ 60% in BOTH the 50-tick AND 150-tick window
 *   2. Positive expected value (EV > 0)
 *   3. Window consistency: |score_50 − score_150| ≤ 15 — rules out noise spikes
 *
 * Within each tier, sorted by EV — maximises debt recovery speed.
 */
async function findSafestRecoverySetup(
  recoveryBarriers: number[],
  allowedContractTypes: SpeedContractType[],
): Promise<MarketScore | null> {
  const { overBarrier: userOverBarrier, underBarrier: userUnderBarrier } = extractBarriers(recoveryBarriers);

  // Only barriers with SAME OR BETTER payout than user's configured:
  // OVER: higher barrier = higher payout, so allow same or higher
  // UNDER: lower barrier = higher payout, so allow same or lower
  const OVER_BARRIERS  = ([4, 5, 6, 7, 8] as const).filter(b => b >= userOverBarrier);
  const UNDER_BARRIERS = ([5, 4, 3, 2, 1] as const).filter(b => b <= userUnderBarrier);

  // Respect the user's chosen recovery families — only scan what they enabled
  const wantOver  = allowedContractTypes.includes("DIGITOVER");
  const wantUnder = allowedContractTypes.includes("DIGITUNDER");
  const wantEven  = allowedContractTypes.includes("DIGITEVEN");
  const wantOdd   = allowedContractTypes.includes("DIGITODD");
  const wantMatch = allowedContractTypes.includes("DIGITMATCH");

  // This function only analyses digit markets — if the user chose Rise/Fall only,
  // we cannot do dual-window digit validation so return null and let the regular
  // recovery path handle it.
  if (!wantOver && !wantUnder && !wantEven && !wantOdd && !wantMatch) return null;

  const rankByEV = (arr: MarketScore[]) =>
    arr.sort((a, b) =>
      (b.winProbability * (b.payout - 1) - (1 - b.winProbability)) -
      (a.winProbability * (a.payout - 1) - (1 - a.winProbability))
    );

  const tier1: MarketScore[] = [];  // OVER / UNDER
  const tier2: MarketScore[] = [];  // EVEN / ODD
  const tier3: MarketScore[] = [];  // DIGITMATCH

  for (const market of DERIV_MARKETS) {
    if (!market.digitEnabled) continue;

    // Two independent time windows for dual-consensus validation
    const digits50  = tickManager.getDigits(market.symbol, 50);
    const digits150 = tickManager.getDigits(market.symbol, 150);
    // Skip markets without enough tick data in both windows
    if (digits50.length < 40 || digits150.length < 80) continue;

    // ── Tier 1: OVER barriers (same or better payout than user's setting) ─────
    if (wantOver) {
      for (const b of OVER_BARRIERS) {
        const s50  = scoreMarket(market.symbol, market.displayName, "DIGITOVER", b, digits50,  []);
        const s150 = scoreMarket(market.symbol, market.displayName, "DIGITOVER", b, digits150, []);
        if (!s50 || !s150) continue;
        if (s50.winProbability  < SMART_RECOVERY_MIN_WIN_P) continue;
        if (s150.winProbability < SMART_RECOVERY_MIN_WIN_P) continue;
        if (Math.abs(s50.score - s150.score) > 15) continue;
        const winP = Math.min(s50.winProbability, s150.winProbability);
        const ev   = winP * (s50.payout - 1) - (1 - winP);
        if (ev <= 0) continue;
        tier1.push({
          ...s50,
          score: Math.round((s50.score + s150.score) / 2),
          winProbability: winP,
          reason: `AI recovery OVER ${b} on ${market.displayName}: ${(winP*100).toFixed(1)}% consensus (50+150t), EV${ev>=0?"+":""}${(ev*100).toFixed(1)}%`,
        });
      }
    }

    // ── Tier 1: UNDER barriers (same or better payout than user's setting) ────
    if (wantUnder) {
      for (const b of UNDER_BARRIERS) {
        const s50  = scoreMarket(market.symbol, market.displayName, "DIGITUNDER", b, digits50,  []);
        const s150 = scoreMarket(market.symbol, market.displayName, "DIGITUNDER", b, digits150, []);
        if (!s50 || !s150) continue;
        if (s50.winProbability  < SMART_RECOVERY_MIN_WIN_P) continue;
        if (s150.winProbability < SMART_RECOVERY_MIN_WIN_P) continue;
        if (Math.abs(s50.score - s150.score) > 15) continue;
        const winP = Math.min(s50.winProbability, s150.winProbability);
        const ev   = winP * (s50.payout - 1) - (1 - winP);
        if (ev <= 0) continue;
        tier1.push({
          ...s50,
          score: Math.round((s50.score + s150.score) / 2),
          winProbability: winP,
          reason: `AI recovery UNDER ${b} on ${market.displayName}: ${(winP*100).toFixed(1)}% consensus (50+150t), EV${ev>=0?"+":""}${(ev*100).toFixed(1)}%`,
        });
      }
    }

    // ── Tier 2: EVEN / ODD ────────────────────────────────────────────────────
    if (wantEven || wantOdd) {
      for (const ct of ["DIGITEVEN", "DIGITODD"] as const) {
        if (ct === "DIGITEVEN" && !wantEven) continue;
        if (ct === "DIGITODD"  && !wantOdd)  continue;
        const e50  = scoreMarket(market.symbol, market.displayName, ct, undefined, digits50,  []);
        const e150 = scoreMarket(market.symbol, market.displayName, ct, undefined, digits150, []);
        if (!e50 || !e150) continue;
        if (e50.winProbability  < SMART_RECOVERY_MIN_WIN_P) continue;
        if (e150.winProbability < SMART_RECOVERY_MIN_WIN_P) continue;
        if (Math.abs(e50.score - e150.score) > 15) continue;
        const winP = Math.min(e50.winProbability, e150.winProbability);
        const ev   = winP * (e50.payout - 1) - (1 - winP);
        if (ev <= 0) continue;
        tier2.push({
          ...e50,
          score: Math.round((e50.score + e150.score) / 2),
          winProbability: winP,
          reason: `AI recovery ${ct} on ${market.displayName}: ${(winP*100).toFixed(1)}% consensus (50+150t), EV${ev>=0?"+":""}${(ev*100).toFixed(1)}%`,
        });
      }
    }

    // ── Tier 3: DIGITMATCH with AI-chosen hottest digit ───────────────────────
    if (wantMatch) {
      const freq150 = digitFrequency(digits150);
      const hotDigit = pickMatchDiffBarrier(freq150, "DIGITMATCH");
      const m50  = scoreMarket(market.symbol, market.displayName, "DIGITMATCH", hotDigit, digits50,  []);
      const m150 = scoreMarket(market.symbol, market.displayName, "DIGITMATCH", hotDigit, digits150, []);
      if (m50 && m150 &&
          m50.winProbability  >= SMART_RECOVERY_MIN_WIN_P &&
          m150.winProbability >= SMART_RECOVERY_MIN_WIN_P &&
          Math.abs(m50.score - m150.score) <= 15) {
        const winP = Math.min(m50.winProbability, m150.winProbability);
        const ev   = winP * (m50.payout - 1) - (1 - winP);
        if (ev > 0) {
          tier3.push({
            ...m50,
            score: Math.round((m50.score + m150.score) / 2),
            winProbability: winP,
            reason: `AI recovery MATCH digit ${hotDigit} on ${market.displayName}: ${(winP*100).toFixed(1)}% consensus (50+150t), EV${ev>=0?"+":""}${(ev*100).toFixed(1)}%`,
          });
        }
      }
    }
  }

  // Return best EV from the highest-priority tier that has any candidates.
  // Tiers are strict: EVEN/ODD is only considered if OVER/UNDER found nothing.
  if (tier1.length > 0) return rankByEV(tier1)[0]!;
  if (tier2.length > 0) return rankByEV(tier2)[0]!;
  if (tier3.length > 0) return rankByEV(tier3)[0]!;
  return null;
}

export async function analyzeMarketsForStrategy(
  contractTypes: SpeedContractType[],
  barriers: number[],
): Promise<MarketScore[]> {
  const scored: MarketScore[] = [];
  const { overBarrier, underBarrier } = extractBarriers(barriers);

  for (const market of DERIV_MARKETS) {
    if (!market.digitEnabled && contractTypes.some(ct => ct.startsWith("DIGIT"))) continue;
    const digits = tickManager.getDigits(market.symbol, 200);
    const prices = tickManager.getTicks(market.symbol, 100);

    for (const ct of contractTypes) {
      if (ct === "DIGITOVER") {
        // Always use the exact OVER barrier the user set — never auto-pick
        const s = scoreMarket(market.symbol, market.displayName, ct, overBarrier, digits, prices);
        if (s) scored.push(s);
      } else if (ct === "DIGITUNDER") {
        // Always use the exact UNDER barrier the user set — never auto-pick
        const s = scoreMarket(market.symbol, market.displayName, ct, underBarrier, digits, prices);
        if (s) scored.push(s);
      } else if (ct === "DIGITMATCH" || ct === "DIGITDIFF") {
        const freq = digitFrequency(digits);
        const b = pickMatchDiffBarrier(freq, ct);
        const s = scoreMarket(market.symbol, market.displayName, ct, b, digits, prices);
        if (s) scored.push(s);
      } else {
        const s = scoreMarket(market.symbol, market.displayName, ct, undefined, digits, prices);
        if (s) scored.push(s);
      }
    }
  }

  return scored.sort((a, b) => b.score - a.score);
}

/**
 * Score a single market symbol across the given contract types and return the best setup.
 * Barriers are the exact values the user configured — never substituted or auto-picked for OVER/UNDER.
 */
export async function scoreSingleMarket(
  symbol: string,
  displayName: string,
  contractTypes: SpeedContractType[],
  barriers: number[],
): Promise<MarketScore | null> {
  const digits = tickManager.getDigits(symbol, 200);
  const prices = tickManager.getTicks(symbol, 100);
  const scored: MarketScore[] = [];
  const { overBarrier, underBarrier } = extractBarriers(barriers);

  for (const ct of contractTypes) {
    if (ct === "DIGITOVER") {
      const s = scoreMarket(symbol, displayName, ct, overBarrier, digits, prices);
      if (s) scored.push(s);
    } else if (ct === "DIGITUNDER") {
      const s = scoreMarket(symbol, displayName, ct, underBarrier, digits, prices);
      if (s) scored.push(s);
    } else if (ct === "DIGITMATCH" || ct === "DIGITDIFF") {
      const freq = digitFrequency(digits);
      const b = pickMatchDiffBarrier(freq, ct);
      const s = scoreMarket(symbol, displayName, ct, b, digits, prices);
      if (s) scored.push(s);
    } else {
      const s = scoreMarket(symbol, displayName, ct, undefined, digits, prices);
      if (s) scored.push(s);
    }
  }

  return scored.sort((a, b) => b.score - a.score)[0] ?? null;
}

/**
 * Scan ALL markets for both normal and recovery contract settings, then return
 * the single best market ranked by a weighted combined score (recovery weighted 60%,
 * normal 40% — recovery is where losses compound so it matters more).
 *
 * No skip logic: every market in DERIV_MARKETS is evaluated regardless of
 * digitEnabled — scoreMarket already returns null when insufficient data exists.
 *
 * Broadcasts SSE "speed_ai_scan_progress" events as each market is evaluated so
 * the frontend can animate the scan progress in real time.
 */
export async function scanBestMarket(config: SpeedAIConfig): Promise<ScanResult> {
  const candidatesBySymbol = new Map<string, MarketScore>();
  const total = DERIV_MARKETS.length;
  let scanned = 0;

  for (const market of DERIV_MARKETS) {
    // Emit: this market is now being analyzed
    broadcastSSE("speed_ai_scan_progress", {
      scanning: market.displayName,
      symbol: market.symbol,
      scanned,
      total,
      results: [...candidatesBySymbol.values()].sort((a, b) => b.score - a.score),
    });

    // Score normal contracts on this market
    const normalBest = await scoreSingleMarket(
      market.symbol, market.displayName,
      config.normalContractTypes, config.normalBarriers,
    );

    // Score recovery contracts on this market
    const recoveryBest = await scoreSingleMarket(
      market.symbol, market.displayName,
      config.recoveryContractTypes, config.recoveryBarriers,
    );

    scanned++;

    // Deliberate pause per market so the scan feels real-time to the user
    // and each market's SSE event reaches the frontend before the next one fires.
    await sleep(280);

    if (!normalBest && !recoveryBest) continue;

    const normalScore  = normalBest?.score  ?? 0;
    const recoveryScore = recoveryBest?.score ?? 0;
    // Weight recovery 60% — that's where losses compound and correct positioning matters most
    const combinedScore = Math.round((normalScore * 0.4 + recoveryScore * 0.6) * 10) / 10;

    const base = normalBest ?? recoveryBest!;
    candidatesBySymbol.set(market.symbol, {
      ...base,
      score:               combinedScore,
      normalScore:         Math.round(normalScore  * 10) / 10,
      recoveryScore:       Math.round(recoveryScore * 10) / 10,
      recoveryContractType: recoveryBest?.contractType,
      recoveryBarrier:     recoveryBest?.barrier,
    });
  }

  // Final progress — scan complete
  const allScored = [...candidatesBySymbol.values()].sort((a, b) => b.score - a.score);
  broadcastSSE("speed_ai_scan_progress", {
    scanning: null,
    symbol: null,
    scanned: total,
    total,
    results: allScored,
  });

  if (allScored.length === 0) {
    return {
      suitable: false,
      best: null,
      allScored: [],
      reason: "No tick data available yet — wait a few seconds and scan again",
    };
  }

  const best = allScored[0];
  const suitable = best.score >= SUITABLE_SCORE_THRESHOLD;
  const reason = suitable
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

  // Split: progressive cap
  const stepOffset = Math.max(0, rec.recoveryStep - 1);
  const payoutImpliedMin = (1 / netPayout) * 1.05;
  const effective = Math.max(baseMultiplier, payoutImpliedMin) + stepOffset;
  const splitCap = rec.baseStake * effective;
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
      // Partial win while in recovery: clear the consecutive loss streak
      return { ...rec, unrecoveredAmount: remaining, consecutiveRecoveryLosses: 0 };
    }
    return rec;
  }
  // Loss
  if (!rec.inRecovery) {
    // First loss — entering recovery. consecutiveRecoveryLosses starts at 0
    // because the normal trade that lost is NOT a recovery trade.
    return {
      inRecovery: true,
      recoveryStep: 1,
      unrecoveredAmount: stake,
      baseStake: rec.baseStake > 0 ? rec.baseStake : stake,
      consecutiveRecoveryLosses: 0,
    };
  }
  // Already in recovery and lost again — this IS a consecutive recovery loss
  return {
    ...rec,
    recoveryStep: Math.min(rec.recoveryStep + 1, Math.max(1, maxSteps)),
    unrecoveredAmount: rec.unrecoveredAmount + stake,
    consecutiveRecoveryLosses: rec.consecutiveRecoveryLosses + 1,
  };
}

// ── Sleep helper ──────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── Broadcast helper ──────────────────────────────────────────────────────────

function broadcast() {
  broadcastSSE("speed_ai_update", getStatus());
}

// ── Public API ────────────────────────────────────────────────────────────────

export function getStatus(): SpeedAIStatus {
  return {
    running: session.running,
    sessionId: session.sessionId,
    totalProfit: Math.round(session.totalProfit * 100) / 100,
    tradeCount: session.tradeCount,
    winCount: session.winCount,
    lossCount: session.lossCount,
    currentStake: session.currentStake,
    inRecovery: session.recovery.inRecovery,
    recoveryStep: session.recovery.recoveryStep,
    unrecoveredAmount: Math.round(session.recovery.unrecoveredAmount * 100) / 100,
    consecutiveRecoveryLosses: session.recovery.consecutiveRecoveryLosses,
    currentMarket: session.currentMarket,
    currentContractType: session.currentContractType,
    lastResult: session.lastResult,
    config: session.config ?? undefined,
    message: session.message,
    topMarkets: session.topMarkets.slice(0, 6),
  };
}

export function stopSession() {
  session.stopRequested = true;
  session.running = false;
  session.message = "Session stopped by user";
  broadcast();
  logger.info("SpeedAI session stop requested");
}

export async function startSession(config: SpeedAIConfig): Promise<{ ok: boolean; error?: string }> {
  if (session.running) return { ok: false, error: "A SpeedAI session is already running" };

  // Validate config
  if (config.stake < 0.35) return { ok: false, error: "Minimum stake is $0.35" };
  if (config.stopLoss <= 0) return { ok: false, error: "Stop loss must be positive" };
  if (config.takeProfit <= 0) return { ok: false, error: "Take profit must be positive" };
  if (config.normalContractTypes.length === 0) return { ok: false, error: "Select at least one normal contract type" };
  if (config.recoveryContractTypes.length === 0) return { ok: false, error: "Select at least one recovery contract type" };

  session = {
    running: true,
    sessionId: `spd_${Date.now()}`,
    config,
    totalProfit: 0,
    tradeCount: 0,
    winCount: 0,
    lossCount: 0,
    currentStake: config.stake,
    recovery: { inRecovery: false, recoveryStep: 0, unrecoveredAmount: 0, baseStake: config.stake, consecutiveRecoveryLosses: 0 },
    topMarkets: [],
    stopRequested: false,
    message: "Analyzing markets…",
  };

  logger.info({ config }, "SpeedAI session starting");
  broadcast();

  // Run the loop in the background (fire-and-forget)
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
  const accounts = await db.select().from(accountsTable).limit(1);
  const settings = await db.select().from(settingsTable).limit(1);
  const paperTradeMode = settings.length > 0 ? (settings[0] as any).paperTradeMode ?? false : false;
  const token = getCachedToken() ?? (accounts.length > 0 ? accounts[0].token ?? null : null);
  const currency = accounts.length > 0 ? accounts[0].currency : "USD";
  const isLive = !paperTradeMode && !!token;
  const maxStake = settings.length > 0 ? Number(settings[0].maxTradeStake) : 500;

  // Resolve the locked market object once (if symbol is locked)
  const lockedDerivsMarket = config.lockedSymbol
    ? DERIV_MARKETS.find(m => m.symbol === config.lockedSymbol) ?? null
    : null;

  // Guard: if a lock was requested but the symbol isn't in DERIV_MARKETS, abort immediately
  if (config.lockedSymbol && !lockedDerivsMarket) {
    session.running = false;
    session.message = `⚠️ Market ${config.lockedSymbol} not found — session aborted`;
    broadcast();
    logger.error({ symbol: config.lockedSymbol }, "SpeedAI locked symbol not found in DERIV_MARKETS");
    return;
  }

  // ── Execution latency tracker ──────────────────────────────────────────────
  // Exponential moving average of round-trip time from proposal to settlement.
  // Logged every trade so timing regressions are visible in server logs.
  let avgExecLatencyMs = 800;

  // ── Pre-analyzed result cache ──────────────────────────────────────────────
  // Market analysis is kicked off in parallel with the post-trade sleep so the
  // next iteration can start executing immediately without waiting for scan time.
  // Null means the next iteration must scan fresh.
  let preAnalyzedScored: MarketScore[] | null = null;

  while (session.running && !session.stopRequested) {
    // ── Determine trade mode (normal vs recovery) ──────────────────────────
    const inRecovery = session.recovery.inRecovery;
    const contractTypes = inRecovery ? config.recoveryContractTypes : config.normalContractTypes;
    const barriers = inRecovery ? config.recoveryBarriers : config.normalBarriers;

    // ── Find best setup ────────────────────────────────────────────────────
    let best: MarketScore | undefined;

    if (lockedDerivsMarket) {
      // Locked market mode — use pre-analyzed if it covers this symbol
      const cached = preAnalyzedScored?.find(m => m.symbol === lockedDerivsMarket.symbol);
      preAnalyzedScored = null;

      if (cached) {
        best = cached;
      } else {
        const result = await scoreSingleMarket(
          lockedDerivsMarket.symbol,
          lockedDerivsMarket.displayName,
          contractTypes,
          barriers,
        );
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
      // Free scan mode — use pre-analyzed batch if available
      if (preAnalyzedScored) {
        const scored = preAnalyzedScored;
        preAnalyzedScored = null;
        session.topMarkets = scored;
        if (scored.length === 0) {
          session.message = "No markets available — waiting for tick data…";
          broadcast();
          await sleep(3000);
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
        best = scored[0];
      }
    }

    // ── Consecutive recovery loss gate ────────────────────────────────────────
    // After 2 consecutive losses while in recovery the AI takes full control:
    // it runs findSafestRecoverySetup(), which scans EVERY contract type ×
    // barrier × market with dual-window (50t + 150t) consensus validation.
    // The AI scans ONLY within the user's chosen recovery contract families —
    // the user is always in control of which contract types are used.
    let intelligentRecoveryOverride = false;

    if (inRecovery && session.recovery.consecutiveRecoveryLosses >= 2) {
      session.message = `⚡ ${session.recovery.consecutiveRecoveryLosses} recovery losses — AI scanning all markets within your selected recovery types…`;
      broadcast();
      logger.warn(
        { consecutiveRecoveryLosses: session.recovery.consecutiveRecoveryLosses, symbol: best.symbol },
        "SpeedAI intelligent recovery gate triggered",
      );

      // Stabilisation pause — let the market breathe before fresh analysis
      await sleep(3000);
      if (!session.running || session.stopRequested) break;

      // Run the intelligent scanner — restricted to user's chosen recovery contract types
      const smartSetup = await findSafestRecoverySetup(barriers, config.recoveryContractTypes);

      if (smartSetup) {
        best = smartSetup;
        intelligentRecoveryOverride = true; // AI has full control of contract + barrier
        session.topMarkets = [smartSetup];
        logger.info(
          {
            symbol: best.symbol,
            contractType: best.contractType,
            barrier: best.barrier,
            winProbability: best.winProbability,
            score: best.score,
            consecutiveRecoveryLosses: session.recovery.consecutiveRecoveryLosses,
          },
          "SpeedAI intelligent recovery: AI-selected safest setup across all markets",
        );
      } else {
        // Nothing passes 60% dual-window consensus — wait for markets to evolve
        session.message = `⏸ No high-confidence recovery setup found — waiting for markets to settle…`;
        broadcast();
        await sleep(5000);
        continue;
      }
    }

    const stake = Math.round(computeRecoveryStake(session.recovery, best.payout, config, maxStake) * 100) / 100;

    session.currentMarket = best.displayName;
    session.currentContractType = best.contractType + (best.barrier !== undefined ? ` ${best.barrier}` : "");
    session.currentStake = stake;
    session.message = `Trading ${best.contractType}${best.barrier !== undefined ? ` ${best.barrier}` : ""} on ${best.displayName}`;
    broadcast();

    // ── Execute trade ──────────────────────────────────────────────────────
    const execStart = Date.now();
    let won: boolean;
    let profit: number;

    if (isLive) {
      try {
        // ── Barrier validation ────────────────────────────────────────────────
        // During normal trading, enforce the user's configured barriers so no
        // accidental drift sneaks through. Skip enforcement when the intelligent
        // recovery override is active — the AI has deliberately chosen a different
        // barrier and overriding it back would defeat the whole purpose.
        if (!intelligentRecoveryOverride) {
          const { overBarrier: cfgOver, underBarrier: cfgUnder } = extractBarriers(barriers);
          if (best.contractType === "DIGITOVER" && best.barrier !== cfgOver) {
            logger.error({ expected: cfgOver, actual: best.barrier, contractType: "DIGITOVER" },
              "SpeedAI barrier mismatch — forcing configured OVER barrier");
            best = { ...best, barrier: cfgOver };
          }
          if (best.contractType === "DIGITUNDER" && best.barrier !== cfgUnder) {
            logger.error({ expected: cfgUnder, actual: best.barrier, contractType: "DIGITUNDER" },
              "SpeedAI barrier mismatch — forcing configured UNDER barrier");
            best = { ...best, barrier: cfgUnder };
          }
        }

        logger.info({
          symbol: best.symbol,
          contractType: best.contractType,
          barrier: best.barrier,
          stake: Math.round(stake * 100) / 100,
          inRecovery,
          consecutiveRecoveryLosses: session.recovery.consecutiveRecoveryLosses,
          intelligentRecoveryOverride,
        }, intelligentRecoveryOverride ? "SpeedAI executing AI-selected recovery trade" : "SpeedAI executing trade with exact user barriers");

        const liveResult = await executeLiveTrade(token!, {
          symbol: best.symbol,
          contractType: best.contractType,
          stake: Math.round(stake * 100) / 100,
          duration: 1,
          durationUnit: "t",
          currency,
          barrier: best.barrier,
        });
        const result = await waitForContractResult(token!, liveResult.contractId, 30_000);
        won = result.won;
        profit = result.profit;
      } catch (err) {
        logger.warn({ err, symbol: best.symbol }, "SpeedAI live trade failed — skipping");
        session.message = `Trade failed: ${err instanceof Error ? err.message : String(err)} — retrying…`;
        broadcast();
        await sleep(2000);
        continue;
      }
    } else {
      // Paper/demo simulation
      won = Math.random() < best.winProbability;
      profit = won ? stake * (best.payout - 1) : -stake;
    }

    // ── Track execution latency ────────────────────────────────────────────
    const execLatencyMs = Date.now() - execStart;
    avgExecLatencyMs = Math.round(avgExecLatencyMs * 0.7 + execLatencyMs * 0.3);
    if (isLive) {
      logger.info(
        { execLatencyMs, avgExecLatencyMs, symbol: best.symbol, contractType: best.contractType },
        "SpeedAI 1-tick execution latency",
      );
    }

    // ── Record outcome ─────────────────────────────────────────────────────
    session.tradeCount++;
    session.totalProfit = Math.round((session.totalProfit + profit) * 100) / 100;
    if (won) { session.winCount++; session.lastResult = "won"; }
    else      { session.lossCount++; session.lastResult = "lost"; }

    session.recovery = recordRecoveryOutcome(session.recovery, won, profit, stake, config.maxRecoverySteps);

    // Sync live balance
    if (isLive) {
      try {
        const newBal = await getLiveBalance(token!);
        if (newBal !== null && accounts.length > 0) {
          const { db: _db, accountsTable: at } = await import("@workspace/db");
          const { eq } = await import("drizzle-orm");
          await _db.update(at).set({ balance: String(newBal), updatedAt: new Date() }).where(eq(at.id, accounts[0].id));
        }
      } catch { /* best-effort */ }
    }

    // Broadcast immediately — zero delay between trade result and UI update
    broadcast();

    // ── Check TP / SL ──────────────────────────────────────────────────────
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
    // Max recovery steps reached → cap the multiplier at the last step stake but
    // keep trading until SL or TP is hit.
    if (session.recovery.inRecovery && session.recovery.recoveryStep >= config.maxRecoverySteps) {
      session.message = `⚡ Recovery step ${config.maxRecoverySteps} — holding stake until debt cleared`;
      broadcast();
    }

    // ── Pre-analyze next trade while pausing ──────────────────────────────────
    // Kick off the next market scan in the background so the next iteration can
    // execute immediately with a fresh result instead of waiting for analysis time.
    // This effectively removes scan latency from the critical path on every trade.
    //
    // Skip pre-analysis when the consecutive recovery gate will fire next iteration
    // (it forces its own deep scan — pre-analyzed result would be discarded anyway).
    const nextInRecovery = session.recovery.inRecovery;
    const nextContractTypes = nextInRecovery ? config.recoveryContractTypes : config.normalContractTypes;
    const nextBarriers = nextInRecovery ? config.recoveryBarriers : config.normalBarriers;
    const willTriggerGate = nextInRecovery && session.recovery.consecutiveRecoveryLosses >= 2;

    // Pause duration: shorter than before because analysis overlaps with it.
    // The 500 ms gives the Deriv WS a moment before the next proposal, while
    // the pre-analysis completes in the background.
    const pauseMs = isLive ? 500 : 300;

    if (!willTriggerGate) {
      const preAnalyzePromise = lockedDerivsMarket
        ? scoreSingleMarket(lockedDerivsMarket.symbol, lockedDerivsMarket.displayName, nextContractTypes, nextBarriers)
            .then(r => r ? [r] : [])
        : analyzeMarketsForStrategy(nextContractTypes, nextBarriers);

      await sleep(pauseMs);
      if (!session.running || session.stopRequested) break;

      // Collect the pre-analyzed result; errors are non-fatal (next iteration scans fresh)
      try {
        const result = await preAnalyzePromise;
        preAnalyzedScored = result.length > 0 ? result : null;
      } catch {
        preAnalyzedScored = null;
      }
    } else {
      // Gate will handle its own deep scan — just wait
      await sleep(pauseMs);
      preAnalyzedScored = null;
    }
  }

  if (!session.running && !session.message?.startsWith("✅") && !session.message?.startsWith("🛑") && !session.message?.startsWith("⚠️")) {
    session.message = "Session stopped";
    broadcast();
  }
}

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

// ── Recovery minimum score threshold ─────────────────────────────────────────
// Recovery trades require a higher quality floor than normal trades (MIN_TRADE_SCORE=50).
const MIN_RECOVERY_SCORE = 55;

// ── Recovery candidate returned by deepRecoveryGate ───────────────────────────
interface RecoveryCandidate {
  contractType: SpeedContractType;
  barrier:      number | undefined;
  payout:       number;
  /** Minimum win probability across all 3 tick windows — the conservative estimate */
  minWinP:      number;
  /** Average score across all 3 windows */
  avgScore:     number;
  /** Score range (max − min across windows); lower = pattern is stable, not a noise spike */
  spread:       number;
  /** Expected value using minWinP — guarantees positive EV even in the worst window */
  ev:           number;
  /** Fraction of the last 8 ticks that already satisfy the prediction (0–1) */
  momentumScore: number;
  /** Final ranking metric combining the above */
  compositeScore: number;
  reason:       string;
}

/**
 * Fraction of the last `window` digits that satisfy the prediction.
 * Measures short-term momentum — the market should be behaving in our favour
 * RIGHT NOW, not just on a 150-tick statistical average.
 */
function momentumAlignment(
  digits: number[],
  contractType: SpeedContractType,
  barrier: number | undefined,
  window = 8,
): number {
  const recent = digits.slice(-window);
  if (recent.length < 4) return 0.5; // insufficient data — neutral
  let hits = 0;
  for (const d of recent) {
    switch (contractType) {
      case "DIGITOVER":  if (barrier !== undefined && d >  barrier) hits++; break;
      case "DIGITUNDER": if (barrier !== undefined && d <  barrier) hits++; break;
      case "DIGITEVEN":  if (d % 2 === 0)                          hits++; break;
      case "DIGITODD":   if (d % 2 !== 0)                          hits++; break;
      case "DIGITMATCH": if (barrier !== undefined && d === barrier) hits++; break;
      case "DIGITDIFF":  if (barrier !== undefined && d !== barrier) hits++; break;
    }
  }
  return hits / recent.length;
}

/**
 * Deep multi-window consensus gate for recovery trades.
 *
 * Scores every valid barrier within the user's chosen recovery contract families
 * across THREE independent tick windows (60t / 100t / 150t). A candidate passes
 * only when ALL THREE windows agree on the edge AND recent momentum confirms the
 * pattern is active RIGHT NOW.
 *
 * Advantages over the old single-window + 3-tick check:
 *  • 60t window catches pattern shifts that 150t alone misses
 *  • "spread" gate filters noise spikes — if windows disagree, we wait
 *  • Barrier sweep finds the BEST entry within the family (not just configured)
 *  • Thresholds scale up automatically after consecutive losses
 *
 * Threshold ladder:
 *   0 consecutive losses → minWinP 0.54, maxSpread 22, minMomentum 0.43
 *   1 loss               → minWinP 0.57, maxSpread 18, minMomentum 0.50
 *   2+ losses            → minWinP 0.61, maxSpread 14, minMomentum 0.56
 *
 * Returns the highest-ranked candidate, or null if none pass all gates.
 */
function deepRecoveryGate(
  symbol:           string,
  displayName:      string,
  contractTypes:    SpeedContractType[],
  configBarriers:   number[],
  consecutiveLosses: number,
): RecoveryCandidate | null {
  // Adaptive thresholds — tighter after each consecutive recovery loss
  const minWinP     = consecutiveLosses >= 2 ? 0.61 : consecutiveLosses >= 1 ? 0.57 : 0.54;
  const maxSpread   = consecutiveLosses >= 2 ? 14   : consecutiveLosses >= 1 ? 18   : 22;
  const minMomentum = consecutiveLosses >= 2 ? 0.56 : consecutiveLosses >= 1 ? 0.50 : 0.43;

  const digits60  = tickManager.getDigits(symbol, 60);
  const digits100 = tickManager.getDigits(symbol, 100);
  const digits150 = tickManager.getDigits(symbol, 150);

  // All three windows need sufficient data (scoreMarket requires ≥50 for DIGIT contracts)
  if (digits60.length < 45 || digits100.length < 70 || digits150.length < 90) return null;

  const candidates: RecoveryCandidate[] = [];

  for (const ct of contractTypes) {
    // Build the barrier sweep list for this contract type
    let barriersToTry: Array<number | undefined>;

    if (ct === "DIGITOVER") {
      // Search ALL valid OVER barriers — gate picks the one with best 3-window consensus
      barriersToTry = [0, 1, 2, 3, 4, 5, 6, 7, 8];
    } else if (ct === "DIGITUNDER") {
      barriersToTry = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    } else if (ct === "DIGITMATCH" || ct === "DIGITDIFF") {
      // Auto-select hottest / coldest digit from the 150-tick baseline
      const freq = digitFrequency(digits150);
      barriersToTry = [pickMatchDiffBarrier(freq, ct)];
    } else {
      barriersToTry = [undefined]; // DIGITEVEN / DIGITODD / CALL / PUT — no barrier
    }

    for (const b of barriersToTry) {
      // Score each window independently using the same scoreMarket function
      const s60  = scoreMarket(symbol, displayName, ct, b, digits60,  []);
      const s100 = scoreMarket(symbol, displayName, ct, b, digits100, []);
      const s150 = scoreMarket(symbol, displayName, ct, b, digits150, []);
      if (!s60 || !s100 || !s150) continue;

      const minWP  = Math.min(s60.winProbability, s100.winProbability, s150.winProbability);
      const avgSc  = (s60.score + s100.score + s150.score) / 3;
      const spread = Math.max(s60.score, s100.score, s150.score)
                   - Math.min(s60.score, s100.score, s150.score);
      const payout = s150.payout;
      const ev     = minWP * (payout - 1) - (1 - minWP); // EV using conservative (lowest) winP

      // ── Gate battery — every condition must pass ───────────────────────────
      if (minWP  < minWinP)          continue; // all 3 windows must agree on edge strength
      if (spread > maxSpread)        continue; // reject unstable patterns / noise spikes
      if (ev     <= 0)               continue; // must have positive EV even in worst window
      if (avgSc  < MIN_RECOVERY_SCORE) continue; // quality floor

      // Momentum: what fraction of the last 8 ticks already satisfies the bet
      const momentum = momentumAlignment(digits150, ct, b, 8);
      if (momentum < minMomentum) continue; // market must be aligned RIGHT NOW

      // Composite ranking: min win probability weighted most, then stability, then momentum
      const composite = minWP * 0.50 + (1 - spread / 100) * 0.25 + momentum * 0.25;

      candidates.push({
        contractType:   ct,
        barrier:        b,
        payout,
        minWinP:        minWP,
        avgScore:       avgSc,
        spread,
        ev,
        momentumScore:  momentum,
        compositeScore: composite,
        reason: `${ct}${b !== undefined ? ` ${b}` : ""} — ${(minWP * 100).toFixed(1)}% min-consensus (60/100/150t), momentum ${(momentum * 100).toFixed(0)}%, spread ${spread.toFixed(0)}, EV${ev >= 0 ? "+" : ""}${(ev * 100).toFixed(1)}%`,
      });
    }
  }

  if (candidates.length === 0) return null;

  // Pick highest composite score
  candidates.sort((a, b) => b.compositeScore - a.compositeScore);
  return candidates[0]!;
}

export async function analyzeMarketsForStrategy(
  contractTypes: SpeedContractType[],
  barriers: number[],
): Promise<MarketScore[]> {
  const scored: MarketScore[] = [];
  const { overBarrier, underBarrier } = extractBarriers(barriers);

  for (const market of DERIV_MARKETS) {
    if (!market.digitEnabled && contractTypes.some(ct => ct.startsWith("DIGIT"))) continue;

    // ── Dual-window tick data ──────────────────────────────────────────────────
    // Primary (150-tick): stable, representative signal.
    // Recent  ( 50-tick): short-term check — catches regime changes the longer
    //                     window would absorb but which make the bet riskier NOW.
    const digits150 = tickManager.getDigits(market.symbol, 150);
    const digits50  = tickManager.getDigits(market.symbol, 50);
    const prices    = tickManager.getTicks(market.symbol, 100);
    // Fall back to a combined 200-tick read when we don't have enough for both windows
    const digitsMain = digits150.length >= 80 ? digits150 : tickManager.getDigits(market.symbol, 200);

    for (const ct of contractTypes) {
      let barrier: number | undefined;
      if (ct === "DIGITOVER") {
        barrier = overBarrier;
      } else if (ct === "DIGITUNDER") {
        barrier = underBarrier;
      } else if (ct === "DIGITMATCH" || ct === "DIGITDIFF") {
        // Barrier selection on the more stable long window
        const freq = digitFrequency(digitsMain);
        barrier = pickMatchDiffBarrier(freq, ct);
      }

      // Primary score on the main (longer) window
      const s = scoreMarket(market.symbol, market.displayName, ct, barrier, digitsMain, prices);
      if (!s) continue;

      // ── Window consistency cross-check ─────────────────────────────────────
      // When we have enough ticks for both windows, compare the short-term signal
      // against the long-term baseline.  A big disagreement means the pattern is
      // noisy or regime-shifting — penalise the score rather than reject entirely
      // so we always have a ranked result for the fallback path.
      if (digits50.length >= 40 && digits150.length >= 80) {
        const s50 = scoreMarket(market.symbol, market.displayName, ct, barrier, digits50, prices);
        if (s50) {
          const windowDelta = Math.abs(s.score - s50.score);
          // Each point of disagreement above 10 shaves 0.6 pts from the score
          if (windowDelta > 10) {
            s.score = Math.max(0, s.score - Math.round((windowDelta - 10) * 0.6));
          }
          // Conservative blend: weight the short-term (recent) window at 40%
          s.winProbability = s.winProbability * 0.6 + s50.winProbability * 0.4;
        }
      }

      scored.push(s);
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

// ── Minimum score for a normal trade ─────────────────────────────────────────
// Trades below this threshold are skipped — a low-quality setup is more likely
// to cause a recovery spiral than produce a win. 50/100 is deliberately set at
// "meaningful edge" not "theoretical best available".
const MIN_TRADE_SCORE = 50;

// ── Live-tick pattern confirmation ────────────────────────────────────────────
/**
 * Quick sanity check on the CURRENT live digit buffer before placing a recovery
 * trade. Returns false when the last few live ticks directly contradict the
 * prediction — a signal that the pattern has not yet aligned and waiting one
 * tick cycle is safer than executing immediately.
 *
 * This is intentionally a lightweight, fast check — NOT a second full analysis.
 * It only catches the most obvious "the market is doing the exact opposite right
 * now" scenarios. The intelligent recovery scanner (dual-window) already handles
 * deeper quality validation for its candidates.
 */
function hasPatternConfirmation(
  symbol: string,
  contractType: SpeedContractType,
  barrier: number | undefined,
): boolean {
  const recent = tickManager.getDigits(symbol, 5);
  if (recent.length < 3) return true; // insufficient data — do not block

  const last3 = recent.slice(-3);

  switch (contractType) {
    case "DIGITOVER": {
      if (barrier === undefined) return true;
      // Bad sign: ALL last-3 digits were ≤ barrier (persistent low-digit pattern)
      return !last3.every(d => d <= barrier!);
    }
    case "DIGITUNDER": {
      if (barrier === undefined) return true;
      // Bad sign: ALL last-3 digits were ≥ barrier (persistent high-digit pattern)
      return !last3.every(d => d >= barrier!);
    }
    case "DIGITDIFF": {
      if (barrier === undefined) return true;
      // Bad sign: target digit appeared in BOTH of the last 2 ticks — currently very hot
      const last2 = recent.slice(-2);
      return !last2.every(d => d === barrier);
    }
    case "DIGITMATCH": {
      if (barrier === undefined) return true;
      // Bad sign: target digit has not appeared at all in the last 5 ticks — too cold
      return recent.includes(barrier!);
    }
    case "DIGITEVEN": {
      // Bad sign: ALL last-3 digits were odd (strongly odd-biased recent ticks)
      return !last3.every(d => d % 2 !== 0);
    }
    case "DIGITODD": {
      // Bad sign: ALL last-3 digits were even (strongly even-biased recent ticks)
      return !last3.every(d => d % 2 === 0);
    }
    default:
      return true;
  }
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
        // Quality floor: skip this cycle if no market meets the minimum trade score.
        // Trading a low-quality setup (< MIN_TRADE_SCORE) is more likely to cause
        // a recovery spiral than to win.
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

    // ── Recovery: deep multi-window consensus gate ────────────────────────────
    // Recovery trades go through a strict 3-window consensus check (60t/100t/150t)
    // + last-8-tick momentum alignment before executing. Normal trades use the
    // lighter hasPatternConfirmation check (sufficient for non-compounding trades).
    if (inRecovery) {
      const consLosses = session.recovery.consecutiveRecoveryLosses;
      const candidate  = deepRecoveryGate(
        best.symbol,
        best.displayName,
        config.recoveryContractTypes,
        barriers,
        consLosses,
      );

      if (!candidate) {
        // No high-confidence entry — scale wait time with consecutive losses
        const waitMs = consLosses >= 2 ? 2000 : consLosses >= 1 ? 1200 : 700;
        session.message = `⏳ Awaiting high-confidence recovery entry${consLosses > 0 ? ` (${consLosses} consec. loss${consLosses > 1 ? "es" : ""})` : ""}…`;
        broadcast();
        logger.info(
          { symbol: best.symbol, consLosses },
          "SpeedAI recovery gate: no 3-window consensus — waiting for alignment",
        );
        preAnalyzedScored = null;
        await sleep(waitMs);
        continue;
      }

      // Deep gate won — override `best` with the consensus-selected contract + barrier
      best = {
        ...best,
        contractType:   candidate.contractType,
        barrier:        candidate.barrier,
        payout:         candidate.payout,
        winProbability: candidate.minWinP,
        score:          Math.round(candidate.avgScore),
        reason:         candidate.reason,
      };

      logger.info(
        {
          symbol:        best.symbol,
          contractType:  best.contractType,
          barrier:       best.barrier,
          minWinP:       candidate.minWinP,
          spread:        candidate.spread,
          momentum:      candidate.momentumScore,
          composite:     candidate.compositeScore,
          consLosses,
        },
        "SpeedAI recovery gate: 3-window consensus passed",
      );
    } else {
      // Normal trade — lightweight directional check is sufficient
      if (!hasPatternConfirmation(best.symbol, best.contractType, best.barrier)) {
        session.message = `⏳ Pattern check: waiting for better entry on ${best.displayName}…`;
        broadcast();
        preAnalyzedScored = null;
        await sleep(1200);
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
        // Normal trades: enforce the user's configured barriers.
        // Recovery trades: deepRecoveryGate already selected the optimal barrier
        // via 3-window consensus — overriding it would defeat the analysis.
        if (!inRecovery) {
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
        }, inRecovery ? "SpeedAI executing deep-gate recovery trade" : "SpeedAI executing normal trade");

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
    const nextInRecovery = session.recovery.inRecovery;
    const nextContractTypes = nextInRecovery ? config.recoveryContractTypes : config.normalContractTypes;
    const nextBarriers = nextInRecovery ? config.recoveryBarriers : config.normalBarriers;

    // Adaptive pause duration:
    // - Win → 400 ms (fast; no recovery debt to manage)
    // - Loss → 1800 ms (market breathe time)
    const pauseMs = isLive ? (won ? 400 : 1800) : 200;

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
  }

  if (!session.running && !session.message?.startsWith("✅") && !session.message?.startsWith("🛑") && !session.message?.startsWith("⚠️")) {
    session.message = "Session stopped";
    broadcast();
  }
}

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
  recovery: { inRecovery: false, recoveryStep: 0, unrecoveredAmount: 0, baseStake: 0 },
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

export async function analyzeMarketsForStrategy(
  contractTypes: SpeedContractType[],
  barriers: number[],
): Promise<MarketScore[]> {
  const scored: MarketScore[] = [];

  for (const market of DERIV_MARKETS) {
    if (!market.digitEnabled && contractTypes.some(ct => ct.startsWith("DIGIT"))) continue;
    const digits = tickManager.getDigits(market.symbol, 200);
    const prices = tickManager.getTicks(market.symbol, 100);

    for (const ct of contractTypes) {
      if (ct === "DIGITOVER" || ct === "DIGITUNDER") {
        const barriersToTry = barriers.length > 0 ? barriers : (ct === "DIGITOVER" ? [1, 2] : [7, 8]);
        for (const b of barriersToTry) {
          const s = scoreMarket(market.symbol, market.displayName, ct, b, digits, prices);
          if (s) scored.push(s);
        }
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

  for (const ct of contractTypes) {
    if (ct === "DIGITOVER" || ct === "DIGITUNDER") {
      const barriersToTry = barriers.length > 0 ? barriers : (ct === "DIGITOVER" ? [1, 2] : [7, 8]);
      for (const b of barriersToTry) {
        const s = scoreMarket(symbol, displayName, ct, b, digits, prices);
        if (s) scored.push(s);
      }
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
        return { inRecovery: false, recoveryStep: 0, unrecoveredAmount: 0, baseStake: rec.baseStake };
      }
      return { ...rec, unrecoveredAmount: remaining };
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
    };
  }
  return {
    ...rec,
    recoveryStep: Math.min(rec.recoveryStep + 1, Math.max(1, maxSteps)),
    unrecoveredAmount: rec.unrecoveredAmount + stake,
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
    recovery: { inRecovery: false, recoveryStep: 0, unrecoveredAmount: 0, baseStake: config.stake },
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

  while (session.running && !session.stopRequested) {
    // ── Determine trade mode (normal vs recovery) ──────────────────────────
    const inRecovery = session.recovery.inRecovery;
    const contractTypes = inRecovery ? config.recoveryContractTypes : config.normalContractTypes;
    const barriers = inRecovery ? config.recoveryBarriers : config.normalBarriers;

    // ── Find best setup ────────────────────────────────────────────────────
    let best: MarketScore | undefined;

    if (lockedDerivsMarket) {
      // Locked market mode: score only the one chosen market, no full scan
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
      // Keep topMarkets updated for the display panel
      session.topMarkets = [result];
    } else {
      // Free scan mode: evaluate all markets every trade
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
    const stake = Math.round(computeRecoveryStake(session.recovery, best.payout, config, maxStake) * 100) / 100;

    session.currentMarket = best.displayName;
    session.currentContractType = best.contractType + (best.barrier !== undefined ? ` ${best.barrier}` : "");
    session.currentStake = stake;
    session.message = `Trading ${best.contractType}${best.barrier !== undefined ? ` ${best.barrier}` : ""} on ${best.displayName}`;
    broadcast();

    // ── Execute trade ──────────────────────────────────────────────────────
    let won: boolean;
    let profit: number;

    if (isLive) {
      try {
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
    // keep trading until SL or TP is hit. recordRecoveryOutcome already clamps
    // recoveryStep to maxSteps so the stake stays at that level indefinitely.
    if (session.recovery.inRecovery && session.recovery.recoveryStep >= config.maxRecoverySteps) {
      session.message = `⚡ Recovery step ${config.maxRecoverySteps} — holding stake until debt cleared`;
      broadcast();
    }

    // ── Brief pause between trades ─────────────────────────────────────────
    await sleep(isLive ? 1500 : 800);
  }

  if (!session.running && !session.message?.startsWith("✅") && !session.message?.startsWith("🛑") && !session.message?.startsWith("⚠️")) {
    session.message = "Session stopped";
    broadcast();
  }
}

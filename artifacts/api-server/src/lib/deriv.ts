/**
 * Deriv WebSocket Client + Persistent TickManager
 *
 * Architecture:
 *  - DerivTickManager maintains ONE persistent WS connection to Deriv
 *  - Subscribes to ALL synthetic market tick streams at startup
 *  - Buffers last 500 prices + last 300 digits per symbol in memory
 *  - Zero-latency data: no per-request WS opens; served from RAM
 *  - Auto-reconnects with exponential back-off
 *  - Separate one-shot WS connections for trade execution / auth
 */

import WebSocket from "ws";
import { EventEmitter } from "events";
import { logger } from "./logger";

// Deriv public tester app_id=1089 — required for demo API tokens
const rawAppId = process.env["DERIV_APP_ID"] ?? "1089";
export const APP_ID = /^\d+$/.test(rawAppId) ? rawAppId : "1089";
if (APP_ID !== rawAppId) {
  logger.warn({ rawAppId }, "DERIV_APP_ID must be numeric — using 1089");
}
const DERIV_WS_URL = `wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`;

// ── Market definitions (synthetics only) ──────────────────────────────────────
export const DERIV_MARKETS = [
  // Pip sizes verified from live Deriv prices:
  // R_25 → pip=0.001 (3 d.p.) → pipSize=3   [confirmed: price like 2592.726]
  // 1HZ25V → pip=0.01  (2 d.p.) → pipSize=2   [confirmed: price like 830197.73, NOT 830197.730]
  // R_50/R_75 → pip=0.0001 (4 d.p.) → pipSize=4
  // R_10/R_100/1HZ10V/1HZ50V/1HZ75V/1HZ100V → pip=0.01 (2 d.p.) → pipSize=2
  // ALL Jump indices → pip=0.01 (2 d.p.) → pipSize=2
  { symbol: "R_10",    displayName: "Volatility 10 Index",       category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "R_25",    displayName: "Volatility 25 Index",       category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "R_50",    displayName: "Volatility 50 Index",       category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "R_75",    displayName: "Volatility 75 Index",       category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "R_100",   displayName: "Volatility 100 Index",      category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ10V",  displayName: "Volatility 10 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ25V",  displayName: "Volatility 25 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ50V",  displayName: "Volatility 50 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ75V",  displayName: "Volatility 75 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ100V", displayName: "Volatility 100 (1s) Index", category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "RDBULL",  displayName: "Bull Market Index",         category: "synthetic", pipSize: 4, digitEnabled: false },
  { symbol: "RDBEAR",  displayName: "Bear Market Index",         category: "synthetic", pipSize: 4, digitEnabled: false },
  { symbol: "JD10",    displayName: "Jump 10 Index",             category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "JD25",    displayName: "Jump 25 Index",             category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "JD50",    displayName: "Jump 50 Index",             category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "JD75",    displayName: "Jump 75 Index",             category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "JD100",   displayName: "Jump 100 Index",            category: "synthetic", pipSize: 2, digitEnabled: true },
];

export function getMarketInfo(symbol: string) {
  return DERIV_MARKETS.find((m) => m.symbol === symbol);
}

export function extractLastDigit(price: number, pipSize: number): number {
  // e.g. price=1234.567, pipSize=3 → Math.round(1234.567 * 1000) = 1234567 → 1234567 % 10 = 7
  return Math.round(price * Math.pow(10, pipSize)) % 10;
}

// ── Digit distribution analysis ───────────────────────────────────────────────
export interface DigitStats {
  distribution: { digit: number; count: number; pct: number }[];
  overPct: number;    // P(digit > 5) — recent last 50 ticks
  underPct: number;   // P(digit < 5) — recent last 50 ticks
  fivePct: number;    // P(digit == 5)
  recommendOver: boolean;
  recommendUnder: boolean;
  streakInfo: string;
  hotDigits: number[];   // digits appearing more than expected (>12%)
  coldDigits: number[];  // digits appearing less than expected (<8%)
  bias: "over" | "under" | "neutral";
  samples: number;
  evenOddStats: EvenOddStats;
}

export function analyzeDigits(digits: number[]): DigitStats {
  const window = digits.slice(-100); // use last 100 ticks
  const recent = digits.slice(-20);  // last 20 for streak detection

  const counts = Array(10).fill(0);
  for (const d of window) counts[d]++;
  const total = window.length || 1;

  const distribution = counts.map((count, digit) => ({
    digit,
    count,
    pct: Math.round((count / total) * 100),
  }));

  // Over = digits 6,7,8,9 (40% expected), Under = digits 0,1,2,3,4 (50% expected), Five = 5 (10%)
  const overCount = counts.slice(6).reduce((s, c) => s + c, 0);
  const underCount = counts.slice(0, 5).reduce((s, c) => s + c, 0);
  const fiveCount = counts[5];

  const overPct = Math.round((overCount / total) * 100);
  const underPct = Math.round((underCount / total) * 100);
  const fivePct = Math.round((fiveCount / total) * 100);

  // Recent streak detection (last 20)
  const recentOverCount = recent.filter((d) => d > 5).length;
  const recentUnderCount = recent.filter((d) => d < 5).length;
  const recentOverPct = recent.length > 0 ? (recentOverCount / recent.length) * 100 : 40;
  const recentUnderPct = recent.length > 0 ? (recentUnderCount / recent.length) * 100 : 50;

  const hotDigits = distribution.filter((d) => d.pct > 12).map((d) => d.digit);
  const coldDigits = distribution.filter((d) => d.pct < 8).map((d) => d.digit);

  // Smart signal: if a region (over/under) has been over-represented in LAST 20 ticks,
  // probability suggests it may continue (momentum) OR revert (mean-reversion).
  // Deriv 1s indices are pseudo-random, so mean-reversion is statistically valid.
  let bias: "over" | "under" | "neutral" = "neutral";
  let recommendOver = false;
  let recommendUnder = false;

  // Primary: if RECENT over% >> historical over%, bet OVER continues (momentum)
  // But if RECENT over% is too high (>70%), bet UNDER (over-extended)
  if (recentOverPct > 65) {
    bias = "under"; // momentum over-extended, expect reversion
    recommendUnder = true;
  } else if (recentUnderPct > 65) {
    bias = "over"; // under over-extended, expect reversion
    recommendOver = true;
  } else if (overPct > 45) {
    bias = "over"; // historical over is hot
    recommendOver = true;
  } else if (underPct > 55) {
    bias = "under"; // historical under is hot
    recommendUnder = true;
  } else {
    // Use cold digits logic: if over-digits (6-9) are cold, bet UNDER
    const coldOverDigits = [6, 7, 8, 9].filter((d) => coldDigits.includes(d)).length;
    const coldUnderDigits = [0, 1, 2, 3, 4].filter((d) => coldDigits.includes(d)).length;
    if (coldOverDigits >= 2) { bias = "under"; recommendUnder = true; }
    else if (coldUnderDigits >= 2) { bias = "over"; recommendOver = true; }
  }

  // Streak info for display
  const lastStreak: number[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    if (lastStreak.length === 0) { lastStreak.push(recent[i]); continue; }
    if ((recent[i] > 5) === (lastStreak[0] > 5) && recent[i] !== 5) lastStreak.push(recent[i]);
    else break;
  }
  const streakType = lastStreak[0] > 5 ? "OVER" : lastStreak[0] < 5 ? "UNDER" : "FIVE";
  const streakInfo = lastStreak.length >= 3
    ? `${streakType} streak: ${lastStreak.length} consecutive`
    : `No significant streak`;

  const evenOddStats = analyzeEvenOdd(digits);
  return { distribution, overPct, underPct, fivePct, recommendOver, recommendUnder, streakInfo, hotDigits, coldDigits, bias, evenOddStats, samples: total };
}

// ── Even/Odd digit distribution analysis ──────────────────────────────────────
export interface EvenOddStats {
  evenPct: number;
  oddPct: number;
  recentEvenPct: number;     // last 20 ticks
  recentOddPct: number;
  recent50EvenPct: number;   // last 50 ticks
  recent50OddPct: number;
  bias: "even" | "odd" | "neutral";
  recommendEven: boolean;
  recommendOdd: boolean;
  streakInfo: string;
  currentStreak: number;     // length of current run
  currentStreakType: "even" | "odd";
  chiSquarePvalue: number;   // p-value for deviation from 50%
  chiSquareSignificant: boolean; // p < 0.05
  samples100: number;
  samples50: number;
  samples20: number;
  edge: number;              // edge % (combination of Markov + streak)
  // Markov chain fields
  markovEvenGivenEven?: number;
  markovEvenGivenOdd?: number;
  markovNextEvenProb?: number;
  markovSignal?: "even" | "odd" | "neutral";
  streakReversalSignal?: "even" | "odd" | "neutral";
}

export function analyzeEvenOdd(digits: number[]): EvenOddStats {
  const window100 = digits.slice(-100);
  const window50  = digits.slice(-50);
  const window20  = digits.slice(-20);

  const EVEN = [0, 2, 4, 6, 8];

  function countEven(arr: number[]) { return arr.filter((d) => EVEN.includes(d)).length; }

  const total100 = window100.length || 1;
  const total50  = window50.length  || 1;
  const total20  = window20.length  || 1;

  const even100 = countEven(window100);
  const even50  = countEven(window50);
  const even20  = countEven(window20);

  const evenPct        = (even100 / total100) * 100;
  const oddPct         = 100 - evenPct;
  const recent50EvenPct = (even50 / total50) * 100;
  const recent50OddPct  = 100 - recent50EvenPct;
  const recentEvenPct  = (even20 / total20) * 100;
  const recentOddPct   = 100 - recentEvenPct;

  // ── Chi-square test against expected 50/50 ────────────────────────────────
  const expected100 = total100 / 2;
  const chi2 = ((even100 - expected100) ** 2 / expected100) + (((total100 - even100) - expected100) ** 2 / expected100);
  const chiSquarePvalue = chi2 > 6.635 ? 0.01 : chi2 > 3.841 ? 0.05 : chi2 > 2.706 ? 0.10 : 0.50;
  const chiSquareSignificant = chi2 > 3.841; // p < 0.05

  // ── Current streak detection ──────────────────────────────────────────────
  let currentStreak = 0;
  let currentStreakType: "even" | "odd" = EVEN.includes(digits[digits.length - 1] ?? 0) ? "even" : "odd";
  for (let i = digits.length - 1; i >= 0; i--) {
    const isEven = EVEN.includes(digits[i]);
    if ((currentStreakType === "even") === isEven) currentStreak++;
    else break;
  }

  // ── Markov Chain Analysis ─────────────────────────────────────────────────
  // Compute transition probabilities: P(even|prev=even), P(even|prev=odd)
  // For a truly 50/50 random process: both should be ~0.5
  // Mean-reversion tendency: if P(even|prev=even) < 0.45 → streaks tend to reverse
  let eeCount = 0, eoCount = 0, oeCount = 0, ooCount = 0;
  for (let i = 1; i < window100.length; i++) {
    const prevEven = EVEN.includes(window100[i - 1]);
    const currEven = EVEN.includes(window100[i]);
    if (prevEven && currEven)   eeCount++;
    else if (prevEven)          eoCount++;
    else if (currEven)          oeCount++;
    else                        ooCount++;
  }
  const pEvenGivenEven = eeCount + eoCount > 0 ? eeCount / (eeCount + eoCount) : 0.5;
  const pEvenGivenOdd  = oeCount + ooCount > 0 ? oeCount / (oeCount + ooCount) : 0.5;

  // Determine last digit parity for Markov signal
  const lastIsEven = EVEN.includes(digits[digits.length - 1] ?? 0);
  // Markov probability of NEXT digit being even
  const markovEvenProb = lastIsEven ? pEvenGivenEven : pEvenGivenOdd;
  const markovSignal = markovEvenProb > 0.55 ? "even" : markovEvenProb < 0.45 ? "odd" : "neutral";

  // ── Intelligent Recommendation Logic ─────────────────────────────────────
  // Key insight: Deriv synthetics use pseudo-random digit generation.
  // Consecutive same-parity streaks tend to REVERSE, not continue.
  // We should recommend the OPPOSITE when we see a strong streak.
  // We also use Markov chain to detect systematic biases.
  let bias: "even" | "odd" | "neutral" = "neutral";
  let recommendEven = false;
  let recommendOdd = false;

  // Signal 1: Streak reversal — after 3+ consecutive same parity, bet opposite
  const streakReversalSignal: "even" | "odd" | "neutral" =
    currentStreak >= 5
      ? (currentStreakType === "even" ? "odd" : "even")   // strong reversal
      : currentStreak >= 3
        ? (currentStreakType === "even" ? "odd" : "even") // moderate reversal
        : "neutral";

  // Signal 2: Markov transition bias (lowered threshold for earlier signal)
  const markovBias: "even" | "odd" | "neutral" =
    markovEvenProb > 0.52 ? "even" : markovEvenProb < 0.48 ? "odd" : "neutral";

  // Signal 3: Chi-square confirmed long-run bias (100+ ticks)
  const chiSignal: "even" | "odd" | "neutral" = chiSquareSignificant
    ? (evenPct > 50 ? "even" : "odd")
    : "neutral";

  // Signal 4: Recent 20-tick pattern — lowered threshold to 60%
  // If recent 20 ticks favor one side, the other is likely due
  const recentReversalSignal: "even" | "odd" | "neutral" =
    recentEvenPct > 60 ? "odd" :    // even over-represented → bet odd
    recentOddPct  > 60 ? "even" :   // odd over-represented → bet even
    "neutral";

  // Signal 5: Recent 50-tick pattern
  const mid50Signal: "even" | "odd" | "neutral" =
    recent50EvenPct > 57 ? "odd" :
    recent50OddPct  > 57 ? "even" :
    "neutral";

  // Aggregate: need at least 1 strong signal OR 2 agreeing signals
  const allSignals = [streakReversalSignal, markovBias, chiSignal, recentReversalSignal, mid50Signal];
  const evenVotes = allSignals.filter((s) => s === "even").length;
  const oddVotes  = allSignals.filter((s) => s === "odd").length;

  // Single very strong signals (streak ≥5 or markov strongly skewed) can fire alone
  const strongEven = currentStreak >= 5 && currentStreakType === "odd"
    || markovEvenProb > 0.58
    || (recentEvenPct > 65 && mid50Signal === "odd");
  const strongOdd  = currentStreak >= 5 && currentStreakType === "even"
    || markovEvenProb < 0.42
    || (recentOddPct > 65 && mid50Signal === "even");

  if ((evenVotes >= 2 || strongEven) && evenVotes >= oddVotes) {
    bias = "even"; recommendEven = true;
  } else if ((oddVotes >= 2 || strongOdd) && oddVotes >= evenVotes) {
    bias = "odd"; recommendOdd = true;
  }

  // Edge = how far the Markov probability deviates from 50% + streak strength
  const markovEdge = Math.abs(markovEvenProb - 0.5) * 100;
  const streakEdge = currentStreak >= 4 ? Math.min(20, currentStreak * 3) : 0;
  const edge = Math.max(markovEdge, streakEdge, Math.abs(recentEvenPct - 50));

  const streakInfo = currentStreak >= 4
    ? `${currentStreak}× ${currentStreakType.toUpperCase()} streak → reversal likely`
    : currentStreak >= 2
    ? `${currentStreak}× ${currentStreakType.toUpperCase()} run`
    : "No streak detected";

  return {
    evenPct, oddPct,
    recentEvenPct, recentOddPct,
    recent50EvenPct, recent50OddPct,
    bias, recommendEven, recommendOdd,
    streakInfo, currentStreak, currentStreakType,
    chiSquarePvalue, chiSquareSignificant,
    samples100: total100, samples50: total50, samples20: total20,
    edge,
    // Extended Markov data (consumed by frontend)
    markovEvenGivenEven: pEvenGivenEven,
    markovEvenGivenOdd:  pEvenGivenOdd,
    markovNextEvenProb:  markovEvenProb,
    markovSignal,
    streakReversalSignal,
  } as EvenOddStats & Record<string, unknown>;
}

// ── Trend / Rise-Fall analysis (directional contracts) ───────────────────────
export interface TrendStats {
  risePct: number;      // % of recent ticks that went up
  fallPct: number;      // % of recent ticks that went down
  flatPct: number;      // % of ticks that were flat
  strength: number;     // momentum strength 0-100
  bias: "rise" | "fall" | "neutral";
  recommendRise: boolean;
  recommendFall: boolean;
  recentRisePct: number;   // last 20 ticks rise %
  recentFallPct: number;   // last 20 ticks fall %
  streakInfo: string;
  hotStreak: number;       // consecutive same-direction ticks
  hotDirection: "rise" | "fall" | "none";
}

export function analyzeTrend(prices: number[]) {
  if (prices.length < 5) {
    return { direction: "up", strength: 0, winProb: { rise: 50, fall: 50, call: 50, put: 50 }, streak: 0, streakDir: "up" as const, momentum: 0, sma: prices[prices.length - 1] ?? 0, ema: prices[prices.length - 1] ?? 0, rsi: 50, samples: prices.length, risePct: 50, fallPct: 50, flatPct: 0, bias: "neutral" as const, recommendRise: false, recommendFall: false, recentRisePct: 50, recentFallPct: 50, streakInfo: "Insufficient data", hotStreak: 0, hotDirection: "none" as const };
  }

  const window = prices.slice(-100);
  const recent = prices.slice(-20);
  const samples = window.length;

  // ── Directional move counts ───────────────────────────────────────────────
  let rises = 0, falls = 0, flats = 0;
  for (let i = 1; i < window.length; i++) {
    if (window[i] > window[i - 1]) rises++;
    else if (window[i] < window[i - 1]) falls++;
    else flats++;
  }
  const total = Math.max(window.length - 1, 1);
  const risePct = Math.round((rises / total) * 100);
  const fallPct = Math.round((falls / total) * 100);
  const flatPct = 100 - risePct - fallPct;

  // Recent moves (last 20 ticks)
  let recentRises = 0, recentFalls = 0;
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > recent[i - 1]) recentRises++;
    else if (recent[i] < recent[i - 1]) recentFalls++;
  }
  const recentTotal = Math.max(recent.length - 1, 1);
  const recentRisePct = Math.round((recentRises / recentTotal) * 100);
  const recentFallPct = Math.round((recentFalls / recentTotal) * 100);

  // ── Momentum (normalised price change over last 10 ticks) ─────────────────
  const last10 = prices.slice(-10);
  const momentum = last10.length >= 2
    ? (last10[last10.length - 1] - last10[0]) / (Math.abs(last10[0]) || 1)
    : 0;

  // ── SMA / EMA ─────────────────────────────────────────────────────────────
  const sma = window.reduce((a, b) => a + b, 0) / window.length;
  let ema = window[0];
  const k = 2 / (window.length + 1);
  for (let i = 1; i < window.length; i++) ema = window[i] * k + ema * (1 - k);

  // ── RSI (14-period) ───────────────────────────────────────────────────────
  const rsiPeriod = Math.min(14, window.length - 1);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= rsiPeriod; i++) {
    const diff = window[window.length - i] - window[window.length - i - 1];
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  avgGain /= rsiPeriod; avgLoss /= rsiPeriod;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = Math.round(100 - 100 / (1 + rs));

  // ── Strength (how far from 50% baseline) ─────────────────────────────────
  const strength = Math.min(100, Math.abs(recentRisePct - 50) * 2);

  // ── Direction bias with mean-reversion logic ──────────────────────────────
  let bias: "rise" | "fall" | "neutral" = "neutral";
  let recommendRise = false, recommendFall = false;
  // Over-extended in one direction → expect reversion
  if (recentRisePct > 65) { bias = "fall"; recommendFall = true; }
  else if (recentFallPct > 65) { bias = "rise"; recommendRise = true; }
  else if (risePct > 55) { bias = "rise"; recommendRise = true; }
  else if (fallPct > 55) { bias = "fall"; recommendFall = true; }

  // RSI overbought/oversold reinforcement
  if (rsi > 70) { bias = "fall"; recommendFall = true; }
  else if (rsi < 30) { bias = "rise"; recommendRise = true; }

  const direction = bias === "rise" ? "up" : bias === "fall" ? "down" : recentRisePct >= recentFallPct ? "up" : "down";

  // ── Win probability estimates ──────────────────────────────────────────────
  const riseWinProb = Math.round(50 + (recentFallPct - 50) * 0.4 + (rsi > 70 ? 10 : rsi < 30 ? -10 : 0));
  const fallWinProb = 100 - riseWinProb;
  const callWinProb = Math.round(50 + (sma > ema ? 5 : -5) + (momentum > 0 ? 8 : -8));
  const putWinProb = 100 - callWinProb;

  // ── Current consecutive streak ────────────────────────────────────────────
  let hotStreak = 0;
  let hotDirection: "rise" | "fall" | "none" = "none";
  for (let i = window.length - 1; i > 0; i--) {
    const dir = window[i] > window[i - 1] ? "rise" : window[i] < window[i - 1] ? "fall" : null;
    if (!dir) break;
    if (hotStreak === 0) { hotDirection = dir; hotStreak = 1; }
    else if (dir === hotDirection) hotStreak++;
    else break;
  }

  const streakInfo = hotStreak >= 3
    ? `${hotDirection.toUpperCase()} streak: ${hotStreak} consecutive`
    : "No significant streak";

  return {
    // Frontend panel fields
    direction,
    strength,
    winProb: { rise: Math.max(20, Math.min(80, riseWinProb)), fall: Math.max(20, Math.min(80, fallWinProb)), call: Math.max(20, Math.min(80, callWinProb)), put: Math.max(20, Math.min(80, putWinProb)) },
    streak: hotStreak,
    streakDir: hotDirection === "rise" ? "up" as const : hotDirection === "fall" ? "down" as const : "up" as const,
    momentum,
    sma,
    ema,
    rsi,
    samples,
    // Legacy fields (used elsewhere)
    risePct, fallPct, flatPct, bias, recommendRise, recommendFall,
    recentRisePct, recentFallPct, streakInfo, hotStreak, hotDirection,
  };
}

// ── Persistent Tick Manager ───────────────────────────────────────────────────
const TICK_BUFFER_SIZE = 500;
const DIGIT_BUFFER_SIZE = 300;

export interface TickEvent {
  symbol: string;
  price: number;
  lastDigit: number;
  epoch: number;
}

class DerivTickManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private tickBuffers = new Map<string, number[]>();
  private digitBuffers = new Map<string, number[]>();
  private latestPrices = new Map<string, number>();
  private lastRealTickMs = new Map<string, number>();
  private isConnected = false;
  private reconnectDelay = 3000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribedSymbols: string[] = [];
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private staleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongTime = Date.now();
  private symbolRetryDelay = new Map<string, number>();
  private symbolRetryTimer = new Map<string, ReturnType<typeof setTimeout>>();

  start(symbols: string[]) {
    this.subscribedSymbols = symbols;
    for (const sym of symbols) {
      if (!this.tickBuffers.has(sym)) this.tickBuffers.set(sym, []);
      if (!this.digitBuffers.has(sym)) this.digitBuffers.set(sym, []);
    }
    this.connect();
    this.startStaleCheck();
  }

  private startStaleCheck() {
    if (this.staleCheckTimer) clearInterval(this.staleCheckTimer);
    this.staleCheckTimer = setInterval(() => {
      if (!this.isConnected || this.ws?.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      // Find how many symbols are actively receiving ticks (sanity reference)
      const activeSym = this.subscribedSymbols.filter(s => {
        const last = this.lastRealTickMs.get(s) ?? 0;
        return now - last < 30_000;
      });
      // If at least some symbols are live, check for stale ones and re-subscribe them
      if (activeSym.length > 0) {
        for (const sym of this.subscribedSymbols) {
          const last = this.lastRealTickMs.get(sym) ?? 0;
          if (now - last > 45_000) {
            logger.info({ symbol: sym }, "TickManager: re-subscribing stale market");
            this.ws!.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
          }
        }
      }
    }, 30_000);
  }

  private connect() {
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
    }

    try {
      this.ws = new WebSocket(DERIV_WS_URL);
    } catch (err) {
      logger.warn({ err }, "TickManager: failed to create WebSocket, will retry");
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.isConnected = true;
      this.reconnectDelay = 3000;
      logger.info("TickManager: WebSocket connected to Deriv");
      this.subscribeAll();
      this.startPing();
    });

    this.ws.on("message", (data) => {
      try {
        this.handleMessage(JSON.parse(data.toString()));
      } catch { /* ignore parse errors */ }
    });

    this.ws.on("error", (err) => {
      logger.warn({ msg: (err as Error).message }, "TickManager: WS error");
    });

    this.ws.on("close", () => {
      this.isConnected = false;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      logger.info("TickManager: WS closed, scheduling reconnect");
      this.scheduleReconnect();
    });
  }

  private subscribeAll() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    // Clear per-symbol retry state on a fresh subscribe-all
    this.symbolRetryDelay.clear();
    for (const [, timer] of this.symbolRetryTimer) clearTimeout(timer);
    this.symbolRetryTimer.clear();
    // Stagger subscriptions 500ms apart to stay within Deriv rate limits
    this.subscribedSymbols.forEach((symbol, i) => {
      setTimeout(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
        }
      }, i * 500);
    });
    logger.info({ count: this.subscribedSymbols.length }, "TickManager: subscribing to all markets (staggered)");
  }

  private handleMessage(msg: any) {
    if (msg.msg_type === "tick" && msg.tick) {
      const { symbol, quote, epoch } = msg.tick;
      const price = Number(quote);
      const market = getMarketInfo(symbol);
      if (!market) return;

      // Subscription is healthy — reset any retry backoff for this symbol
      if (this.symbolRetryDelay.has(symbol)) {
        this.symbolRetryDelay.delete(symbol);
      }

      const lastDigit = market.digitEnabled ? extractLastDigit(price, market.pipSize) : -1;

      // Buffer price
      const prices = this.tickBuffers.get(symbol) ?? [];
      prices.push(price);
      if (prices.length > TICK_BUFFER_SIZE) prices.shift();
      this.tickBuffers.set(symbol, prices);
      this.latestPrices.set(symbol, price);
      // Track real tick time per market for stale detection
      this.lastRealTickMs.set(symbol, Date.now());

      // Buffer digit
      if (market.digitEnabled && lastDigit >= 0) {
        const digits = this.digitBuffers.get(symbol) ?? [];
        digits.push(lastDigit);
        if (digits.length > DIGIT_BUFFER_SIZE) digits.shift();
        this.digitBuffers.set(symbol, digits);
      }

      // Emit tick event for SSE broadcast
      this.emit("tick", { symbol, price, lastDigit, epoch } as TickEvent);
    }

    if (msg.msg_type === "ping" || msg.msg_type === "pong") {
      this.lastPongTime = Date.now();
    }

    if (msg.error) {
      const sym = msg.echo_req?.ticks ?? msg.echo_req?.symbol ?? "?";
      const isRateLimit = msg.error.code === "RateLimit";
      logger.warn({ code: msg.error.code, message: msg.error.message, symbol: sym }, "TickManager: Deriv subscription error");
      // Re-subscribe to the failed market with backoff
      // Rate limit errors get a long backoff (60s → 120s → 240s → max 600s)
      // Other errors get a short retry (5s)
      if (sym !== "?" && this.subscribedSymbols.includes(sym)) {
        // Cancel any existing retry timer for this symbol
        const existingTimer = this.symbolRetryTimer.get(sym);
        if (existingTimer) clearTimeout(existingTimer);

        let delay: number;
        if (isRateLimit) {
          const current = this.symbolRetryDelay.get(sym) ?? 60_000;
          delay = Math.min(current * 2, 600_000);
          this.symbolRetryDelay.set(sym, delay);
        } else {
          delay = 5_000;
          this.symbolRetryDelay.delete(sym);
        }

        const timer = setTimeout(() => {
          this.symbolRetryTimer.delete(sym);
          if (this.ws?.readyState === WebSocket.OPEN) {
            logger.info({ symbol: sym, delayMs: delay }, "TickManager: re-subscribing after error");
            this.ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
          }
        }, delay);
        this.symbolRetryTimer.set(sym, timer);
      }
    }
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPongTime > 60000) {
        logger.warn("TickManager: no pong for 60s, reconnecting");
        this.connect();
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 30000);
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30000);
      logger.info({ delay: this.reconnectDelay }, "TickManager: reconnecting");
      this.connect();
    }, this.reconnectDelay);
  }

  getTicks(symbol: string, count = 100): number[] {
    const buf = this.tickBuffers.get(symbol) ?? [];
    if (buf.length >= 5) return buf.slice(-count);
    // Fall back to simulated if no live data yet
    return generateSimulatedPrices(symbol, count);
  }

  getDigits(symbol: string, count = 300): number[] {
    const buf = this.digitBuffers.get(symbol) ?? [];
    if (buf.length >= 30) return buf.slice(-count);
    // Derive from tick buffer (real or simulated) to warm up digit analysis immediately
    const market = getMarketInfo(symbol);
    if (market?.digitEnabled) {
      // Use getTicks which falls back to simulated prices if real ticks aren't buffered yet
      const ticks = this.getTicks(symbol, Math.max(count, 100));
      if (ticks.length >= 5) {
        const derived = ticks.map((p) => extractLastDigit(p, market.pipSize));
        const combined = [...derived, ...buf];
        return combined.slice(-count);
      }
    }
    return buf.slice(-count);
  }

  getLatestPrice(symbol: string): number | null {
    return this.latestPrices.get(symbol) ?? null;
  }

  getConnectionStatus(): boolean {
    return this.isConnected;
  }

  getLiveTickCount(): number {
    let total = 0;
    for (const [, v] of this.tickBuffers) total += v.length;
    return total;
  }

  isLiveData(symbol: string): boolean {
    return (this.tickBuffers.get(symbol) ?? []).length >= 5;
  }

  getTickHealth(): { connected: boolean; liveSymbols: number; totalSymbols: number; usingSimulated: boolean } {
    let liveSymbols = 0;
    for (const m of DERIV_MARKETS) {
      if (this.isLiveData(m.symbol)) liveSymbols++;
    }
    return {
      connected: this.isConnected,
      liveSymbols,
      totalSymbols: DERIV_MARKETS.length,
      usingSimulated: liveSymbols < DERIV_MARKETS.length / 2,
    };
  }
}

export const tickManager = new DerivTickManager();

// ── Simulated price fallback ──────────────────────────────────────────────────
function generateSimulatedPrices(symbol: string, count: number): number[] {
  const baseMap: Record<string, number> = {
    R_10: 6500, R_25: 3200, R_50: 1850, R_75: 950, R_100: 1200,
    "1HZ10V": 6480, "1HZ25V": 3190, "1HZ50V": 1840, "1HZ75V": 945, "1HZ100V": 1195,
    RDBULL: 3500, RDBEAR: 3500,
    JD10: 4200, JD25: 4300, JD50: 4400, JD75: 4500, JD100: 4600,
  };
  const base = baseMap[symbol] ?? 1000;
  const volPct = symbol.includes("R_100") || symbol.includes("1HZ100") ? 0.008
    : symbol.includes("R_75") || symbol.includes("1HZ75") ? 0.005
    : 0.002;

  // Determine the decimal precision required for correct digit extraction.
  // Markets with pipSize=4 need 4 decimal places; pipSize=2 need 2.
  // Without sufficient precision, extractLastDigit() always returns 0 for pipSize=4 markets.
  const market = getMarketInfo(symbol);
  const pipSize = market?.pipSize ?? 2;
  const decimalFactor = Math.pow(10, pipSize);

  const prices: number[] = [base];
  for (let i = 1; i < count; i++) {
    const change = prices[i - 1] * volPct * (Math.random() - 0.5) * 2;
    const raw = prices[i - 1] + change;
    // Round to the market's pip precision so digit extraction is meaningful
    const rounded = Math.round(raw * decimalFactor) / decimalFactor;
    prices.push(Math.max(rounded, 0.0001));
  }
  return prices;
}

// ── Legacy getTickHistory shim (uses TickManager buffer + WS fallback) ────────
export async function getTickHistory(symbol: string, count = 50): Promise<number[]> {
  const live = tickManager.getTicks(symbol, count);
  if (live.length >= 5) return live;

  // Direct WS fetch as fallback when tick manager hasn't buffered enough
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(DERIV_WS_URL);
      const timeout = setTimeout(() => {
        ws.close();
        resolve(generateSimulatedPrices(symbol, count));
      }, 4000);

      ws.on("open", () => {
        ws.send(JSON.stringify({ ticks_history: symbol, count, end: "latest", style: "ticks" }));
      });
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.msg_type === "history" && msg.history) {
            clearTimeout(timeout);
            ws.close();
            const prices = msg.history.prices.map(Number);
            // Feed into tick manager buffer
            const market = getMarketInfo(symbol);
            if (market) {
              const buf = prices.slice(-TICK_BUFFER_SIZE) as number[];
              // @ts-ignore — directly seed the buffer
              tickManager["tickBuffers"].set(symbol, buf);
              if (market.digitEnabled) {
                const digits = buf.map((p) => extractLastDigit(p, market.pipSize));
                // @ts-ignore
                tickManager["digitBuffers"].set(symbol, digits.slice(-DIGIT_BUFFER_SIZE));
              }
            }
            resolve(prices);
          }
        } catch { /* ignore */ }
      });
      ws.on("error", () => { clearTimeout(timeout); ws.close(); resolve(generateSimulatedPrices(symbol, count)); });
    } catch {
      resolve(generateSimulatedPrices(symbol, count));
    }
  });
}

// ── Auth / trade execution types ───────────────────────────────────────────────
export interface DerivAccountInfo {
  loginid: string;
  currency: string;
  balance: number;
  is_virtual: number;
  email?: string;
  fullname?: string;
  country?: string;
}

export interface LiveTradeResult {
  contractId: number;
  buyPrice: number;
  entrySpot: number;
  longcode: string;
}

export interface ContractResult {
  contractId: number;
  won: boolean;
  profit: number;
  exitSpot: number;
  sellPrice: number;
  entrySpot: number;
}

export interface ContractProposal {
  payout: number;
  stake: number;
  payoutMultiplier: number;
  spot: number;
  longcode: string;
  proposalId: string;
  askPrice: number;
}

// ── Persistent journal WebSocket manager ─────────────────────────────────────
// Maintains a single long-lived WS connection for fetching the Deriv profit
// table so the journal never disconnects as long as a token is active.
class DerivJournalManager extends EventEmitter {
  private ws: WebSocket | null = null;
  private token: string | null = null;
  private cachedTransactions: any[] = [];
  private lastFetchMs = 0;
  private isAuthorized = false;
  private reconnectDelay = 3000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongMs = Date.now();

  setToken(token: string) {
    if (this.token === token && this.ws?.readyState === WebSocket.OPEN && this.isAuthorized) return;
    this.token = token;
    this.reconnectDelay = 3000;
    this.connect();
    this.startRefreshTimer();
  }

  clearToken() {
    this.token = null;
    this.cachedTransactions = [];
    this.lastFetchMs = 0;
    this.isAuthorized = false;
    this.stopTimers();
    if (this.ws) { try { this.ws.terminate(); } catch { /* ignore */ } this.ws = null; }
    logger.info("JournalManager: cleared (token disconnected)");
  }

  getCached(): any[] { return this.cachedTransactions; }

  isCacheFresh(maxAgeMs = 120_000): boolean {
    return this.lastFetchMs > 0 && (Date.now() - this.lastFetchMs) < maxAgeMs;
  }

  /** Immediately request a fresh profit_table — call after any trade settles. */
  forceRefresh() {
    if (this.isAuthorized && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ profit_table: 1, description: 1, sort: "DESC", limit: 200 }));
    }
  }

  private stopTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private startRefreshTimer() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = setInterval(() => {
      if (this.isAuthorized && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ profit_table: 1, description: 1, sort: "DESC", limit: 200 }));
      }
    }, 60_000);
  }

  private connect() {
    if (this.ws) { try { this.ws.terminate(); } catch { /* ignore */ } this.ws = null; }
    if (!this.token) return;

    try {
      this.ws = new WebSocket(DERIV_WS_URL);
    } catch (err) {
      logger.warn({ err }, "JournalManager: failed to create WS, will retry");
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.isAuthorized = false;
      this.lastPongMs = Date.now();
      logger.info("JournalManager: WS connected, authorizing");
      this.ws!.send(JSON.stringify({ authorize: this.token }));
      this.startPing();
    });

    this.ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.msg_type === "authorize" && msg.authorize && !this.isAuthorized) {
          this.isAuthorized = true;
          this.reconnectDelay = 3000;
          logger.info({ loginId: msg.authorize.loginid }, "JournalManager: authorized, fetching profit table");
          this.ws!.send(JSON.stringify({ profit_table: 1, description: 1, sort: "DESC", limit: 200 }));
        }
        if (msg.msg_type === "profit_table" && msg.profit_table) {
          this.cachedTransactions = msg.profit_table.transactions ?? [];
          this.lastFetchMs = Date.now();
          logger.info({ count: this.cachedTransactions.length }, "JournalManager: profit table refreshed");
          this.emit("refreshed", this.cachedTransactions);
        }
        if (msg.msg_type === "pong" || msg.msg_type === "ping") {
          this.lastPongMs = Date.now();
        }
        if (msg.error) {
          logger.warn({ code: msg.error.code, message: msg.error.message }, "JournalManager: error from Deriv");
          // If invalid token, don't retry
          if (msg.error.code === "InvalidToken" || msg.error.code === "AuthorizationRequired") {
            this.token = null;
            this.stopTimers();
          }
        }
      } catch { /* ignore */ }
    });

    this.ws.on("error", (err) => {
      logger.warn({ msg: (err as Error).message }, "JournalManager: WS error");
    });

    this.ws.on("close", () => {
      this.isAuthorized = false;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      logger.info("JournalManager: WS closed, scheduling reconnect");
      this.scheduleReconnect();
    });
  }

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPongMs > 60_000) {
        logger.warn("JournalManager: no pong for 60s — reconnecting");
        this.connect();
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 25_000);
  }

  private scheduleReconnect() {
    if (!this.token) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30_000);
      logger.info({ delay: this.reconnectDelay }, "JournalManager: reconnecting");
      this.connect();
    }, this.reconnectDelay);
  }
}

export const journalManager = new DerivJournalManager();

let cachedToken: string | null = null;
let cachedAccountInfo: DerivAccountInfo | null = null;

// Balance cache — avoid opening a new WebSocket on every account-fetch poll
let cachedBalance: number | null = null;
let cachedBalanceAt = 0;
const BALANCE_CACHE_TTL_MS = 60_000; // refresh at most once per minute

export function setDerivToken(token: string) {
  cachedToken = token;
  journalManager.setToken(token);
}
export function clearDerivToken() {
  cachedToken = null;
  cachedAccountInfo = null;
  cachedBalance = null;
  cachedBalanceAt = 0;
  journalManager.clearToken();
}
export function getCachedAccountInfo() { return cachedAccountInfo; }
export function getCachedToken() { return cachedToken; }
export function invalidateBalanceCache() {
  cachedBalanceAt = 0;
}

export async function getContractProposal(
  token: string | null,
  params: {
    symbol: string;
    contractType: string;
    stake: number;
    duration: number;
    durationUnit: string;
    currency: string;
    barrier?: number | string;
  },
): Promise<ContractProposal | null> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(DERIV_WS_URL);
      const timeout = setTimeout(() => { ws.close(); resolve(null); }, 12000);
      let authorized = !token;

      const sendProposal = () => {
        const proposalParams: Record<string, unknown> = {
          amount: params.stake,
          basis: "stake",
          contract_type: params.contractType,
          currency: params.currency,
          duration: params.duration,
          duration_unit: params.durationUnit,
          symbol: params.symbol,
        };
        if (params.barrier !== undefined) proposalParams.barrier = String(params.barrier);
        ws.send(JSON.stringify({ proposal: 1, ...proposalParams }));
      };

      ws.on("open", () => {
        if (token) ws.send(JSON.stringify({ authorize: token }));
        else sendProposal();
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.error) { clearTimeout(timeout); ws.close(); resolve(null); return; }

          if (msg.msg_type === "authorize" && !authorized) {
            authorized = true;
            sendProposal();
          }

          if (msg.msg_type === "proposal" && msg.proposal) {
            clearTimeout(timeout);
            ws.close();
            const askPrice = Number(msg.proposal.ask_price ?? params.stake);
            const payout = Number(msg.proposal.payout ?? askPrice * 1.87);
            resolve({
              payout,
              stake: askPrice,
              payoutMultiplier: askPrice > 0 ? payout / askPrice : 1.87,
              spot: Number(msg.proposal.spot ?? 0),
              longcode: msg.proposal.longcode ?? "",
              proposalId: String(msg.proposal.id ?? ""),
              askPrice,
            });
          }
        } catch { /* ignore */ }
      });
      ws.on("error", () => { clearTimeout(timeout); ws.close(); resolve(null); });
    } catch {
      resolve(null);
    }
  });
}

export async function authorizeWithDeriv(token: string): Promise<DerivAccountInfo> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS_URL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Connection timeout")); }, 15000);

    ws.on("open", () => { ws.send(JSON.stringify({ authorize: token })); });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.error) { clearTimeout(timeout); ws.close(); reject(new Error(msg.error.message)); return; }
        if (msg.msg_type === "authorize" && msg.authorize) {
          clearTimeout(timeout);
          const info: DerivAccountInfo = {
            loginid: msg.authorize.loginid,
            currency: msg.authorize.currency,
            balance: msg.authorize.balance,
            is_virtual: msg.authorize.is_virtual,
            email: msg.authorize.email,
            fullname: msg.authorize.fullname,
            country: msg.authorize.country,
          };
          cachedAccountInfo = info;
          ws.close();
          resolve(info);
        }
      } catch { /* ignore */ }
    });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

export async function getLiveBalance(token: string): Promise<number | null> {
  // Return cached balance if it's still fresh — avoids hammering Deriv authorize rate limit
  const now = Date.now();
  if (cachedBalance !== null && now - cachedBalanceAt < BALANCE_CACHE_TTL_MS) {
    return cachedBalance;
  }

  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(DERIV_WS_URL);
      const timeout = setTimeout(() => { ws.close(); resolve(null); }, 8000);
      ws.on("open", () => { ws.send(JSON.stringify({ authorize: token })); });
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.msg_type === "authorize" && msg.authorize) {
            clearTimeout(timeout);
            ws.close();
            const balance = Number(msg.authorize.balance);
            cachedBalance = balance;
            cachedBalanceAt = Date.now();
            resolve(balance);
          }
          if (msg.error) { clearTimeout(timeout); ws.close(); resolve(null); }
        } catch { /* ignore */ }
      });
      ws.on("error", () => { clearTimeout(timeout); ws.close(); resolve(null); });
    } catch { resolve(null); }
  });
}

export async function executeLiveTrade(token: string, params: {
  symbol: string;
  contractType: string;
  stake: number;
  duration: number;
  durationUnit: string;
  currency: string;
  barrier?: number | string;
}): Promise<LiveTradeResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS_URL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Trade execution timeout")); }, 20000);
    let authorized = false;

    ws.on("open", () => { ws.send(JSON.stringify({ authorize: token })); });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.error) { clearTimeout(timeout); ws.close(); reject(new Error(msg.error.message)); return; }

        if (msg.msg_type === "authorize" && !authorized) {
          authorized = true;
          const buyParams: Record<string, unknown> = {
            amount: params.stake,
            basis: "stake",
            contract_type: params.contractType,
            currency: params.currency,
            duration: params.duration,
            duration_unit: params.durationUnit,
            symbol: params.symbol,
          };
          if (params.barrier !== undefined) buyParams.barrier = String(params.barrier);
          ws.send(JSON.stringify({ buy: 1, price: params.stake, parameters: buyParams }));
        }

        if (msg.msg_type === "buy" && msg.buy) {
          clearTimeout(timeout);
          ws.close();
          resolve({
            contractId: msg.buy.contract_id,
            buyPrice: Number(msg.buy.buy_price),
            entrySpot: Number(msg.buy.buy_price),
            longcode: msg.buy.longcode ?? "",
          });
        }
      } catch (e) { logger.error({ e }, "Error parsing Deriv buy response"); }
    });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

export async function fetchDerivProfitTable(token: string, limit = 50): Promise<any[]> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(DERIV_WS_URL);
      const timeout = setTimeout(() => { ws.close(); resolve([]); }, 12000);
      let authorized = false;
      ws.on("open", () => { ws.send(JSON.stringify({ authorize: token })); });
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.error) { clearTimeout(timeout); ws.close(); resolve([]); return; }
          if (msg.msg_type === "authorize" && !authorized) {
            authorized = true;
            ws.send(JSON.stringify({ profit_table: 1, description: 1, sort: "DESC", limit }));
          }
          if (msg.msg_type === "profit_table" && msg.profit_table) {
            clearTimeout(timeout);
            ws.close();
            resolve(msg.profit_table.transactions ?? []);
          }
        } catch { /* ignore */ }
      });
      ws.on("error", () => { clearTimeout(timeout); ws.close(); resolve([]); });
    } catch { resolve([]); }
  });
}

export async function waitForContractResult(token: string, contractId: number, timeoutMs = 30000): Promise<ContractResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS_URL);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Contract result timeout")); }, timeoutMs + 10000);
    let authorized = false;

    ws.on("open", () => { ws.send(JSON.stringify({ authorize: token })); });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.error) { clearTimeout(timeout); ws.close(); reject(new Error(msg.error.message)); return; }

        if (msg.msg_type === "authorize" && !authorized) {
          authorized = true;
          ws.send(JSON.stringify({ proposal_open_contracts: 1, contract_id: contractId, subscribe: 1 }));
        }

        if (msg.msg_type === "proposal_open_contracts" && msg.proposal_open_contracts) {
          const contract = msg.proposal_open_contracts;
          // Deriv can return: is_sold=1, status="sold"|"won"|"lost"|"expired"
          const settled =
            contract.is_sold ||
            Number(contract.is_sold) === 1 ||
            contract.status === "sold" ||
            contract.status === "won" ||
            contract.status === "lost" ||
            contract.status === "expired";
          if (settled) {
            clearTimeout(timeout);
            ws.close();
            // profit = net profit (positive for win, negative for loss)
            // Prefer 'profit' field; fall back to sell_price - buy_price
            const rawProfit = Number(contract.profit ?? 0);
            const sellPrice = Number(contract.sell_price ?? 0);
            const buyPrice = Number(contract.buy_price ?? contract.purchase_price ?? 0);
            const profit = rawProfit !== 0 ? rawProfit : sellPrice - buyPrice;
            // Determine win from status first, then profit sign
            const won =
              contract.status === "won" ? true :
              contract.status === "lost" ? false :
              profit > 0;
            resolve({
              contractId,
              won,
              profit,
              exitSpot: Number(contract.exit_tick ?? contract.current_spot ?? 0),
              sellPrice,
              entrySpot: Number(contract.entry_tick ?? contract.entry_spot ?? 0),
            });
          }
        }
      } catch { /* ignore */ }
    });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

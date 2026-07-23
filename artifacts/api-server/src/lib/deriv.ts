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

// Deriv app_id — register your app at https://app.deriv.com/apps
// New format: alphanumeric string, e.g. "33TQEuMW21nTbCZ7Hfb0q"
// Old numeric IDs (e.g. 1089) are deprecated — set DERIV_APP_ID to your new alphanumeric app ID.
const rawAppId = (process.env["DERIV_APP_ID"] ?? "").trim();
export const APP_ID: string = rawAppId;
if (!APP_ID) {
  logger.warn(
    "DERIV_APP_ID is not set. Set your alphanumeric Deriv app ID (e.g. 33TQEuMW21nTbCZ7Hfb0q) " +
    "from app.deriv.com/apps in the DERIV_APP_ID environment variable. Live market data " +
    "will be unavailable until a valid app ID is configured.",
  );
}
// Official Deriv WebSocket endpoint — accepts both legacy numeric and new alphanumeric app IDs
const DERIV_WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID || "1089"}`;

// ── Market definitions (synthetics only) ──────────────────────────────────────
export const DERIV_MARKETS = [
  // Pip sizes verified from live Deriv prices:
  // R_10  → pip=0.001 (3 d.p.) → pipSize=3   [confirmed: price like 4865.826]
  // R_25  → pip=0.001 (3 d.p.) → pipSize=3   [confirmed: price like 2592.726]
  // 1HZ25V → pip=0.01  (2 d.p.) → pipSize=2   [confirmed: price like 830197.73, NOT 830197.730]
  // R_50/R_75 → pip=0.0001 (4 d.p.) → pipSize=4
  // R_100/1HZ10V/1HZ50V/1HZ75V/1HZ100V → pip=0.01 (2 d.p.) → pipSize=2
  // ALL Jump indices → pip=0.01 (2 d.p.) → pipSize=2
  { symbol: "R_10",    displayName: "Volatility 10 Index",       category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "R_25",    displayName: "Volatility 25 Index",       category: "synthetic", pipSize: 3, digitEnabled: true },
  { symbol: "R_50",    displayName: "Volatility 50 Index",       category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "R_75",    displayName: "Volatility 75 Index",       category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "R_100",   displayName: "Volatility 100 Index",      category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ10V",  displayName: "Volatility 10 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ25V",  displayName: "Volatility 25 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ50V",  displayName: "Volatility 50 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ75V",  displayName: "Volatility 75 (1s) Index",  category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "1HZ100V", displayName: "Volatility 100 (1s) Index", category: "synthetic", pipSize: 2, digitEnabled: true },
  { symbol: "RDBULL",  displayName: "Bull Market Index",         category: "synthetic", pipSize: 4, digitEnabled: true },
  { symbol: "RDBEAR",  displayName: "Bear Market Index",         category: "synthetic", pipSize: 4, digitEnabled: true },
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

// ── Persistent Tick Manager (clean rewrite) ───────────────────────────────────
const TICK_BUFFER_SIZE = 500;
const DIGIT_BUFFER_SIZE = 300;

// ── Simulated price parameters (used when app_id has no symbols) ──────────────
const SIM_PARAMS: Record<string, { base: number; vol: number }> = {
  R_10:    { base: 4865.000,  vol: 0.00018 },
  R_25:    { base: 2592.726,  vol: 0.00035 },
  R_50:    { base: 6200.0000, vol: 0.00065 },
  R_75:    { base: 6800.0000, vol: 0.00095 },
  R_100:   { base: 1800.00,   vol: 0.00140 },
  "1HZ10V":  { base: 1000.00, vol: 0.00018 },
  "1HZ25V":  { base: 1000.00, vol: 0.00035 },
  "1HZ50V":  { base: 1000.00, vol: 0.00065 },
  "1HZ75V":  { base: 1000.00, vol: 0.00095 },
  "1HZ100V": { base: 1000.00, vol: 0.00140 },
  RDBULL:  { base: 5000.0000, vol: 0.00080 },
  RDBEAR:  { base: 5000.0000, vol: 0.00080 },
  JD10:    { base: 1000.00,  vol: 0.00025 },
  JD25:    { base: 1000.00,  vol: 0.00055 },
  JD50:    { base: 1000.00,  vol: 0.00100 },
  JD75:    { base: 1000.00,  vol: 0.00150 },
  JD100:   { base: 1000.00,  vol: 0.00200 },
};

export interface TickEvent {
  symbol: string;
  price: number;
  lastDigit: number;
  epoch: number;
}

type PendingAuth = {
  resolve: (info: DerivAccountInfo) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * DerivTickManager
 *
 * Maintains one persistent WebSocket connection to wss://ws.derivws.com.
 * On connect it calls active_symbols to discover which markets are available
 * for the configured DERIV_APP_ID, then subscribes only to those symbols.
 * Symbols that return InvalidSymbol are permanently skipped (no retry loop).
 * No simulated/fallback prices — real data only.
 *
 * NOTE: Deriv now uses alphanumeric app IDs (e.g. 33TQEuMW21nTbCZ7Hfb0q).
 * Register your app at https://app.deriv.com/apps and set the DERIV_APP_ID
 * environment variable. Numeric IDs (e.g. 1089) are deprecated.
 */
class DerivTickManager extends EventEmitter {
  // Connection
  private ws: WebSocket | null = null;
  private isConnected = false;
  private reconnectDelay = 3_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Symbol state
  private desiredSymbols: string[] = [];           // symbols we WANT to receive
  private confirmedSymbols = new Set<string>();     // confirmed valid by active_symbols
  private invalidSymbols = new Set<string>();       // permanently invalid — do NOT retry

  // Data buffers
  private tickBuffers = new Map<string, number[]>();
  private digitBuffers = new Map<string, number[]>();
  private latestPrices = new Map<string, number>();
  private lastTickMs = new Map<string, number>();

  // Keep-alive
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongMs = Date.now();

  // Price simulation (used when app_id has no Deriv symbols)
  private simInterval: ReturnType<typeof setInterval> | null = null;
  private simPrices = new Map<string, number>();
  private usingSimulated = false;

  // Auth callbacks routed through the shared WS
  private pendingAuth: PendingAuth[] = [];

  // ── Public API ─────────────────────────────────────────────────────────────

  start(symbols: string[]) {
    this.desiredSymbols = symbols;
    for (const sym of symbols) {
      if (!this.tickBuffers.has(sym)) this.tickBuffers.set(sym, []);
      if (!this.digitBuffers.has(sym)) this.digitBuffers.set(sym, []);
    }
    logger.info({ count: symbols.length, appId: APP_ID }, "TickManager starting up");
    this.connect();
  }

  /** Send authorize on the shared persistent WS — avoids opening a competing connection. */
  authorizeViaWs(token: string, timeoutMs = 12_000): Promise<DerivAccountInfo> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("TickManager WS not open"));
        return;
      }
      const timer = setTimeout(() => {
        this.pendingAuth = this.pendingAuth.filter((p) => p.resolve !== resolve);
        reject(new Error("Connection timeout"));
      }, timeoutMs);
      this.pendingAuth.push({ resolve, reject, timer });
      this.ws.send(JSON.stringify({ authorize: token }));
    });
  }

  getTicks(symbol: string, count = 100): number[] {
    return (this.tickBuffers.get(symbol) ?? []).slice(-count);
  }

  getDigits(symbol: string, count = 300): number[] {
    const buf = this.digitBuffers.get(symbol) ?? [];
    if (buf.length >= 30) return buf.slice(-count);
    // Warm-up: derive digits from the tick buffer while it fills up
    const market = getMarketInfo(symbol);
    if (market?.digitEnabled) {
      const ticks = this.getTicks(symbol, Math.max(count, 100));
      if (ticks.length >= 5) {
        const derived = ticks.map((p) => extractLastDigit(p, market.pipSize));
        return [...derived, ...buf].slice(-count);
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

  getTickHealth(): {
    connected: boolean;
    liveSymbols: number;
    totalSymbols: number;
    invalidSymbols: number;
    usingSimulated: boolean;
  } {
    const valid = this.desiredSymbols.filter((s) => !this.invalidSymbols.has(s));
    let live = 0;
    for (const sym of valid) {
      if (this.isLiveData(sym)) live++;
    }
    return {
      connected: this.isConnected,
      liveSymbols: live,
      totalSymbols: valid.length,
      invalidSymbols: this.invalidSymbols.size,
      usingSimulated: this.usingSimulated,
    };
  }

  // ── Internal connection logic ──────────────────────────────────────────────

  private connect() {
    this.cleanupWs();
    try {
      this.ws = new WebSocket(DERIV_WS_URL, { perMessageDeflate: false });
    } catch (err) {
      logger.warn({ err }, "TickManager: failed to create WebSocket, will retry");
      this.scheduleReconnect();
      return;
    }

    this.ws.on("open", () => {
      this.isConnected = true;
      this.reconnectDelay = 3_000;
      this.lastPongMs = Date.now();
      logger.info({ url: DERIV_WS_URL, appId: APP_ID }, "TickManager: WebSocket connected to Deriv");
      // Step 1 — discover which symbols are actually available for this app_id
      this.ws!.send(JSON.stringify({ active_symbols: "brief" }));
      this.startPing();
      this.startStaleCheck();
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
      this.stopTimers();
      logger.info("TickManager: WS closed, scheduling reconnect");
      this.scheduleReconnect();
    });
  }

  private handleMessage(msg: any) {
    switch (msg.msg_type) {
      case "active_symbols":
        this.onActiveSymbols(msg.active_symbols ?? []);
        return;
      case "tick":
        if (msg.tick) this.onTick(msg.tick);
        return;
      case "ping":
      case "pong":
        this.lastPongMs = Date.now();
        return;
      case "authorize":
        this.onAuthorize(msg);
        return;
    }
    if (msg.error) this.onError(msg);
  }

  private onActiveSymbols(
    symbols: Array<{ symbol: string; display_name: string; pip?: string }>,
  ) {
    const available = new Set(symbols.map((s) => s.symbol));
    const toSubscribe = this.desiredSymbols.filter((s) => available.has(s));

    if (symbols.length === 0) {
      // app_id has no symbols — likely using deprecated demo app_id=1089
      logger.warn(
        { appId: APP_ID },
        "TickManager: active_symbols returned empty — DERIV_APP_ID may be invalid or unset. " +
          "Register your app at https://app.deriv.com/apps and set DERIV_APP_ID to your alphanumeric app ID (e.g. 33TQEuMW21nTbCZ7Hfb0q).",
      );
      // Start simulated prices so digit analysers have data while awaiting a real app_id
      this.startSimulation();
      // Subscribe to desired symbols anyway; each one will tell us individually if it's invalid
      this.subscribeSymbols(this.desiredSymbols);
    } else if (toSubscribe.length === 0) {
      logger.warn(
        {
          availableSample: [...available].slice(0, 8),
          desired: this.desiredSymbols.slice(0, 5),
        },
        "TickManager: none of our desired symbols found in active_symbols — " +
          "Deriv may have renamed them. Subscribing anyway.",
      );
      this.subscribeSymbols(this.desiredSymbols);
    } else {
      this.confirmedSymbols = new Set(toSubscribe);
      logger.info(
        { confirmed: toSubscribe.length, total: this.desiredSymbols.length },
        "TickManager: symbol discovery complete, subscribing",
      );
      this.subscribeSymbols(toSubscribe);
    }
  }

  /** Subscribe to each symbol staggered 300 ms apart to respect Deriv rate limits. */
  private subscribeSymbols(symbols: string[]) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const valid = symbols.filter((s) => !this.invalidSymbols.has(s));
    valid.forEach((symbol, i) => {
      setTimeout(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ ticks: symbol, subscribe: 1 }));
        }
      }, i * 300);
    });
    logger.info(
      { count: valid.length, staggerMs: 300 },
      "TickManager: subscribing to markets (staggered)",
    );
  }

  private onTick(tick: { symbol: string; quote: string; epoch: number }) {
    const { symbol, quote, epoch } = tick;
    const price = Number(quote);
    if (!Number.isFinite(price) || price <= 0) return;

    const market = getMarketInfo(symbol);
    if (!market) return;

    // First real tick from Deriv — stop simulation
    if (this.usingSimulated) this.stopSimulation();

    // Buffer price
    const prices = this.tickBuffers.get(symbol) ?? [];
    prices.push(price);
    if (prices.length > TICK_BUFFER_SIZE) prices.shift();
    this.tickBuffers.set(symbol, prices);
    this.latestPrices.set(symbol, price);
    this.lastTickMs.set(symbol, Date.now());

    // Buffer digit
    if (market.digitEnabled) {
      const digit = extractLastDigit(price, market.pipSize);
      if (digit >= 0 && digit <= 9) {
        const digits = this.digitBuffers.get(symbol) ?? [];
        digits.push(digit);
        if (digits.length > DIGIT_BUFFER_SIZE) digits.shift();
        this.digitBuffers.set(symbol, digits);
      }
    }

    // Emit for real-time SSE broadcast
    const lastDigit = market.digitEnabled ? extractLastDigit(price, market.pipSize) : -1;
    this.emit("tick", { symbol, price, lastDigit, epoch } as TickEvent);
  }

  private onAuthorize(msg: any) {
    if (msg.authorize) {
      const info: DerivAccountInfo = {
        loginid: msg.authorize.loginid,
        currency: msg.authorize.currency,
        balance: msg.authorize.balance,
        is_virtual: msg.authorize.is_virtual,
        email: msg.authorize.email,
        fullname: msg.authorize.fullname,
        country: msg.authorize.country,
      };
      for (const pending of this.pendingAuth) {
        clearTimeout(pending.timer);
        pending.resolve(info);
      }
      this.pendingAuth = [];
    } else if (msg.error && this.pendingAuth.length > 0) {
      const err = new Error(msg.error.message ?? "Authorization failed");
      for (const pending of this.pendingAuth) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pendingAuth = [];
    }
  }

  private onError(msg: any) {
    const code: string = msg.error?.code ?? "Unknown";
    const message: string = msg.error?.message ?? "";
    const sym: string | undefined = msg.echo_req?.ticks;

    // Reject any pending authorize that failed
    if (msg.echo_req?.authorize !== undefined && this.pendingAuth.length > 0) {
      const err = new Error(message || "Authorization failed");
      for (const pending of this.pendingAuth) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pendingAuth = [];
      return;
    }

    logger.warn({ code, message, symbol: sym }, "TickManager: Deriv error");

    if (!sym || !this.desiredSymbols.includes(sym)) return;

    if (code === "InvalidSymbol") {
      // Permanently remove from retry loop — this symbol no longer exists on Deriv
      this.invalidSymbols.add(sym);
      logger.warn(
        { symbol: sym, appId: APP_ID },
        "TickManager: symbol permanently invalid — marking as unavailable (symbol may have been renamed by Deriv)",
      );
      return;
    }

    if (code === "RateLimit") {
      // Back off 60 s before retrying
      setTimeout(() => {
        if (this.ws?.readyState === WebSocket.OPEN && !this.invalidSymbols.has(sym)) {
          logger.info({ symbol: sym }, "TickManager: retrying after rate limit");
          this.ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
        }
      }, 60_000);
      return;
    }

    // Transient error — short retry
    setTimeout(() => {
      if (this.ws?.readyState === WebSocket.OPEN && !this.invalidSymbols.has(sym)) {
        this.ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
      }
    }, 5_000);
  }

  // ── Keep-alive timers ──────────────────────────────────────────────────────

  private startPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPongMs > 60_000) {
        logger.warn("TickManager: no pong for 60 s, reconnecting");
        this.connect();
        return;
      }
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ ping: 1 }));
      }
    }, 25_000);
  }

  private startStaleCheck() {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = setInterval(() => {
      if (!this.isConnected || this.ws?.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      // Only re-subscribe symbols that WERE receiving ticks but went stale (> 45 s)
      const liveSymbols = this.desiredSymbols.filter(
        (s) => !this.invalidSymbols.has(s) && (this.lastTickMs.get(s) ?? 0) > 0,
      );
      for (const sym of liveSymbols) {
        if (now - (this.lastTickMs.get(sym) ?? 0) > 45_000) {
          logger.info({ symbol: sym }, "TickManager: re-subscribing stale symbol");
          this.ws!.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
        }
      }
    }, 30_000);
  }

  private stopTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.staleTimer) { clearInterval(this.staleTimer); this.staleTimer = null; }
  }

  // ── Price simulation (fallback when app_id has no Deriv symbols) ─────────────

  /** Box-Muller Gaussian random number (mean=0, std=1). */
  private gaussianRandom(): number {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  /** Push one simulated price into the tick + digit buffers (no SSE emit). */
  private pushSimulatedTick(market: (typeof DERIV_MARKETS)[0], price: number) {
    const factor = Math.pow(10, market.pipSize);
    const rounded = Math.round(price * factor) / factor;

    const prices = this.tickBuffers.get(market.symbol) ?? [];
    prices.push(rounded);
    if (prices.length > TICK_BUFFER_SIZE) prices.shift();
    this.tickBuffers.set(market.symbol, prices);
    this.latestPrices.set(market.symbol, rounded);

    if (market.digitEnabled) {
      const digit = extractLastDigit(rounded, market.pipSize);
      if (digit >= 0 && digit <= 9) {
        const digits = this.digitBuffers.get(market.symbol) ?? [];
        digits.push(digit);
        if (digits.length > DIGIT_BUFFER_SIZE) digits.shift();
        this.digitBuffers.set(market.symbol, digits);
      }
    }
  }

  /** Start synthetic price generation for every digit market. */
  startSimulation() {
    if (this.simInterval) return; // already running
    this.usingSimulated = true;
    logger.info(
      { appId: APP_ID || "(unset)" },
      "TickManager: no live symbols — starting simulated prices for digit analysis. " +
      "Set DERIV_APP_ID to your alphanumeric app ID from app.deriv.com/apps to receive live prices.",
    );

    // Seed 150 initial ticks so analysers warm up immediately
    for (const market of DERIV_MARKETS) {
      const params = SIM_PARAMS[market.symbol];
      if (!params || !market.digitEnabled) continue;
      this.simPrices.set(market.symbol, params.base);
      let price = params.base;
      for (let i = 0; i < 150; i++) {
        const delta = price * params.vol * this.gaussianRandom();
        price = Math.max(price * 0.5, price + delta);
        this.pushSimulatedTick(market, price);
      }
    }

    // Continue generating one tick per market per second (staggered)
    let idx = 0;
    this.simInterval = setInterval(() => {
      const digitMarkets = DERIV_MARKETS.filter((m) => m.digitEnabled);
      const market = digitMarkets[idx % digitMarkets.length];
      idx++;

      const params = SIM_PARAMS[market.symbol];
      if (!params) return;

      let price = this.simPrices.get(market.symbol) ?? params.base;
      const delta = price * params.vol * this.gaussianRandom();
      price = Math.max(price * 0.5, price + delta);
      this.simPrices.set(market.symbol, price);
      this.pushSimulatedTick(market, price);

      const factor = Math.pow(10, market.pipSize);
      const rounded = Math.round(price * factor) / factor;
      const lastDigit = extractLastDigit(rounded, market.pipSize);
      this.emit("tick", {
        symbol: market.symbol,
        price: rounded,
        lastDigit,
        epoch: Math.floor(Date.now() / 1000),
      } as TickEvent);
    }, Math.ceil(1000 / DERIV_MARKETS.filter((m) => m.digitEnabled).length));
  }

  stopSimulation() {
    if (!this.simInterval) return;
    clearInterval(this.simInterval);
    this.simInterval = null;
    this.usingSimulated = false;
    logger.info("TickManager: stopping simulation — real Deriv ticks taking over");
  }

  private cleanupWs() {
    this.stopTimers();
    if (this.ws) {
      try { this.ws.terminate(); } catch { /* ignore */ }
      this.ws = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 30_000);
      logger.info({ delayMs: this.reconnectDelay }, "TickManager: reconnecting");
      this.connect();
    }, this.reconnectDelay);
  }
}

export const tickManager = new DerivTickManager();

// ── getTickHistory — fetches history via WS ticks_history endpoint ─────────
// Returns ticks from the in-memory buffer if available, otherwise opens a
// short-lived WS connection to fetch historical ticks from Deriv directly.
export async function getTickHistory(symbol: string, count = 50): Promise<number[]> {
  // Return buffered data if we already have enough
  const buffered = tickManager.getTicks(symbol, count);
  if (buffered.length >= 5) return buffered;

  // Fetch from Deriv ticks_history endpoint
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(DERIV_WS_URL, { perMessageDeflate: false });
      const timeout = setTimeout(() => {
        ws.close();
        resolve([]); // no simulation — return empty if unavailable
      }, 8_000);

      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            ticks_history: symbol,
            count,
            end: "latest",
            style: "ticks",
          }),
        );
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.error) {
            clearTimeout(timeout);
            ws.close();
            logger.warn(
              { symbol, code: msg.error.code },
              "getTickHistory: Deriv error",
            );
            resolve([]);
            return;
          }
          if (msg.msg_type === "history" && msg.history?.prices) {
            clearTimeout(timeout);
            ws.close();
            resolve(msg.history.prices.map(Number));
          }
        } catch { /* ignore */ }
      });

      ws.on("error", () => {
        clearTimeout(timeout);
        ws.close();
        resolve([]);
      });
    } catch {
      resolve([]);
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
      this.ws.send(JSON.stringify({ profit_table: 1, description: 1, sort: "DESC", limit: 500 }));
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
        this.ws.send(JSON.stringify({ profit_table: 1, description: 1, sort: "DESC", limit: 500 }));
      }
    }, 60_000);
  }

  private connect() {
    if (this.ws) { try { this.ws.terminate(); } catch { /* ignore */ } this.ws = null; }
    if (!this.token) return;

    try {
      this.ws = new WebSocket(DERIV_WS_URL, { perMessageDeflate: false });
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
          this.ws!.send(JSON.stringify({ profit_table: 1, description: 1, sort: "DESC", limit: 500 }));
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
      const ws = new WebSocket(DERIV_WS_URL, { perMessageDeflate: false });
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
  // Prefer the TickManager's already-open WS to avoid opening a competing connection
  try {
    const info = await tickManager.authorizeViaWs(token);
    cachedAccountInfo = info;
    return info;
  } catch {
    // TickManager WS not ready — fall back to a dedicated connection
  }

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS_URL, { perMessageDeflate: false });
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
      const ws = new WebSocket(DERIV_WS_URL, { perMessageDeflate: false });
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
    const ws = new WebSocket(DERIV_WS_URL, { perMessageDeflate: false });
    const timeout = setTimeout(() => { ws.close(); reject(new Error("Trade execution timeout")); }, 20000);
    let authorized = false;
    let sentBuyPayload: Record<string, unknown> | null = null;

    ws.on("open", () => { ws.send(JSON.stringify({ authorize: token })); });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        logger.info({ rawMsg: msg }, "executeLiveTrade: received message");
        if (msg.error) {
          clearTimeout(timeout);
          ws.close();
          logger.error({
            derivError: msg.error,
            echoReq: msg.echo_req,
            sentBuyPayload,
          }, "Deriv rejected live trade request — full diagnostic");
          reject(new Error(msg.error.message));
          return;
        }

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
          sentBuyPayload = { buy: 1, price: params.stake, parameters: buyParams };
          logger.info({ sentBuyPayload }, "Sending live buy request to Deriv");
          ws.send(JSON.stringify(sentBuyPayload));
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
      const ws = new WebSocket(DERIV_WS_URL, { perMessageDeflate: false });
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

// NOTE: `proposal_open_contracts` is rejected outright ("UnrecognisedRequest") for this
// account/app_id combination — verified independently outside the app (raw WS script,
// with and without contract_id/subscribe, always errors). `portfolio` and `profit_table`
// work fine, so we poll those instead: portfolio tells us when the contract has left the
// open-contracts list, then profit_table gives us the ground-truth settled buy/sell price.
export async function waitForContractResult(token: string, contractId: number, timeoutMs = 30000): Promise<ContractResult> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(DERIV_WS_URL, { perMessageDeflate: false });
    let authorized = false;
    let settled = false;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const overallTimeout = setTimeout(() => finishError(new Error("Contract result timeout")), timeoutMs + 10000);

    const cleanup = () => {
      clearTimeout(overallTimeout);
      if (pollInterval) clearInterval(pollInterval);
      try { ws.close(); } catch { /* ignore */ }
    };

    const finishOk = (result: ContractResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const finishError = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    ws.on("open", () => { ws.send(JSON.stringify({ authorize: token })); });
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.error) {
          if (!authorized) { finishError(new Error(msg.error.message)); }
          // ignore transient poll errors after authorization — just keep polling
          return;
        }

        if (msg.msg_type === "authorize" && !authorized) {
          authorized = true;
          const poll = () => { if (!settled) ws.send(JSON.stringify({ portfolio: 1 })); };
          poll();
          pollInterval = setInterval(poll, 1000);
        }

        if (msg.msg_type === "portfolio") {
          const contracts: any[] = msg.portfolio?.contracts ?? [];
          const stillOpen = contracts.some((c) => Number(c.contract_id) === contractId);
          if (stillOpen) { return; }
          // Contract no longer (or not yet) in the open-contracts list. Check
          // profit_table for a settled record; if not found yet we simply keep
          // polling on the next tick (handles both "not registered yet" and
          // "already settled" without a race).
          ws.send(JSON.stringify({ profit_table: 1, limit: 10, sort: "DESC" }));
        }

        if (msg.msg_type === "profit_table") {
          const txs: any[] = msg.profit_table?.transactions ?? [];
          const tx = txs.find((t) => Number(t.contract_id) === contractId);
          if (tx) {
            const buyPrice = Number(tx.buy_price ?? 0);
            const sellPrice = Number(tx.sell_price ?? 0);
            const profit = sellPrice - buyPrice;
            finishOk({
              contractId,
              won: profit > 0,
              profit,
              exitSpot: 0,
              sellPrice,
              entrySpot: 0,
            });
          }
          // Not found yet — Deriv hasn't recorded it in profit_table yet, keep polling.
        }
      } catch { /* ignore parse errors */ }
    });
    ws.on("error", (err) => { finishError(err); });
  });
}

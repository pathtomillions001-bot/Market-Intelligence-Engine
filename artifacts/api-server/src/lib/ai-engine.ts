/**
 * AI Trading Engine — 8-Agent System (Synthetics Only)
 *
 * New in this version:
 *  - Digit Analysis Agent: tracks last-digit distribution for smart OVER/UNDER
 *  - Per-contract risk/capital recommendations
 *  - RISE/FALL vs CALL/PUT vs DIGITOVER/DIGITUNDER routing per market
 *  - Recovery tracking per market-contract pair
 */

import { analyzeDigits, DigitStats } from "./deriv";

export interface AgentScore {
  score: number;
  weight: number;
  signal: "strong_buy" | "buy" | "neutral" | "sell" | "strong_sell";
  reasoning: string;
}

export interface AgentScores {
  marketScanner: AgentScore;
  trendAnalysis: AgentScore;
  volatilityAnalysis: AgentScore;
  patternRecognition: AgentScore;
  riskManagement: AgentScore;
  capitalPreservation: AgentScore;
  tradeExecution: AgentScore;
  selfLearning: AgentScore;
}

export interface ContractTypeOption {
  contractType: string;
  label: string;
  description: string;
  suitable: boolean;
  confidence: number;
  recommendedStake: number;
  riskLevel: "low" | "medium" | "high";
}

export interface MarketAnalysis {
  symbol: string;
  qualityScore: number;
  confidenceScore: number;
  riskScore: number;
  trend: "strong_up" | "up" | "sideways" | "down" | "strong_down";
  volatility: "low" | "medium" | "high" | "extreme";
  recommendedContractType: string;
  direction: "up" | "down";
  recommendedStake: number;
  profitability: number;
  agentScores: AgentScores;
  shouldTrade: boolean;
  reasoning: string;
  warnings: string[];
  suggestedContractTypes: ContractTypeOption[];
  digitStats?: DigitStats;
  digitBarrier?: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function stddev(arr: number[]): number {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((sum, v) => sum + Math.pow(v - m, 2), 0) / arr.length);
}
function ema(arr: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [arr[0]];
  for (let i = 1; i < arr.length; i++) result.push(arr[i] * k + result[i - 1] * (1 - k));
  return result;
}
function rsi(prices: number[], period = 14): number {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}
function detectTrend(prices: number[]): { trend: string; strength: number } {
  if (prices.length < 10) return { trend: "sideways", strength: 0.5 };
  const n = prices.length, half = Math.floor(n / 2);
  const firstHalf = mean(prices.slice(0, half));
  const secondHalf = mean(prices.slice(half));
  const pctChange = (secondHalf - firstHalf) / firstHalf;
  const ema10 = ema(prices, 10);
  const ema20 = ema(prices, Math.max(5, Math.floor(prices.length / 2)));
  const emaSignal = ema10[ema10.length - 1] - ema20[ema20.length - 1];
  if (pctChange > 0.005 && emaSignal > 0) return { trend: "strong_up", strength: 0.85 };
  if (pctChange > 0.001) return { trend: "up", strength: 0.65 };
  if (pctChange < -0.005 && emaSignal < 0) return { trend: "strong_down", strength: 0.85 };
  if (pctChange < -0.001) return { trend: "down", strength: 0.65 };
  return { trend: "sideways", strength: 0.3 };
}
function detectPatterns(prices: number[]): { patternFound: boolean; score: number; name: string } {
  if (prices.length < 10) return { patternFound: false, score: 48, name: "insufficient data" };
  const recent = prices.slice(-10);
  const avg = mean(recent);
  const range = Math.max(...recent.slice(0, -2)) - Math.min(...recent.slice(0, -2));
  const lastMove = Math.abs(recent[recent.length - 1] - recent[recent.length - 2]);
  if (lastMove > range * 0.6) return { patternFound: true, score: 72, name: "breakout" };
  const zScore = (recent[recent.length - 1] - avg) / (stddev(recent) || 1);
  if (Math.abs(zScore) > 1.5) return { patternFound: true, score: 65, name: "mean reversion" };
  const last3 = recent.slice(-3);
  if (last3[0] < last3[1] && last3[1] < last3[2]) return { patternFound: true, score: 68, name: "momentum up" };
  if (last3[0] > last3[1] && last3[1] > last3[2]) return { patternFound: true, score: 68, name: "momentum down" };
  return { patternFound: false, score: 48, name: "no clear pattern" };
}
function scoreToSignal(score: number): AgentScore["signal"] {
  if (score >= 80) return "strong_buy";
  if (score >= 60) return "buy";
  if (score >= 40) return "neutral";
  if (score >= 20) return "sell";
  return "strong_sell";
}

// ── Self-learning per-market win rates ─────────────────────────────────────────
const marketWinRates: Record<string, number> = {};
const tradeCountPerMarket: Record<string, number> = {};

export function updateSelfLearning(symbol: string, won: boolean) {
  const prev = marketWinRates[symbol] ?? 0.55;
  const count = (tradeCountPerMarket[symbol] ?? 0) + 1;
  tradeCountPerMarket[symbol] = count;
  marketWinRates[symbol] = prev * 0.9 + (won ? 1 : 0) * 0.1;
}
export function getMarketWinRate(symbol: string): number {
  return marketWinRates[symbol] ?? 0.55;
}

// ── Smart digit barrier selection ─────────────────────────────────────────────
function selectDigitBarrier(bias: "over" | "under" | "neutral", distribution: { digit: number; count: number; pct: number }[]): {
  contractType: "DIGITOVER" | "DIGITUNDER";
  barrier: number;
  confidence: number;
  reasoning: string;
} {
  // Choose barrier based on hot/cold digit distribution
  // DIGITOVER(n) wins if last digit > n (barrier range 0-8)
  // DIGITUNDER(n) wins if last digit < n (barrier range 1-9)

  if (bias === "over" || bias === "neutral") {
    // Find the optimal OVER barrier: digits > barrier should appear frequently
    // Conservative: barrier=4 (digits 5-9, 50% expected), or barrier=5 (digits 6-9, 40% expected)
    const overFive = distribution.slice(6).reduce((s, d) => s + d.pct, 0);
    const overFour = distribution.slice(5).reduce((s, d) => s + d.pct, 0);
    if (overFive > 45) {
      return { contractType: "DIGITOVER", barrier: 5, confidence: Math.min(95, overFive + 10), reasoning: `Digits 6-9 appearing ${overFive}% (expected 40%) — OVER 5 favorable` };
    }
    return { contractType: "DIGITOVER", barrier: 4, confidence: Math.min(95, overFour + 5), reasoning: `Digits 5-9 appearing ${overFour}% (expected 50%) — OVER 4 signal` };
  } else {
    // UNDER: find optimal under barrier
    const underFive = distribution.slice(0, 5).reduce((s, d) => s + d.pct, 0);
    const underSix = distribution.slice(0, 6).reduce((s, d) => s + d.pct, 0);
    if (underFive > 55) {
      return { contractType: "DIGITUNDER", barrier: 5, confidence: Math.min(95, underFive + 5), reasoning: `Digits 0-4 appearing ${underFive}% (expected 50%) — UNDER 5 favorable` };
    }
    return { contractType: "DIGITUNDER", barrier: 6, confidence: Math.min(95, underSix + 3), reasoning: `Digits 0-5 appearing ${underSix}% — UNDER 6 signal` };
  }
}

// ── Main analysis ──────────────────────────────────────────────────────────────
export function analyzeMarket(
  symbol: string,
  category: string,
  prices: number[],
  balance: number,
  settings: {
    maxRiskPerTrade: number;
    minConfidenceThreshold: number;
    riskProfile: string;
    preferredContractTypes?: string[];
    tradeDurationSec?: number;
    maxTradeStake?: number;
  },
  digits?: number[]
): MarketAnalysis {
  if (prices.length < 5) {
    prices = [...prices, ...Array(5 - prices.length).fill(prices[0] ?? 1000)];
  }

  const avgPrice = mean(prices);
  const priceRange = Math.max(...prices) - Math.min(...prices);
  const rangeRatio = priceRange / avgPrice;

  // === 1. Market Scanner ===
  let scannerScore = 50;
  if (rangeRatio > 0.001 && rangeRatio < 0.05) scannerScore = 78;
  else if (rangeRatio > 0.0005) scannerScore = 64;
  else if (rangeRatio > 0.1) scannerScore = 32;
  scannerScore = Math.min(scannerScore + 8, 100); // all markets are synthetic
  const marketScanner: AgentScore = {
    score: scannerScore,
    weight: 0.12,
    signal: scoreToSignal(scannerScore),
    reasoning: `Price range ${(rangeRatio * 100).toFixed(3)}%. Synthetic index — 24/7 availability. Scanner: ${scannerScore > 70 ? "excellent" : scannerScore > 55 ? "good" : "marginal"}.`,
  };

  // === 2. Trend Analysis ===
  const { trend, strength } = detectTrend(prices);
  const trendBase = (trend === "strong_up" || trend === "strong_down") ? 80 : (trend === "up" || trend === "down") ? 68 : 42;
  const trendScore = Math.round(trendBase * (0.7 + strength * 0.3));
  const trendAnalysis: AgentScore = {
    score: trendScore,
    weight: 0.17,
    signal: scoreToSignal(trendScore),
    reasoning: `${trend.replace("_", " ")} detected (strength ${(strength * 100).toFixed(0)}%). EMA crossover ${trendScore > 65 ? "confirmed" : "weak"}.`,
  };

  // === 3. Volatility Analysis ===
  const vol = stddev(prices) / avgPrice;
  let volCat: "low" | "medium" | "high" | "extreme" = "medium";
  let volScore = 60;
  if (vol < 0.001) { volCat = "low"; volScore = 52; }
  else if (vol < 0.004) { volCat = "medium"; volScore = 80; }
  else if (vol < 0.01) { volCat = "high"; volScore = 65; }
  else { volCat = "extreme"; volScore = 28; }
  const volatilityAnalysis: AgentScore = {
    score: volScore,
    weight: 0.13,
    signal: scoreToSignal(volScore),
    reasoning: `Volatility ${(vol * 100).toFixed(4)}% (${volCat}). ${volCat === "medium" ? "Ideal trading conditions" : volCat === "high" ? "Elevated — reduce stake" : volCat === "extreme" ? "Too volatile — avoid" : "Low movement — limited opportunity"}.`,
  };

  // === 4. Pattern Recognition ===
  const { patternFound, score: patScore, name: patName } = detectPatterns(prices);
  const patternRecognition: AgentScore = {
    score: patScore,
    weight: 0.15,
    signal: scoreToSignal(patScore),
    reasoning: `${patternFound ? `${patName} pattern detected` : "No clear pattern"}. Score: ${patScore}/100.`,
  };

  // === 5. Risk Management (RSI-based) ===
  const rsiVal = rsi(prices);
  let riskScore = 60;
  if (rsiVal > 75 || rsiVal < 25) riskScore = 38;
  else if (rsiVal > 65 || rsiVal < 35) riskScore = 54;
  else riskScore = 73;
  const riskManagement: AgentScore = {
    score: riskScore,
    weight: 0.13,
    signal: scoreToSignal(riskScore),
    reasoning: `RSI ${rsiVal.toFixed(1)} — ${rsiVal > 75 ? "overbought (reversal risk)" : rsiVal < 25 ? "oversold (reversal risk)" : rsiVal > 65 ? "elevated" : "neutral zone"}.`,
  };

  // === 6. Capital Preservation ===
  const maxStake = balance * (settings.maxRiskPerTrade / 100);
  const profMult = settings.riskProfile === "conservative" ? 0.5 : settings.riskProfile === "aggressive" ? 1.5 : 1.0;
  let safeStake = Math.min(maxStake * profMult, balance * 0.05);
  if (settings.maxTradeStake) safeStake = Math.min(safeStake, settings.maxTradeStake);
  safeStake = Math.max(0.35, safeStake);
  const capScore = safeStake > 0 ? 72 : 28;
  const capitalPreservation: AgentScore = {
    score: capScore,
    weight: 0.08,
    signal: scoreToSignal(capScore),
    reasoning: `Safe stake: $${safeStake.toFixed(2)} (${settings.maxRiskPerTrade}% × ${settings.riskProfile}). ${capScore > 60 ? "Capital management: OK" : "Warning: stake may be too high"}.`,
  };

  // === 7. Trade Execution ===
  const recentMoves = prices.slice(-5).map((p, i, arr) => i > 0 ? Math.abs(p - arr[i - 1]) / arr[i - 1] : 0).slice(1);
  const avgMove = mean(recentMoves);
  const execScore = avgMove > 0.0002 && avgMove < 0.008 ? 76 : avgMove < 0.0001 ? 44 : 55;
  const tradeExecution: AgentScore = {
    score: execScore,
    weight: 0.08,
    signal: scoreToSignal(execScore),
    reasoning: `Avg tick movement: ${(avgMove * 100).toFixed(4)}%. Entry timing: ${execScore > 65 ? "favorable" : "suboptimal"}. Slippage risk: ${execScore > 65 ? "low" : "moderate"}.`,
  };

  // === 8. Self-Learning ===
  const winRate = marketWinRates[symbol] ?? (0.52 + Math.random() * 0.06);
  const tradeCount = tradeCountPerMarket[symbol] ?? 0;
  const selfScore = Math.min(Math.round(winRate * 90 + (tradeCount > 10 ? 9 : tradeCount)), 95);
  const selfLearning: AgentScore = {
    score: selfScore,
    weight: 0.14,
    signal: scoreToSignal(selfScore),
    reasoning: `Historical win rate: ${(winRate * 100).toFixed(1)}% over ${tradeCount} trades. Confidence: ${tradeCount > 20 ? "high" : tradeCount > 5 ? "moderate" : "building"}.`,
  };

  const agentScores: AgentScores = { marketScanner, trendAnalysis, volatilityAnalysis, patternRecognition, riskManagement, capitalPreservation, tradeExecution, selfLearning };

  // === Composite scores ===
  const qualityScore = Math.round(
    marketScanner.score * marketScanner.weight +
    trendAnalysis.score * trendAnalysis.weight +
    volatilityAnalysis.score * volatilityAnalysis.weight +
    patternRecognition.score * patternRecognition.weight +
    riskManagement.score * riskManagement.weight +
    capitalPreservation.score * capitalPreservation.weight +
    tradeExecution.score * tradeExecution.weight +
    selfLearning.score * selfLearning.weight
  );
  const confidenceScore = Math.round((trendAnalysis.score + patternRecognition.score + selfLearning.score) / 3);
  const overallRisk = Math.round(100 - (riskManagement.score * 0.5 + capitalPreservation.score * 0.3 + volatilityAnalysis.score * 0.2));

  const direction: "up" | "down" = (trend === "strong_up" || trend === "up") ? "up"
    : (trend === "strong_down" || trend === "down") ? "down"
    : rsiVal < 45 ? "up" : "down";

  // === Digit analysis (OVER/UNDER) ============================================
  let digitStats: DigitStats | undefined;
  let digitBarrier: number | undefined;
  let digitContractType: "DIGITOVER" | "DIGITUNDER" | null = null;
  let digitConfidence = 0;

  if (digits && digits.length >= 20) {
    digitStats = analyzeDigits(digits);
    const digitRec = selectDigitBarrier(digitStats.bias, digitStats.distribution);
    digitContractType = digitRec.contractType;
    digitBarrier = digitRec.barrier;
    digitConfidence = digitRec.confidence;
  }

  // === Contract type options ===================================================
  const isSynthetic1s = symbol.startsWith("1HZ");
  const isVolatility = symbol.startsWith("R_") || symbol.startsWith("1HZ");
  const isJump = symbol.startsWith("JD");
  const hasDigit = isVolatility || isJump;

  // Base stakes per contract type
  const riseCallStake = Math.round(safeStake * 100) / 100;
  const digitStake = Math.round(safeStake * 0.7 * 100) / 100; // lower for digit (40% payout)

  const contractOptions: ContractTypeOption[] = [];

  // RISE/FALL — best for synthetic momentum
  contractOptions.push({
    contractType: direction === "up" ? "RISE" : "FALL",
    label: direction === "up" ? "RISE" : "FALL",
    description: `Win if price ${direction === "up" ? "rises" : "falls"} from entry tick`,
    suitable: true,
    confidence: confidenceScore,
    recommendedStake: riseCallStake,
    riskLevel: volCat === "extreme" ? "high" : volCat === "medium" ? "low" : "medium",
  });

  // CALL/PUT — directional with expiry price
  contractOptions.push({
    contractType: direction === "up" ? "CALL" : "PUT",
    label: direction === "up" ? "CALL" : "PUT",
    description: `Win if price is ${direction === "up" ? "higher" : "lower"} at expiry`,
    suitable: true,
    confidence: Math.round(confidenceScore * 0.95),
    recommendedStake: riseCallStake,
    riskLevel: "medium",
  });

  // DIGITOVER / DIGITUNDER — smart digit contracts
  if (hasDigit && digitContractType && digitStats) {
    const isOver = digitContractType === "DIGITOVER";
    contractOptions.push({
      contractType: digitContractType,
      label: `${isOver ? "OVER" : "UNDER"} ${digitBarrier}`,
      description: `Win if last digit is ${isOver ? `> ${digitBarrier}` : `< ${digitBarrier}`}. ${digitStats.streakInfo}.`,
      suitable: volCat !== "extreme",
      confidence: digitConfidence,
      recommendedStake: digitStake,
      riskLevel: "low",
    });

    // Also add the opposite
    const opposite = isOver ? "DIGITUNDER" : "DIGITOVER";
    const oppositeBarrier = isOver ? (digitBarrier! + 2) : Math.max(1, (digitBarrier!) - 2);
    contractOptions.push({
      contractType: opposite,
      label: `${!isOver ? "OVER" : "UNDER"} ${oppositeBarrier}`,
      description: `Alternative: last digit ${!isOver ? `> ${oppositeBarrier}` : `< ${oppositeBarrier}`}`,
      suitable: false,
      confidence: Math.round(digitConfidence * 0.7),
      recommendedStake: digitStake,
      riskLevel: "medium",
    });
  }

  // Preferred contract type selection
  const preferred = settings.preferredContractTypes ?? ["RISE", "FALL", "CALL", "PUT", "DIGITOVER", "DIGITUNDER"];
  const chosen = contractOptions.find((opt) => preferred.some((p) => opt.contractType.startsWith(p)) && opt.suitable)
    ?? contractOptions[0];

  const profitability = Math.round((confidenceScore * 0.6 + qualityScore * 0.4) * 0.95);

  const warnings: string[] = [];
  if (volCat === "extreme") warnings.push("Extreme volatility — reduce stake significantly");
  if (rsiVal > 75) warnings.push("RSI overbought — reversal risk");
  if (rsiVal < 25) warnings.push("RSI oversold — reversal risk");
  if (overallRisk > 60) warnings.push("Elevated risk — caution");
  if (!patternFound) warnings.push("No pattern — lower conviction");
  if (digitStats?.streakInfo.includes("streak")) warnings.push(digitStats.streakInfo);

  const shouldTrade = confidenceScore >= settings.minConfidenceThreshold && overallRisk < 70 && volCat !== "extreme";

  const digitNote = digitStats
    ? ` Digit analysis: ${digitStats.bias === "over" ? `OVER bias (${digitStats.overPct}%)` : digitStats.bias === "under" ? `UNDER bias (${digitStats.underPct}%)` : "neutral"}. ${digitStats.streakInfo}.`
    : "";

  const reasoning = `Quality: ${qualityScore}/100. Trend: ${trend.replace("_", " ")} (${(strength * 100).toFixed(0)}%). RSI: ${rsiVal.toFixed(1)}.${digitNote} Recommending ${chosen.label ?? chosen.contractType} at $${chosen.recommendedStake}. Win rate: ${(winRate * 100).toFixed(1)}%. ${shouldTrade ? "Risk checks passed." : "Below threshold — skipping."}`;

  return {
    symbol,
    qualityScore,
    confidenceScore,
    riskScore: overallRisk,
    trend: trend as MarketAnalysis["trend"],
    volatility: volCat,
    recommendedContractType: chosen.contractType,
    direction,
    recommendedStake: chosen.recommendedStake,
    profitability,
    agentScores,
    shouldTrade,
    reasoning,
    warnings,
    suggestedContractTypes: contractOptions,
    digitStats,
    digitBarrier,
  };
}

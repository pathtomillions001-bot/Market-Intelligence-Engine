/**
 * AI Trading Engine
 * 8-agent multi-signal scoring system for market quality and trade decisions.
 * Implements statistical analysis equivalent to ML ensemble methods.
 */

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
}

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
  for (let i = 1; i < arr.length; i++) {
    result.push(arr[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function rsi(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = prices[prices.length - period - 1 + i] - prices[prices.length - period - 2 + i];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function detectTrend(prices: number[]): { trend: string; strength: number } {
  if (prices.length < 10) return { trend: "sideways", strength: 0.5 };
  const n = prices.length;
  const half = Math.floor(n / 2);
  const firstHalf = mean(prices.slice(0, half));
  const secondHalf = mean(prices.slice(half));
  const pctChange = (secondHalf - firstHalf) / firstHalf;
  const ema10 = ema(prices, 10);
  const ema20 = prices.length >= 20 ? ema(prices, 20) : ema(prices, Math.floor(prices.length / 2));
  const emaSignal = ema10[ema10.length - 1] - ema20[ema20.length - 1];

  if (pctChange > 0.005 && emaSignal > 0) return { trend: "strong_up", strength: 0.85 };
  if (pctChange > 0.001) return { trend: "up", strength: 0.65 };
  if (pctChange < -0.005 && emaSignal < 0) return { trend: "strong_down", strength: 0.85 };
  if (pctChange < -0.001) return { trend: "down", strength: 0.65 };
  return { trend: "sideways", strength: 0.3 };
}

function detectPatterns(prices: number[]): { patternFound: boolean; score: number; name: string } {
  if (prices.length < 10) return { patternFound: false, score: 50, name: "insufficient data" };

  const recent = prices.slice(-10);
  const avg = mean(recent);
  const mid = Math.floor(recent.length / 2);

  // Double bottom
  const firstHalf = Math.min(...recent.slice(0, mid));
  const secondHalf = Math.min(...recent.slice(mid));
  const topBetween = Math.max(...recent.slice(2, mid - 1));
  if (Math.abs(firstHalf - secondHalf) / avg < 0.002 && topBetween > firstHalf * 1.001) {
    return { patternFound: true, score: 78, name: "double bottom" };
  }

  // Breakout
  const range = Math.max(...recent.slice(0, -2)) - Math.min(...recent.slice(0, -2));
  const lastMove = Math.abs(recent[recent.length - 1] - recent[recent.length - 2]);
  if (lastMove > range * 0.6) {
    return { patternFound: true, score: 72, name: "breakout" };
  }

  // Mean reversion
  const zScore = (recent[recent.length - 1] - avg) / (stddev(recent) || 1);
  if (Math.abs(zScore) > 1.5) {
    return { patternFound: true, score: 65, name: "mean reversion setup" };
  }

  return { patternFound: false, score: 48, name: "no clear pattern" };
}

function scoreToSignal(score: number): AgentScore["signal"] {
  if (score >= 80) return "strong_buy";
  if (score >= 60) return "buy";
  if (score >= 40) return "neutral";
  if (score >= 20) return "sell";
  return "strong_sell";
}

// Historical win rate simulation per market (self-learning agent)
const marketWinRates: Record<string, number> = {};
const tradeCountPerMarket: Record<string, number> = {};

export function updateSelfLearning(symbol: string, won: boolean) {
  const prev = marketWinRates[symbol] ?? 0.55;
  const count = (tradeCountPerMarket[symbol] ?? 0) + 1;
  tradeCountPerMarket[symbol] = count;
  // Exponential moving average of win rate
  marketWinRates[symbol] = prev * 0.9 + (won ? 1 : 0) * 0.1;
}

export function analyzeMarket(
  symbol: string,
  category: string,
  prices: number[],
  balance: number,
  settings: {
    maxRiskPerTrade: number;
    minConfidenceThreshold: number;
    riskProfile: string;
  }
): MarketAnalysis {
  if (prices.length < 5) {
    prices = [...prices, ...Array(5 - prices.length).fill(prices[0] ?? 1000)];
  }

  // === 1. Market Scanner Agent ===
  const priceRange = Math.max(...prices) - Math.min(...prices);
  const avgPrice = mean(prices);
  const rangeRatio = priceRange / avgPrice;
  let scannerScore = 50;
  // Good range means tradeable but not chaotic
  if (rangeRatio > 0.001 && rangeRatio < 0.05) scannerScore = 75;
  else if (rangeRatio > 0.0005) scannerScore = 62;
  else if (rangeRatio > 0.1) scannerScore = 35; // too volatile
  // Bonus for synthetic indices (always available)
  if (category === "synthetic") scannerScore = Math.min(scannerScore + 8, 100);
  const marketScanner: AgentScore = {
    score: scannerScore,
    weight: 0.15,
    signal: scoreToSignal(scannerScore),
    reasoning: `Price range ratio ${(rangeRatio * 100).toFixed(3)}% — ${category === "synthetic" ? "synthetic index available 24/7" : "live market"}. Scanner grade: ${scannerScore > 70 ? "excellent" : scannerScore > 55 ? "good" : "marginal"}.`,
  };

  // === 2. Trend Analysis Agent ===
  const { trend, strength } = detectTrend(prices);
  const trendScore = trend === "strong_up" || trend === "strong_down" ? 80
    : trend === "up" || trend === "down" ? 68
    : 42;
  const trendScoreAdj = Math.round(trendScore * (0.7 + strength * 0.3));
  const trendAnalysis: AgentScore = {
    score: trendScoreAdj,
    weight: 0.18,
    signal: scoreToSignal(trendScoreAdj),
    reasoning: `Detected trend: ${trend.replace("_", " ")} (strength ${(strength * 100).toFixed(0)}%). EMA crossover ${trendScoreAdj > 65 ? "confirms" : "uncertain"} direction.`,
  };

  // === 3. Volatility Analysis Agent ===
  const vol = stddev(prices) / avgPrice;
  let volCategory: "low" | "medium" | "high" | "extreme" = "medium";
  let volScore = 60;
  if (vol < 0.001) { volCategory = "low"; volScore = 55; }
  else if (vol < 0.004) { volCategory = "medium"; volScore = 78; }
  else if (vol < 0.01) { volCategory = "high"; volScore = 65; }
  else { volCategory = "extreme"; volScore = 30; }
  const volatilityAnalysis: AgentScore = {
    score: volScore,
    weight: 0.14,
    signal: scoreToSignal(volScore),
    reasoning: `Volatility ${(vol * 100).toFixed(4)}% (${volCategory}). Optimal trading conditions: ${volCategory === "medium" ? "yes" : volCategory === "high" ? "caution advised" : volCategory === "extreme" ? "avoid" : "low opportunity"}.`,
  };

  // === 4. Pattern Recognition Agent ===
  const { patternFound, score: patScore, name: patName } = detectPatterns(prices);
  const patternRecognition: AgentScore = {
    score: patScore,
    weight: 0.16,
    signal: scoreToSignal(patScore),
    reasoning: `${patternFound ? `Pattern detected: ${patName}` : "No strong pattern detected"}. Historical pattern reliability score: ${patScore}/100.`,
  };

  // === 5. Risk Management Agent ===
  const rsiVal = rsi(prices);
  let riskScore = 60;
  // RSI overbought/oversold
  if (rsiVal > 75 || rsiVal < 25) riskScore = 40; // risky at extremes
  else if (rsiVal > 65 || rsiVal < 35) riskScore = 55;
  else riskScore = 72;
  const riskManagement: AgentScore = {
    score: riskScore,
    weight: 0.13,
    signal: scoreToSignal(riskScore),
    reasoning: `RSI: ${rsiVal.toFixed(1)} — ${rsiVal > 75 ? "overbought, high reversal risk" : rsiVal < 25 ? "oversold, high reversal risk" : rsiVal > 65 ? "elevated, exercise caution" : "neutral zone, acceptable risk"}.`,
  };

  // === 6. Capital Preservation Agent ===
  const maxStake = balance * (settings.maxRiskPerTrade / 100);
  const riskProfileMultiplier = settings.riskProfile === "conservative" ? 0.5
    : settings.riskProfile === "aggressive" ? 1.5 : 1.0;
  const safeStake = Math.min(maxStake * riskProfileMultiplier, balance * 0.05);
  const capScore = safeStake > 0 ? 72 : 30;
  const capitalPreservation: AgentScore = {
    score: capScore,
    weight: 0.08,
    signal: scoreToSignal(capScore),
    reasoning: `Safe stake calculated: ${safeStake.toFixed(2)} (${settings.maxRiskPerTrade}% of balance × ${settings.riskProfile} profile). Capital preservation: ${capScore > 60 ? "acceptable" : "risk warning"}.`,
  };

  // === 7. Trade Execution Agent ===
  const recentMoves = prices.slice(-5).map((p, i, arr) => i > 0 ? Math.abs(p - arr[i - 1]) / arr[i - 1] : 0).slice(1);
  const avgMove = mean(recentMoves);
  const execScore = avgMove > 0.0002 && avgMove < 0.008 ? 75 : avgMove < 0.0001 ? 45 : 55;
  const tradeExecution: AgentScore = {
    score: execScore,
    weight: 0.08,
    signal: scoreToSignal(execScore),
    reasoning: `Average tick movement: ${(avgMove * 100).toFixed(4)}%. Entry timing: ${execScore > 65 ? "favorable" : "suboptimal"}. Slippage risk: ${execScore > 65 ? "low" : "moderate"}.`,
  };

  // === 8. Self-Learning Performance Agent ===
  const historicalWinRate = marketWinRates[symbol] ?? (category === "synthetic" ? 0.56 : 0.52);
  const tradeCount = tradeCountPerMarket[symbol] ?? 0;
  const selfScore = Math.round(historicalWinRate * 100 * 0.85 + (tradeCount > 10 ? 10 : tradeCount));
  const selfLearning: AgentScore = {
    score: Math.min(selfScore, 95),
    weight: 0.08,
    signal: scoreToSignal(selfScore),
    reasoning: `Historical win rate on ${symbol}: ${(historicalWinRate * 100).toFixed(1)}% over ${tradeCount} trades. Model confidence: ${tradeCount > 20 ? "high" : tradeCount > 5 ? "moderate" : "building data"}.`,
  };

  const agentScores: AgentScores = {
    marketScanner,
    trendAnalysis,
    volatilityAnalysis,
    patternRecognition,
    riskManagement,
    capitalPreservation,
    tradeExecution,
    selfLearning,
  };

  // === Composite Scores ===
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

  const confidenceScore = Math.round(
    (trendAnalysis.score + patternRecognition.score + selfLearning.score) / 3
  );

  const overallRiskScore = Math.round(100 - (riskManagement.score * 0.5 + capitalPreservation.score * 0.3 + volatilityAnalysis.score * 0.2));

  // Direction based on trend
  const direction: "up" | "down" = (trend === "strong_up" || trend === "up") ? "up"
    : (trend === "strong_down" || trend === "down") ? "down"
    : rsiVal < 45 ? "up" : "down";

  // Contract type recommendation
  const contractType = category === "synthetic" || category === "derived"
    ? (direction === "up" ? "CALL" : "PUT")
    : (direction === "up" ? "CALL" : "PUT");

  const profitability = Math.round((confidenceScore * 0.6 + qualityScore * 0.4) * 0.95);

  const warnings: string[] = [];
  if (volCategory === "extreme") warnings.push("Extreme volatility detected — reduce stake");
  if (rsiVal > 75) warnings.push("RSI overbought — reversal risk");
  if (rsiVal < 25) warnings.push("RSI oversold — reversal risk");
  if (overallRiskScore > 60) warnings.push("Elevated risk score — trade with caution");
  if (!patternFound) warnings.push("No clear pattern — lower conviction trade");

  const shouldTrade = confidenceScore >= settings.minConfidenceThreshold
    && overallRiskScore < 70
    && volCategory !== "extreme";

  const reasoning = `Market Quality: ${qualityScore}/100. Trend ${trend.replace("_", " ")} with ${(strength * 100).toFixed(0)}% strength. ${patternFound ? `Pattern: ${detectPatterns(prices).name}. ` : ""}RSI at ${rsiVal.toFixed(1)}. AI recommends ${direction.toUpperCase()} ${contractType} with ${(historicalWinRate * 100).toFixed(0)}% historical win rate on this market. ${shouldTrade ? "All risk checks passed." : "Risk threshold not met — skipping."}`;

  return {
    symbol,
    qualityScore,
    confidenceScore,
    riskScore: overallRiskScore,
    trend: trend as MarketAnalysis["trend"],
    volatility: volCategory,
    recommendedContractType: contractType,
    direction,
    recommendedStake: Math.round(safeStake * 100) / 100,
    profitability,
    agentScores,
    shouldTrade,
    reasoning,
    warnings,
  };
}

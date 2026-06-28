/**
 * Master Decision Agent
 *
 * RESPONSIBILITY: Aggregate all agent outputs into a single, final, explainable
 * trade decision. This is the only agent that can say "trade" or "skip".
 *
 * Decision logic (ALL of the following must be satisfied to trade):
 *   1. Risk manager does NOT have a hard stop
 *   2. EV calculator found at least one positive-EV (or near-breakeven direction) option
 *   3. Execution timing score ≥ threshold (48 for direction, 55 for digit)
 *   4. Weighted agent consensus score ≥ minConfidenceThreshold
 *   5. Performance feedback not in "severely drifting" state
 *
 * Task 2 fix — Rise/Fall execution:
 *   Direction products (RISE/FALL/CALL/PUT) get a relaxed EV gate when the
 *   weighted consensus is high (≥60). They are allowed to fire with near-zero EV
 *   (EV > -0.008 per $1 stake) because:
 *   a) The timing agent already uses threshold=48 for direction (not 55)
 *   b) 1.91x payout only needs 52.4% win probability — achievable with good momentum
 *   c) Blocking all direction trades because EV is -0.2% is overcorrecting
 *
 * Agent weights (used for consensus score):
 *   - EV Calculator:         30% (most important — EV is truth)
 *   - Direction/Digit:       20% (core edge signal)
 *   - Risk Manager:          20% (safety gate)
 *   - Market Regime:         10% (context)
 *   - Execution Timing:      10% (entry quality)
 *   - Performance Feedback:   5% (historical validation)
 *   - Feature Engineering:    5% (data quality)
 */

import type {
  AgentOutput,
  CoordinatorOutput,
  MarketRegime,
  ProductRecommendation,
  ProductType,
  ScanContext,
} from "./types";
import { scoreToSignal } from "./types";
import type { EVResult } from "./ev-calculator";
import type { RiskDecision } from "./risk-manager";
import type { TimingResult } from "./execution-timing";
import type { StrategyStats } from "./performance-feedback";
import type { RegimeOutput } from "./market-regime";

// ── Agent weights ─────────────────────────────────────────────────────────────
const AGENT_WEIGHTS: Record<string, number> = {
  evCalculator:        0.30,
  direction:           0.15,
  digitDistribution:   0.15,
  riskManager:         0.20,
  marketRegime:        0.10,
  executionTiming:     0.10,
  performanceFeedback: 0.05,
  featureEngineering:  0.05,
};

// Normalize weights (direction + digit are mutually exclusive — only one applies)
function getEffectiveWeights(agents: Record<string, AgentOutput>): Record<string, number> {
  const weights = { ...AGENT_WEIGHTS };
  const hasDirection = agents["direction"] !== undefined;
  const hasDigit = agents["digitDistribution"] !== undefined;

  if (hasDirection && !hasDigit) {
    weights["direction"] = 0.30; // absorb digit weight
    weights["digitDistribution"] = 0;
  } else if (hasDigit && !hasDirection) {
    weights["digitDistribution"] = 0.30;
    weights["direction"] = 0;
  }

  // Normalize so weights sum to 1
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total > 0) {
    for (const k of Object.keys(weights)) weights[k] /= total;
  }
  return weights;
}

function computeWeightedScore(agents: Record<string, AgentOutput>): number {
  const weights = getEffectiveWeights(agents);
  let score = 0;
  let totalWeight = 0;
  for (const [id, agent] of Object.entries(agents)) {
    const w = weights[id] ?? 0;
    if (w > 0) { score += agent.score * w; totalWeight += w; }
  }
  return totalWeight > 0 ? score / totalWeight : 50;
}

// ── Direction product detection ────────────────────────────────────────────────
function isDirectionProduct(product: ProductType | string | undefined): boolean {
  return ["RISE", "FALL", "CALL", "PUT"].includes(product ?? "");
}

// ── Trend direction from probabilities ───────────────────────────────────────

function trendFromProb(probUp: number): CoordinatorOutput["trend"] {
  if (probUp > 0.68) return "strong_up";
  if (probUp > 0.55) return "up";
  if (probUp < 0.32) return "strong_down";
  if (probUp < 0.45) return "down";
  return "sideways";
}

function volCategoryFromVol(vol20: number): CoordinatorOutput["volatility"] {
  if (vol20 > 0.01) return "extreme";
  if (vol20 > 0.004) return "high";
  if (vol20 > 0.001) return "medium";
  return "low";
}

// ── Master decision ───────────────────────────────────────────────────────────

export interface MasterDecisionInputs {
  ctx: ScanContext;
  agents: Record<string, AgentOutput>;
  bestEV: EVResult | null;
  riskDecision: RiskDecision;
  timingResult: TimingResult;
  strategyStats: StrategyStats;
  regimeOutput: RegimeOutput;
  probUp: number;        // from direction agent (0–1)
  vol20: number;         // from features
  digitStats?: import("../deriv").DigitStats;
  optimizedDuration?: number;   // from duration optimizer
}

export function makeFinalDecision(inputs: MasterDecisionInputs): {
  output: CoordinatorOutput;
  masterAgent: AgentOutput;
} {
  const { ctx, agents, bestEV, riskDecision, timingResult, strategyStats, regimeOutput, probUp, vol20, digitStats, optimizedDuration } = inputs;
  const t0 = Date.now();
  const settings = ctx.settings;

  const weightedScore = computeWeightedScore(agents);
  const rejectReasons: string[] = [];

  const candidateProduct = bestEV?.product;
  const isDirProduct = isDirectionProduct(candidateProduct);

  // ── Gate 1: Risk hard stop ───────────────────────────────────────────────
  if (riskDecision.hardStop) {
    rejectReasons.push(`Risk gate: ${riskDecision.hardStopReason}`);
  }

  // ── Gate 2: EV gate ───────────────────────────────────────────────────────
  // For direction products: allow near-zero negative EV when consensus is strong.
  // Near-zero = EV > -0.008 (i.e., -0.8% per dollar, vs payout gap of ~0.5%)
  // This prevents blocking all RISE/FALL trades when the direction signal is clear.
  if (!bestEV) {
    rejectReasons.push("No EV calculation available");
  } else if (!bestEV.isPositiveEV) {
    if (isDirProduct && weightedScore >= 60 && bestEV.expectedValue > -0.008) {
      // Allow marginal negative EV direction trade when consensus is high
    } else if (settings.requirePositiveEv) {
      rejectReasons.push(`No positive-EV opportunity. Best EV: ${(bestEV.expectedValue * 100).toFixed(1)}%`);
    }
  }

  // ── Gate 3: Timing ────────────────────────────────────────────────────────
  if (!timingResult.isGoodTiming) {
    rejectReasons.push(`Poor timing: ${timingResult.waitReason ?? "score below threshold"}`);
  }

  // ── Gate 4: Weighted consensus score ─────────────────────────────────────
  const minScore = settings.minConfidenceThreshold;
  if (weightedScore < minScore) {
    rejectReasons.push(`Consensus score ${weightedScore.toFixed(0)} below threshold ${minScore}`);
  }

  // ── Gate 5: Severely drifting strategy ───────────────────────────────────
  if (strategyStats.isDrifting && strategyStats.hasEnoughData) {
    rejectReasons.push("Strategy is drifting — recent win rate significantly below long-term");
  }

  const shouldTrade = rejectReasons.length === 0;

  // ── Determine trade duration ──────────────────────────────────────────────
  const tradeDuration = optimizedDuration ?? settings.tradeDurationSec;

  // ── Build recommendation ──────────────────────────────────────────────────
  let recommendation: ProductRecommendation;

  if (bestEV) {
    const product = bestEV.product as ProductType;
    const stake = riskDecision.recommendedStake > 0 ? riskDecision.recommendedStake : bestEV.stake;

    recommendation = {
      product,
      barrier: bestEV.barrier,
      winProbability: Math.round(bestEV.winProbability * 100),
      payoutMultiplier: bestEV.payoutMultiplier,
      expectedValue: bestEV.expectedValue * stake,   // in dollars
      breakevenWinRate: bestEV.breakevenWinRate * 100,
      duration: tradeDuration,
      stake,
      reasoning: `${product}${bestEV.barrier !== undefined ? ` barrier=${bestEV.barrier}` : ""}: EV=${(bestEV.expectedValue * 100).toFixed(1)}% per $1 stake, P(win)=${(bestEV.winProbability * 100).toFixed(1)}%, payout ${bestEV.payoutMultiplier}x. Duration: ${tradeDuration}t.`,
    };
  } else {
    // Fallback when no EV found — use direction signal but mark as no-trade
    const dirAgent = agents["direction"];
    const probUpLocal = dirAgent?.data?.["probUp"] as number ?? 0.5;
    const product: ProductType = probUpLocal >= 0.5 ? "RISE" : "FALL";
    recommendation = {
      product,
      winProbability: Math.round(probUpLocal * 100),
      payoutMultiplier: 1.91,
      expectedValue: 0,
      breakevenWinRate: 52.4,
      duration: tradeDuration,
      stake: riskDecision.recommendedStake,
      reasoning: "No positive-EV opportunity — recommend waiting.",
    };
  }

  // ── Build output metrics ──────────────────────────────────────────────────
  const qualityScore = Math.round(weightedScore);
  const confidenceScore = Math.round(
    (bestEV ? Math.min(100, 50 + bestEV.edge * 500) : 30) * 0.5 +
    weightedScore * 0.5
  );

  const trend = trendFromProb(probUp);
  const direction: "up" | "down" = probUp >= 0.5 ? "up" : "down";
  const volatility = volCategoryFromVol(vol20);

  const warnings: string[] = [];
  if (volatility === "extreme") warnings.push("Extreme volatility — reduce stake significantly");
  if (strategyStats.isDrifting) warnings.push("Strategy drifting — recent performance below average");
  if (riskDecision.riskLevel === "high" || riskDecision.riskLevel === "critical") {
    warnings.push(`Risk level: ${riskDecision.riskLevel.toUpperCase()}`);
  }
  if (bestEV && bestEV.edge < 0.02 && bestEV.isPositiveEV) warnings.push("Marginal EV edge — consider waiting for stronger setup");
  if (timingResult.waitReason) warnings.push(`Timing: ${timingResult.waitReason}`);
  if (isDirProduct && bestEV && !bestEV.isPositiveEV && shouldTrade) {
    warnings.push("Near-breakeven EV — direction model consensus justified this trade");
  }

  const reasonParts = [
    `Quality: ${qualityScore}/100.`,
    `Consensus: ${weightedScore.toFixed(0)}/100.`,
    bestEV ? `Best EV: ${(bestEV.expectedValue * 100).toFixed(1)}% (${bestEV.product}).` : "No positive EV.",
    `Regime: ${regimeOutput.regime.replace("_", " ")}.`,
    `Risk: ${riskDecision.riskLevel}.`,
    `Duration: ${tradeDuration}t.`,
    shouldTrade ? "✓ All gates passed — executing." : `✗ SKIP: ${rejectReasons[0]}`,
  ];

  const reasoning = reasonParts.join(" ");

  // Master agent output
  const masterScore = shouldTrade ? qualityScore : 20;
  const masterAgent: AgentOutput = {
    agentId: "masterDecision",
    score: masterScore,
    confidence: shouldTrade ? confidenceScore : 0,
    signal: scoreToSignal(masterScore),
    reasoning,
    data: {
      shouldTrade,
      rejectReasons,
      recommendation,
      weightedScore,
      qualityScore,
      optimizedDuration,
    },
    executionTimeMs: Date.now() - t0,
  };

  // Merge all agents including master
  const allAgents = { ...agents, masterDecision: masterAgent };

  const output: CoordinatorOutput = {
    symbol: ctx.symbol,
    displayName: ctx.displayName,
    category: ctx.category,
    shouldTrade,
    rejectReason: rejectReasons.length > 0 ? rejectReasons.join("; ") : undefined,
    recommendation,
    regime: regimeOutput.regime,
    agents: allAgents,
    qualityScore,
    confidenceScore,
    riskScore: Math.round(100 - riskDecision.riskBudget * 100),
    trend,
    volatility,
    direction,
    warnings,
    reasoning,
    digitStats,
  };

  return { output, masterAgent };
}

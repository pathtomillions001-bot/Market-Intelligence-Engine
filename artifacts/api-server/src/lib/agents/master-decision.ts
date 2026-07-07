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

  // ── Gate 2: EV gate (barrier-characteristic-aware) ───────────────────────
  // The user may configure ANY valid barrier (OVER 0–8, UNDER 1–9).
  // We must NOT gate on specific hardcoded barrier values (2, 7, 4, 5) because
  // those would silently ignore every other valid barrier the user might choose.
  //
  // Instead, gate on the THEORETICAL WIN RATE of the chosen barrier:
  //
  //   High win-rate barriers (theoretical ≥ 60%):
  //     e.g. OVER 0/1/2/3, UNDER 7/8/9
  //     Positive EV is mathematically impossible (payout doesn't compensate for
  //     high win expectation). Gate on EDGE > 0 — actual win rate must exceed
  //     the theoretical baseline, confirming a favourable market skew.
  //
  //   Mid-range barriers (theoretical 40–60%):
  //     e.g. OVER 4/5, UNDER 4/5
  //     These pay higher (1.63×–1.96×) but still rarely yield positive EV.
  //     Allow EV ≥ -0.15 (wide gate — rely on relative-favourability scoring).
  //
  //   Low win-rate barriers (theoretical < 40%):
  //     e.g. OVER 6/7/8, UNDER 1/2/3
  //     High payout (2.45×–4.90×). Gate at EV ≥ -0.06 — closer to breakeven.
  //
  //   Direction products (CALL/PUT): EV ≥ -0.008 when consensus is high, else -0.06.
  if (!bestEV) {
    rejectReasons.push("No EV data — market data insufficient to evaluate");
  } else {
    const isDigitProduct = bestEV.product === "DIGITOVER" || bestEV.product === "DIGITUNDER";

    if (isDigitProduct && bestEV.barrier !== undefined) {
      // Derive the theoretical win rate for the user's chosen barrier
      const theoreticalWinRate = bestEV.product === "DIGITOVER"
        ? Math.max(0, (9 - bestEV.barrier) / 10)   // OVER N: wins when digit > N
        : Math.max(0, bestEV.barrier / 10);          // UNDER N: wins when digit < N

      if (theoreticalWinRate >= 0.60) {
        // High win-rate barrier — positive EV impossible; gate on edge > 0
        if (bestEV.edge <= 0) {
          rejectReasons.push(
            `No edge on ${bestEV.product} barrier=${bestEV.barrier}: ` +
            `P(win)=${(bestEV.winProbability * 100).toFixed(1)}% not above ` +
            `theoretical ${(theoreticalWinRate * 100).toFixed(0)}% baseline`
          );
        }
      } else if (theoreticalWinRate >= 0.40) {
        // Mid-range barrier — allow wider EV tolerance; scoring handles selection
        if (bestEV.expectedValue < -0.15) {
          rejectReasons.push(`Mid-range barrier EV too negative: ${(bestEV.expectedValue * 100).toFixed(1)}% on ${bestEV.product} ${bestEV.barrier}`);
        }
      } else {
        // Low win-rate (high payout) barrier — require closer to breakeven
        if (bestEV.expectedValue < -0.06) {
          rejectReasons.push(`High-payout barrier EV too negative: ${(bestEV.expectedValue * 100).toFixed(1)}% on ${bestEV.product} ${bestEV.barrier}`);
        }
      }
    } else if (!isDigitProduct) {
      // Direction products (CALL/PUT/RISE/FALL)
      if (bestEV.expectedValue < -0.06) {
        rejectReasons.push(`EV too negative: ${(bestEV.expectedValue * 100).toFixed(1)}% — no tradeable opportunity`);
      }
    }
  }
  // requirePositiveEv is now advisory only (logged as a warning, not a blocker)

  // ── Gate 3: Timing ────────────────────────────────────────────────────────
  // Advisory-only: poor timing is logged as a warning but never blocks execution.
  // The tournament already picked the best-timing market across all groups;
  // hard-blocking here would freeze the engine in normal market conditions.
  // Only veto on an extreme outlier tick (z-score) to avoid chasing a spike.
  if (!timingResult.notOnExtreme) {
    rejectReasons.push(`Outlier tick — waiting for normalisation (z=${timingResult.waitReason})`);
  }

  // ── Gate 4: Weighted consensus score ─────────────────────────────────────
  // Use the lower of the user setting and 50 so the engine keeps trading even
  // if the user accidentally set a very high threshold.
  // During a loss streak, raise the minimum threshold proportionally — each consecutive
  // loss adds 3 points (max +15), demanding stronger multi-agent consensus before trading.
  {
    const sessionLosses = ctx.daily.consecutiveLosses;
    const lossStreakBoost = Math.min(sessionLosses * 3, 15);
    const minScore = Math.min(settings.minConfidenceThreshold, 50) + lossStreakBoost;
    if (weightedScore < minScore) {
      const streakNote = sessionLosses >= 2 ? ` (incl. +${lossStreakBoost}pt loss-streak guard)` : "";
      rejectReasons.push(`Consensus score ${weightedScore.toFixed(0)} below threshold ${minScore}${streakNote}`);
    }
  }

  // ── Gate 5: Drifting strategy — advisory only ─────────────────────────────
  // Drifting is a warning, not a hard stop. The engine should keep trading and
  // let the recovery mechanism handle underperforming strategies.

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
    // Fallback when no EV found — respect preferredContractTypes; NEVER use CALL/PUT
    // if the user has disabled direction types.
    const dirAgent = agents["direction"];
    const probUpLocal = dirAgent?.data?.["probUp"] as number ?? 0.5;
    const preferred = ctx.settings.preferredContractTypes;
    const wantDir = preferred.some((t) => ["CALL", "PUT", "RISE", "FALL"].includes(t));
    const wantOU  = preferred.some((t) => t === "DIGITOVER" || t === "DIGITUNDER");
    const wantEO  = preferred.some((t) => t === "DIGITEVEN" || t === "DIGITODD");
    const product: ProductType = wantDir
      ? (probUpLocal >= 0.5 ? "CALL" : "PUT")
      : wantOU  ? "DIGITOVER"
      : wantEO  ? "DIGITEVEN"
      : (probUpLocal >= 0.5 ? "CALL" : "PUT");   // absolute last resort
    recommendation = {
      product,
      winProbability: Math.round(probUpLocal * 100),
      payoutMultiplier: wantDir ? 1.91 : 1.95,
      expectedValue: 0,
      breakevenWinRate: wantDir ? 52.4 : 51.3,
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
  if (strategyStats.isDrifting && strategyStats.hasEnoughData) warnings.push("Strategy drifting — recent performance below long-term average");
  if (bestEV && !bestEV.isPositiveEV && settings.requirePositiveEv) warnings.push(`Advisory: EV is ${(bestEV.expectedValue * 100).toFixed(1)}% (requirePositiveEV preference noted)`);
  if (!timingResult.isGoodTiming) warnings.push(`Timing advisory: ${timingResult.waitReason ?? "score below preferred threshold"}`);
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

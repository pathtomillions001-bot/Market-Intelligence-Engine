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

  // ── Gate 2: EV gate (product-aware) ──────────────────────────────────────
  // For tier-1 digit barriers (OVER 2, UNDER 8), positive EV is mathematically
  // impossible: OVER 2 payout is 1.19x → breakeven win rate is 84% — unreachable.
  // The real signal is EDGE: actual win rate > theoretical 70%.
  // For all other products, require EV > -0.06.
  if (!bestEV) {
    rejectReasons.push("No EV data — market data insufficient to evaluate");
  } else {
    // ── Dynamic tier classification using user-configured barriers ───────────
    // Use the exact barriers the user configured — no range scanning.
    // Defaults match the DB schema so a missing settings row behaves consistently.
    const normalOverBarrier    = ctx.settings.normalOverDigit   ?? 1;
    const normalUnderBarrier   = ctx.settings.normalUnderDigit  ?? 8;
    const recoveryOverBarrier  = ctx.settings.recoveryOverDigit  ?? 3;
    const recoveryUnderBarrier = ctx.settings.recoveryUnderDigit ?? 6;

    // Exact match: the EV tournament now only ever produces the one barrier the
    // user chose, so tier classification is a simple equality check.
    const isDigitTier1 = (
      (bestEV.product === "DIGITOVER"  &&
        bestEV.barrier === normalOverBarrier) ||
      (bestEV.product === "DIGITUNDER" &&
        bestEV.barrier === normalUnderBarrier)
    );
    const isDigitTier2 = (
      (bestEV.product === "DIGITOVER"  &&
        bestEV.barrier === recoveryOverBarrier) ||
      (bestEV.product === "DIGITUNDER" &&
        bestEV.barrier === recoveryUnderBarrier)
    );
    const isDigitMatch = bestEV.product === "DIGITMATCH";
    const isDigitDiff  = bestEV.product === "DIGITDIFF";

    if (isDigitMatch) {
      // DIGITMATCH → ~10% theoretical win, 9.0x payout.
      // Breakeven frequency = 1/9 ≈ 11.1%. Require EV > -0.05 (digit appears
      // at roughly fair odds or better). The 9× payout in recovery mode means
      // even a near-fair digit frequency is worth trading to cover the debt cheaply.
      if (bestEV.expectedValue < -0.05) {
        rejectReasons.push(
          `DIGITMATCH digit=${bestEV.barrier}: EV ${(bestEV.expectedValue * 100).toFixed(1)}% — digit too cold (need > -5%)`,
        );
      }
    } else if (isDigitDiff) {
      // DIGITDIFF → ~90-96% theoretical win, 1.04x payout.
      // Positive EV requires >96.2% win rate — nearly impossible in practice.
      // Gate on EV > -0.05 instead of edge > 0: even at 93% win the near-certain
      // wins provide strong portfolio stability and pair well with MATCH recovery.
      if (bestEV.expectedValue < -0.05) {
        rejectReasons.push(
          `DIGITDIFF digit=${bestEV.barrier}: win rate ${(bestEV.winProbability * 100).toFixed(1)}% too low (EV ${(bestEV.expectedValue * 100).toFixed(1)}%, need > -5%)`,
        );
      }
    } else if (isDigitTier1) {
      // Tier-1 (user's normal barriers): use a lenient EV gate instead of strict edge > 0.
      //
      // WHY: in near-uniform Deriv synthetic markets the theoretical win probability for
      // safe barriers sits ~70–80 % while the payout breakeven sits at 84–92 %. Requiring
      // edge > 0 (win > breakeven) is therefore mathematically impossible unless the digit
      // distribution is heavily skewed — causing the engine to NEVER fire for these barriers.
      //
      // The EV > -0.08 gate instead allows trades when the configured barrier is showing
      // at least partial statistical favourability from the Bayesian + Markov ensemble.
      // Example: OVER 1 (payout 1.08×) passes when digits 0+1 combined appear ≤ 14.8 %
      // of the time (i.e. both are somewhat cold), giving P(win) ≥ 85.2 %.
      if (bestEV.expectedValue < -0.08) {
        rejectReasons.push(
          `Normal barrier EV too weak: ${bestEV.product} barrier=${bestEV.barrier}: ` +
          `EV ${(bestEV.expectedValue * 100).toFixed(1)}% < -8% — wait for digit skew`,
        );
      }
    } else if (isDigitTier2) {
      // Tier-2 (user's recovery barriers): slightly wider EV gate — higher payouts
      if (bestEV.expectedValue < -0.15) {
        rejectReasons.push(`Recovery barrier EV too negative: ${(bestEV.expectedValue * 100).toFixed(1)}%`);
      }
    } else if (bestEV.expectedValue < -0.06) {
      // All other products: hard-block when EV is genuinely terrible
      rejectReasons.push(`EV too negative: ${(bestEV.expectedValue * 100).toFixed(1)}% — no tradeable opportunity`);
    }
  }
  // requirePositiveEv is now advisory only (logged as a warning, not a blocker)

  // ── Gate 3: Timing — NOW A HARD GATE ─────────────────────────────────────
  // Direction trades: blocked when timingScore < 52. Entering at the wrong momentum
  // phase or during velocity spikes is a primary source of avoidable losses on
  // Rise/Fall contracts; raising from 48 → 52 requires meaningfully better entry
  // conditions to reduce consecutive-loss exposure.
  // Digit trades: blocked when timingScore < 45. Less velocity-sensitive but still
  // needs stable tick conditions for digit predictions to be reliable.
  // Both: always veto on extreme z-score outlier tick to avoid chasing spikes.
  {
    const timingHardThreshold = isDirProduct ? 52 : 45;
    if (!timingResult.notOnExtreme) {
      rejectReasons.push(`Outlier tick — waiting for normalisation (z=${timingResult.waitReason ?? "extreme"})`);
    } else if (timingResult.timingScore < timingHardThreshold) {
      rejectReasons.push(`Timing gate: score ${timingResult.timingScore}/100 below ${timingHardThreshold} — suboptimal entry conditions`);
    }
  }

  // ── Gate 4: Weighted consensus score ─────────────────────────────────────
  // Use the ACTUAL user-configured threshold — the old Math.min(..., 50) cap was
  // silently ignoring any setting above 50, which defeated the purpose of the control.
  // During a loss streak, raise the bar aggressively — each consecutive loss adds
  // 5 points (max +30), demanding much stronger multi-agent consensus before trading.
  //
  // EXCEPTION — recovery-mode trades: the streak boost must NOT apply when the engine
  // is executing a recovery trade (DIGITMATCH for high-payout coverage, or DIGITOVER/
  // DIGITUNDER at the user's recovery barriers). The boost raises the threshold at
  // exactly the moment these trades need to fire, making recovery nearly impossible.
  // These contract types already have their own EV and timing gates; blocking recovery
  // further with a consensus boost defeats the purpose of the recovery system.
  {
    const sessionLosses = ctx.daily.consecutiveLosses;
    // Re-derive recovery-barrier classification here so Gate 4 doesn't depend on the
    // Gate 2 local variables (those are inside a separate block scope).
    const recOverBarrier  = ctx.settings.recoveryOverDigit  ?? 3;
    const recUnderBarrier = ctx.settings.recoveryUnderDigit ?? 6;
    const isRecoveryTrade = candidateProduct === "DIGITMATCH" ||
      (bestEV?.product === "DIGITOVER"  && bestEV?.barrier === recOverBarrier) ||
      (bestEV?.product === "DIGITUNDER" && bestEV?.barrier === recUnderBarrier);
    const lossStreakBoost = isRecoveryTrade ? 0 : Math.min(sessionLosses * 5, 30);
    const minScore = (settings.minConfidenceThreshold ?? 50) + lossStreakBoost;
    if (weightedScore < minScore) {
      const streakNote = (!isRecoveryTrade && sessionLosses >= 2) ? ` (incl. +${lossStreakBoost}pt loss-streak guard)` : "";
      rejectReasons.push(`Consensus score ${weightedScore.toFixed(0)} below threshold ${minScore}${streakNote}`);
    }
  }

  // ── Gate 5: Strategy drift — semi-hard gate ───────────────────────────────
  // Mild drift (recent WR ≥ 40%): advisory warning only — engine keeps trading.
  // Severe drift (recent WR < 40%, ≥20 trades): hard block — this setup is
  // demonstrably broken and continuing will compound losses, not recover them.
  if (
    strategyStats.isDrifting &&
    strategyStats.hasEnoughData &&
    strategyStats.recentWinRate < 0.40 &&
    strategyStats.totalTrades >= 20
  ) {
    rejectReasons.push(
      `Severe drift gate: recent WR ${(strategyStats.recentWinRate * 100).toFixed(1)}% ` +
      `vs long-term ${(strategyStats.longTermWinRate * 100).toFixed(1)}% ` +
      `over ${strategyStats.totalTrades} trades — blocked until WR recovers above 40%`
    );
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
    // Fallback when no EV found — respect preferredContractTypes; NEVER use CALL/PUT
    // if the user has disabled direction types.
    const dirAgent = agents["direction"];
    const probUpLocal = dirAgent?.data?.["probUp"] as number ?? 0.5;
    const preferred = ctx.settings.preferredContractTypes;
    const wantDir = preferred.some((t) => ["CALL", "PUT", "RISE", "FALL"].includes(t));
    const wantOU  = preferred.some((t) => t === "DIGITOVER" || t === "DIGITUNDER");
    const wantEO  = preferred.some((t) => t === "DIGITEVEN" || t === "DIGITODD");
    const wantMD  = preferred.some((t) => t === "DIGITMATCH" || t === "DIGITDIFF");
    const product: ProductType = wantDir
      ? (probUpLocal >= 0.5 ? "CALL" : "PUT")
      : wantOU  ? "DIGITOVER"
      : wantEO  ? "DIGITEVEN"
      : wantMD  ? "DIGITMATCH"
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

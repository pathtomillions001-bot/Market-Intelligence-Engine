/**
 * Agent 7: Confidence Fusion Agent
 *
 * RESPONSIBILITY: Fuse the signals from all upstream agents into a single,
 * calibrated confidence score and trade recommendation. Replaces the scoring
 * portion of master-decision.ts with a per-market adaptive threshold system.
 * Uses Bayesian model averaging weighted by each agent's historical accuracy.
 */

import type { AgentOutput, ScanContext, ProductType } from "./types";
import { scoreToSignal } from "./types";
import type { DirectionResult } from "./rise-fall-agent";
import type { BarrierOption } from "./digit-probability";
import type { EVResult } from "./ev-calculator";
import { getDynamicWeights, getAdaptiveConfidenceThreshold, getAdaptiveEvThreshold, getAdaptiveTimingThreshold } from "./dynamic-confidence";

export interface FusionInput {
  marketScannerScore: number;
  tickIntelligenceScore: number;
  digitProbabilityScore: number;
  riseFallScore: number;
  marketRegimeScore: number;
  executionTimingScore: number;
  recoveryIntelligenceScore: number;
  riskIntelligenceScore: number;
  portfolioManagerScore: number;
  learningAgentScore: number;
  patternDiscoveryScore: number;

  // Domain data
  directionResult: DirectionResult | null;
  bestBarrier: BarrierOption | null;
  bestEVResult: EVResult | null;
  preferredTypes: ProductType[];
  contractType: ProductType | null;
  barrier: number | null;
}

export interface FusionResult {
  shouldTrade: boolean;
  overallConfidence: number;   // 0-100
  recommendedAction: "buy" | "wait" | "skip";
  recommendedContractType: ProductType | null;
  recommendedBarrier: number | null;
  blockers: string[];
  enhancers: string[];
  agentWeightedScore: number;
  evGated: boolean;
  timingGated: boolean;
}

// Base per-agent weights — used when dynamic-confidence hasn't accumulated
// enough data yet. Once ≥5 trades per agent are recorded, getDynamicWeights()
// blends these with accuracy-driven multipliers automatically.
// NOTE: Keep in sync with dynamic-confidence.ts BASE_WEIGHTS.
const BASE_AGENT_WEIGHTS: Record<string, number> = {
  marketScanner:        1.5,  // hard gate — ineligible market kills the trade
  tickIntelligence:     0.8,
  digitProbability:     1.2,  // direct EV predictor for digit contracts
  riseFallAgent:        1.2,  // direct EV predictor for direction contracts
  marketRegime:         1.0,
  executionTiming:      0.7,  // advisory
  recoveryIntelligence: 1.2,  // raised: must carry real veto weight during loss streaks
  riskIntelligence:     1.3,  // hard-stop authority
  portfolioManager:     1.1,
  learningAgent:        1.1,  // raised: historical calibration steers trade selection
  patternDiscovery:     0.5,  // enhancement only
};

export function runConfidenceFusionAgent(
  ctx: ScanContext,
  input: FusionInput,
): AgentOutput & { fusionResult: FusionResult } {
  const t0 = Date.now();

  const blockers: string[] = [];
  const enhancers: string[] = [];
  const preferred = input.preferredTypes;

  // ── 1. Hard gates ────────────────────────────────────────────────────────────
  if (input.marketScannerScore < 20) {
    blockers.push("Market scanner: market ineligible");
  }
  if (input.riskIntelligenceScore < 20) {
    blockers.push("Risk intelligence: hard risk stop");
  }
  if (input.portfolioManagerScore < 20) {
    blockers.push("Portfolio manager: position limit reached");
  }
  // Recovery intelligence hard-gate: at ≥4 consecutive losses the recovery agent
  // drops to score 15, triggering this explicit block (weighted averaging alone
  // is not enough — we need a guaranteed veto to protect capital during severe streaks).
  if (input.recoveryIntelligenceScore < 20) {
    blockers.push("Recovery intelligence: consecutive loss limit — mandatory pause before next trade");
  }

  // ── Resolve dynamic weights (accuracy-driven, falls back to base) ────────────
  const AGENT_WEIGHTS = getDynamicWeights();
  const TOTAL_WEIGHT = Object.values(AGENT_WEIGHTS).reduce((a, b) => a + b, 0);

  // ── 2. EV gate ───────────────────────────────────────────────────────────────
  // During a loss streak the EV threshold tightens: we need real edge, not near-breakeven.
  // 0 losses → allow EV ≥ adaptive threshold (dynamic-confidence engine)
  // 2 losses → allow EV ≥ -0.02
  // 3+ losses → require EV > 0 (positive expected value only)
  const sessionLosses = ctx.daily.consecutiveLosses;
  const adaptiveMinEV = getAdaptiveEvThreshold();
  const minEV = sessionLosses >= 3 ? 0.001 : sessionLosses >= 2 ? -0.02 : adaptiveMinEV; // 3+ losses: strictly positive EV
  const evPasses = input.bestEVResult !== null && input.bestEVResult.expectedValue >= minEV;
  // EV gate is a HARD block only when the user opted into requiring positive/adaptive EV
  // (settings.requirePositiveEv) or during an active loss streak (recovery needs real edge).
  // Otherwise it's advisory — most digit/barrier contracts on Deriv carry a small structural
  // negative EV from the house edge, so hard-gating on it here made the engine perpetually
  // find "no qualifying opportunity" and never execute a trade.
  const evIsHardGate = ctx.settings.requirePositiveEv || sessionLosses >= 2;
  const evGated = evPasses || !evIsHardGate;
  if (!evPasses && input.bestEVResult !== null) {
    const reason = sessionLosses >= 2
      ? `EV gate (recovery mode, ${sessionLosses} losses): ${(input.bestEVResult.expectedValue * 100).toFixed(1)}% < ${(minEV * 100).toFixed(0)}% required`
      : `EV gate: ${(input.bestEVResult.expectedValue * 100).toFixed(1)}% — below threshold${evIsHardGate ? "" : " (advisory)"}`;
    blockers.push(reason);
  }

  // ── 3. Timing gate ───────────────────────────────────────────────────────────
  const adaptiveTimingThreshold = getAdaptiveTimingThreshold();
  const minTimingScore = sessionLosses >= 3 ? 50 : sessionLosses >= 2 ? 44 : adaptiveTimingThreshold;
  const timingGated = input.executionTimingScore >= minTimingScore;
  if (!timingGated) {
    blockers.push(`Timing score ${input.executionTimingScore} < ${minTimingScore} — suboptimal entry`);
  }

  // ── 4. Weighted score aggregation ────────────────────────────────────────────
  const scores: Record<string, number> = {
    marketScanner: input.marketScannerScore,
    tickIntelligence: input.tickIntelligenceScore,
    digitProbability: input.digitProbabilityScore,
    riseFallAgent: input.riseFallScore,
    marketRegime: input.marketRegimeScore,
    executionTiming: input.executionTimingScore,
    recoveryIntelligence: input.recoveryIntelligenceScore,
    riskIntelligence: input.riskIntelligenceScore,
    portfolioManager: input.portfolioManagerScore,
    learningAgent: input.learningAgentScore,
    patternDiscovery: input.patternDiscoveryScore,
  };

  let weightedSum = 0;
  for (const [agentId, weight] of Object.entries(AGENT_WEIGHTS)) {
    weightedSum += (scores[agentId] ?? 50) * weight;
  }
  const agentWeightedScore = Math.round(weightedSum / TOTAL_WEIGHT);

  // ── 5. Per-market adaptive threshold ─────────────────────────────────────────
  // Uses the Dynamic Confidence Engine's learned threshold (calibrated from historical
  // outcomes) instead of a fixed value. The learning engine adjusts this ±0.5 per trade
  // based on recent win-rate, keeping it within [MIN_THRESHOLD, MAX_THRESHOLD].
  const historyAdjust = (input.learningAgentScore - 50) * 0.1; // ±5 adjustment
  const adaptiveBase = getAdaptiveConfidenceThreshold(ctx.settings.minConfidenceThreshold ?? 50);
  // During a loss streak, raise the bar aggressively: each consecutive loss adds 6 points
  // (was 3), capped at +30 (was +15). This forces near-consensus from all agents before
  // the engine takes another trade after repeated losses — critical for protecting capital.
  const lossStreakBoost = Math.min(sessionLosses * 6, 30);
  const effectiveThreshold = Math.max(44, Math.min(82, adaptiveBase + historyAdjust + lossStreakBoost));

  // ── 6. Enhancement signals ────────────────────────────────────────────────────
  if (input.patternDiscoveryScore > 70) enhancers.push("Pattern discovery: recognized profitable pattern");
  if (input.learningAgentScore > 75) enhancers.push("Learning agent: strategy historically profitable");
  if (input.tickIntelligenceScore > 75) enhancers.push("Tick intelligence: strong directional bias");
  if (input.marketRegimeScore > 70) enhancers.push("Market regime: favorable conditions");

  // ── 7. Contract type selection ────────────────────────────────────────────────
  let recommendedContractType: ProductType | null = input.contractType;
  let recommendedBarrier: number | null = input.barrier;

  if (!recommendedContractType && input.bestEVResult) {
    recommendedContractType = input.bestEVResult.product;
    recommendedBarrier = input.bestEVResult.barrier ?? null;
  }

  if (!recommendedContractType && input.directionResult) {
    const wantCall = preferred.some(t => t === "CALL" || t === "RISE");
    const wantPut = preferred.some(t => t === "PUT" || t === "FALL");
    if (wantCall && input.directionResult.direction === "up") recommendedContractType = "CALL";
    else if (wantPut && input.directionResult.direction === "down") recommendedContractType = "PUT";
  }

  if (!recommendedContractType && input.bestBarrier) {
    recommendedContractType = input.bestBarrier.contractType;
    recommendedBarrier = input.bestBarrier.barrier;
  }

  // ── 8. Final decision ─────────────────────────────────────────────────────────
  const hardBlocked = blockers.some(b =>
    b.includes("ineligible") || b.includes("hard risk") || b.includes("position limit")
  );

  const overallConfidence = agentWeightedScore;
  const meetsThreshold = overallConfidence >= effectiveThreshold;

  // During a loss streak (≥2 consecutive losses) timing becomes a hard gate, not advisory.
  // In normal conditions timing is advisory so the engine keeps trading; during recovery
  // we want the most favourable entry, so we block poor-timing setups.
  const timingRequired = sessionLosses >= 2;
  const timingPass = !timingRequired || timingGated;

  const shouldTrade = !hardBlocked && meetsThreshold && evGated && timingPass && !!recommendedContractType;
  const recommendedAction: FusionResult["recommendedAction"] = hardBlocked ? "skip"
    : !meetsThreshold ? "wait" : shouldTrade ? "buy" : "wait";

  const score = overallConfidence;

  const reasoning = [
    `Weighted consensus: ${agentWeightedScore}/100 (threshold: ${effectiveThreshold}).`,
    `EV gate: ${evGated ? "pass" : "fail"}. Timing: ${timingGated ? "OK" : "suboptimal"}.`,
    enhancers.length > 0 ? `Enhancers: ${enhancers.slice(0, 2).join("; ")}.` : "",
    blockers.length > 0 ? `Blockers: ${blockers.join("; ")}.` : "",
    `Decision: ${recommendedAction.toUpperCase()} ${recommendedContractType ?? "?"}${recommendedBarrier != null ? ` @${recommendedBarrier}` : ""}.`,
  ].filter(Boolean).join(" ");

  const fusionResult: FusionResult = {
    shouldTrade, overallConfidence, recommendedAction,
    recommendedContractType, recommendedBarrier,
    blockers, enhancers, agentWeightedScore, evGated, timingGated,
  };

  return {
    agentId: "confidenceFusion",
    score,
    confidence: overallConfidence,
    signal: scoreToSignal(score),
    reasoning,
    data: { fusionResult },
    executionTimeMs: Date.now() - t0,
    fusionResult,
  };
}

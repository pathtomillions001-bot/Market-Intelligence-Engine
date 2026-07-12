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
  // NOTE: Recovery intelligence is NOT a hard gate here. Its score (15–72) already
  // carries weight 1.2 in the weighted consensus, depressing the overall score when
  // there's a streak. The loop-level cooldown (ai.ts) handles mandatory pauses at the
  // configured consecutiveLossLimit — we don't need a duplicate hard veto here that
  // causes permanent deadlock after ≥4 losses (engine resumes after cooldown only to
  // be immediately blocked again by this gate, never actually trading).

  // ── Resolve dynamic weights (accuracy-driven, falls back to base) ────────────
  const AGENT_WEIGHTS = getDynamicWeights();
  const TOTAL_WEIGHT = Object.values(AGENT_WEIGHTS).reduce((a, b) => a + b, 0);

  // ── 2. EV gate ───────────────────────────────────────────────────────────────
  // EV is always a hard gate — the engine never trades on genuinely terrible EV.
  // A baseline floor of -0.04 applies in all conditions (DIGITDIFF is structurally ~-0.2%
  // so the -4% floor never blocks it; DIGITOVER 2 typically reaches +1–3% edge when cold).
  // During loss streaks the bar tightens, but we cap the sessionLosses used here at 4 so
  // the gate doesn't escalate indefinitely. The loop-level cooldown already pauses the
  // engine at the consecutiveLossLimit — by the time the loop resumes, we want the EV gate
  // to allow genuinely good setups (not block everything forever).
  //
  // 0–2 losses → EV ≥ max(adaptive, -0.04)  — baseline floor, house-edge tolerated
  //   3 losses → EV ≥ -0.02                 — tighter; need some edge
  //  4+ losses → EV ≥  0.00                 — non-negative only (positive EV required)
  const sessionLosses = Math.min(ctx.daily.consecutiveLosses, 4);  // cap: gate plateaus at 4
  const adaptiveMinEV = getAdaptiveEvThreshold();
  const baselineMinEV = Math.max(adaptiveMinEV, -0.04);   // -4% floor, always applied
  const minEV = sessionLosses >= 4 ? 0.0 : sessionLosses >= 3 ? -0.02 : baselineMinEV;
  const evPasses = input.bestEVResult !== null && input.bestEVResult.expectedValue >= minEV;
  const evGated = evPasses;
  if (!evPasses && input.bestEVResult !== null) {
    const streakNote = sessionLosses >= 4 ? ` (${ctx.daily.consecutiveLosses} losses — positive EV required)`
      : sessionLosses >= 3 ? ` (${sessionLosses} losses — tighter EV gate)` : "";
    blockers.push(`EV gate: ${(input.bestEVResult.expectedValue * 100).toFixed(1)}% < ${(minEV * 100).toFixed(0)}% required${streakNote}`);
  }

  // ── 3. Timing gate ───────────────────────────────────────────────────────────
  // Timing is ALWAYS advisory. It informs the weighted score but never hard-blocks
  // a trade. The EV gate and weighted consensus are the real quality controls.
  // Turning timing into a hard gate during streaks caused the engine to skip genuinely
  // good-EV setups simply because the execution-timing agent was slightly bearish.
  const adaptiveTimingThreshold = getAdaptiveTimingThreshold();
  const timingGated = input.executionTimingScore >= adaptiveTimingThreshold;
  if (!timingGated) {
    // Advisory only — logged but not blocking
    enhancers.push(`Timing advisory: score ${input.executionTimingScore} (threshold ${adaptiveTimingThreshold})`);
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
  // During a loss streak, raise the bar aggressively: each consecutive loss adds 6 points,
  // capped at +30. Default floor is 50 so the engine needs at least half the agents to agree.
  // Exception: DIGITMATCH/DIGITDIFF (matchdiff family) use a lower floor of 45 because:
  //   • DIGITMATCH has a naturally lower agent consensus (only ~10% theoretical win rate means
  //     many agents score it conservatively even when the digit IS hot)
  //   • DIGITDIFF at ~96% win rate still confuses some agents that look at payout, not win rate
  //   • The real quality gate for these contracts is the EV/edge check in master-decision.ts
  const isMatchDiff = input.bestEVResult?.product === "DIGITMATCH" || input.bestEVResult?.product === "DIGITDIFF";
  const thresholdFloor = isMatchDiff ? 45 : 50;
  const lossStreakBoost = Math.min(sessionLosses * 6, 30);
  const effectiveThreshold = Math.max(thresholdFloor, Math.min(82, adaptiveBase + historyAdjust + lossStreakBoost));

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

  // Timing is advisory — it influences the weighted score but is never a hard block.
  // The EV gate and consensus threshold are the real quality gates.
  const timingPass = true;

  const shouldTrade = !hardBlocked && meetsThreshold && evGated && !!recommendedContractType;
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

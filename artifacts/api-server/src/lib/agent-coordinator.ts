/**
 * Agent Coordinator
 *
 * Orchestrates the full multi-agent pipeline for a single market scan.
 * Replaces the monolithic `analyzeMarket()` function entirely.
 *
 * Pipeline (agents run in dependency order, parallel where possible):
 *
 *   Stage 1 (parallel):  FeatureEngineering + DailyStats fetch
 *   Stage 2 (parallel):  MarketRegime + Direction + Digit
 *   Stage 2.5:           Duration Optimizer (needs regime + features)
 *   Stage 3:             EVCalculator (needs Direction + Digit + duration)
 *   Stage 4 (parallel):  RiskManager + ExecutionTiming + PerformanceFeedback
 *   Stage 5:             MasterDecision (aggregates all)
 *
 * Output is a CoordinatorOutput that is backward-compatible with the existing
 * API contract (same fields as the old MarketAnalysis + FinalizedAnalysis).
 */

import type { ScanContext, CoordinatorOutput, TradingSettings, DailyStats } from "./agents/types";
import { runFeatureEngineeringAgent } from "./agents/feature-engineering";
import { runMarketRegimeAgent } from "./agents/market-regime";
import { runDirectionAgent } from "./agents/direction-agent";
import { runDigitAgent } from "./agents/digit-agent";
import { runEVCalculatorAgent, computeStake } from "./agents/ev-calculator";
import { runRiskManagerAgent } from "./agents/risk-manager";
import { runExecutionTimingAgent } from "./agents/execution-timing";
import { runPerformanceFeedbackAgent, recordTradeOutcome, getStrategyStats } from "./agents/performance-feedback";
import { makeFinalDecision } from "./agents/master-decision";
import { selectOptimalDuration } from "./agents/duration-optimizer";
import { isInDigitRecovery, updateDigitRecovery } from "./agents/digit-agent";
import { analyzeDigits } from "./deriv";
import { getContractProposal } from "./deriv";
import { logger } from "./logger";

// ── Re-export for backward compatibility ──────────────────────────────────────
export type { CoordinatorOutput } from "./agents/types";
export { recordTradeOutcome, getStrategyStats } from "./agents/performance-feedback";
export { updateDigitRecovery, isInDigitRecovery, setGlobalDigitRecovery } from "./agents/digit-agent";

// ── Payout cache (20 min TTL — avoids Deriv WS round-trip on every scan) ─────
const payoutCache = new Map<string, { value: number; ts: number }>();
const PAYOUT_TTL_MS = 20 * 60 * 1000;

async function fetchLivePayouts(
  symbol: string,
  contractTypes: string[],
  token: string | null,
  currency: string,
  stake: number,
  duration: number,
  barrier?: number,
): Promise<Record<string, number>> {
  if (!token) return {};
  const now = Date.now();
  const result: Record<string, number> = {};

  for (const ct of contractTypes) {
    const key = `${symbol}:${ct}:${barrier ?? ""}`;
    const hit = payoutCache.get(key);
    if (hit && now - hit.ts < PAYOUT_TTL_MS) {
      result[ct] = hit.value;
      continue;
    }
    try {
      const proposal = await Promise.race([
        getContractProposal(token, {
          symbol,
          contractType: ct,
          stake,
          duration,
          durationUnit: "t",
          currency,
          barrier: ct.startsWith("DIGIT") ? barrier : undefined,
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (proposal?.payoutMultiplier) {
        result[ct] = proposal.payoutMultiplier;
        payoutCache.set(key, { value: proposal.payoutMultiplier, ts: now });
      }
    } catch {
      // fall through to defaults
    }
  }
  return result;
}

// ── Main coordinator function ─────────────────────────────────────────────────

export async function runCoordinator(ctx: ScanContext): Promise<CoordinatorOutput> {
  const t0 = Date.now();

  // ── Stage 1: Feature extraction ───────────────────────────────────────────
  const feAgent = runFeatureEngineeringAgent(ctx);
  const features = feAgent.featureSet;

  // ── Stage 2: Regime + Direction + Digit (parallel) ────────────────────────
  // Always run direction agent regardless of preferredContractTypes so the
  // Agent Intelligence Panel always has direction data to display.
  const inDigitRecovery = isInDigitRecovery(ctx.symbol);

  const [regimeAgent, dirAgent, digitAgent] = await Promise.all([
    Promise.resolve(runMarketRegimeAgent(ctx, features)),
    Promise.resolve(runDirectionAgent(ctx, features, ctx.settings.tradeDurationSec)),
    Promise.resolve(runDigitAgent(ctx, features.digit, inDigitRecovery)),
  ]);

  const regime = regimeAgent.regimeOutput.regime;
  const dirResult = dirAgent.directionResult;
  const digitResult = digitAgent.digitResult;

  // Determine which contract types to consider based on preferences + regime
  const preferred = ctx.settings.preferredContractTypes;
  const wantDirection = preferred.some((t) => ["RISE", "FALL", "CALL", "PUT"].includes(t));
  const wantDigit = preferred.some((t) => t.startsWith("DIGIT") && !["DIGITEVEN", "DIGITODD"].includes(t));
  const wantEvenOdd = preferred.some((t) => t === "DIGITEVEN" || t === "DIGITODD");
  const hasDigitEdge = digitResult?.hasEdge ?? false;

  // ── Stage 2.5: Duration optimization ─────────────────────────────────────
  // Select the optimal tick duration for the most likely contract type.
  // candidateProduct respects preferredContractTypes — never uses CALL/PUT when
  // the user has disabled direction types.
  const candidateProduct = wantDigit
    ? (digitResult?.bestOption?.contractType ?? "DIGITOVER")
    : wantDirection
      ? (dirResult.direction === "up" ? "CALL" : "PUT")
      : wantEvenOdd
        ? "DIGITEVEN"
        : "DIGITOVER";   // safe default — will be gate-rejected anyway

  const durationOpt = selectOptimalDuration(ctx, features, regime, candidateProduct);
  const optimizedDuration = durationOpt.duration;

  // Best barrier for live payout fetch
  const bestDigitBarrier = digitResult?.bestOption?.barrier;
  const payoutStake = computeStake(ctx);

  // ── Stage 3: EV calculation (needs direction + digit + optimal duration) ──
  // Include a contract family in EV fetch ONLY when the user has it enabled.
  // Critically: wantDigit no longer requires hasDigitEdge — always evaluate
  // DIGITOVER/DIGITUNDER EV when the user has enabled Over/Under, so the master
  // decision can pick a digit trade even in low-edge conditions.
  let livePayouts: Record<string, number> | null = null;
  const contractTypesToFetch = [
    ...(wantDirection ? ["CALL", "PUT"] : []),
    ...(wantDigit ? ["DIGITOVER", "DIGITUNDER"] : []),
    ...(wantEvenOdd ? ["DIGITEVEN", "DIGITODD"] : []),
  ];
  if (contractTypesToFetch.length > 0 && ctx.token && !ctx.settings.paperTradeMode) {
    try {
      livePayouts = await fetchLivePayouts(
        ctx.symbol,
        contractTypesToFetch,
        ctx.token,
        ctx.currency,
        payoutStake,
        optimizedDuration,
        bestDigitBarrier,
      );
    } catch {
      livePayouts = null;
    }
  }

  // Compute even/odd probability from recent digit history for EVEN/ODD EV
  let evenProb: number | undefined;
  if (wantEvenOdd && ctx.digits.length >= 20) {
    const recentDigits = ctx.digits.slice(-100);
    evenProb = recentDigits.filter((d) => d % 2 === 0).length / recentDigits.length;
  }

  const evAgent = runEVCalculatorAgent(
    ctx,
    wantDirection ? dirResult : null,
    wantDigit && digitResult ? (digitResult.topOptions ?? []) : [],
    livePayouts && Object.keys(livePayouts).length > 0 ? livePayouts : null,
    evenProb,
  );
  const bestEV = evAgent.bestEVResult;

  // Determine best contract type for timing + performance lookup.
  // Never fall back to CALL/PUT when direction types are disabled.
  const effectiveContractType = bestEV?.product ?? (
    wantDirection ? (dirResult.direction === "up" ? "CALL" : "PUT")
      : wantDigit ? "DIGITOVER"
      : wantEvenOdd ? "DIGITEVEN"
      : "DIGITOVER"
  );
  const effectiveBarrier = bestEV?.barrier;

  // ── Stage 4: Risk + Timing + Performance (parallel) ──────────────────────
  const [riskAgent, timingAgent, perfAgent] = await Promise.all([
    Promise.resolve(runRiskManagerAgent(ctx, bestEV)),
    Promise.resolve(runExecutionTimingAgent(ctx, features, regime, effectiveContractType)),
    Promise.resolve(runPerformanceFeedbackAgent(ctx, effectiveContractType, effectiveBarrier)),
  ]);

  const riskDecision = riskAgent.riskDecision;
  const timingResult = timingAgent.timingResult;
  const strategyStats = perfAgent.stats;

  // ── Stage 5: Master Decision ──────────────────────────────────────────────
  // Always include direction in agentOutputs (for Agent Intelligence Panel display),
  // even when wantDirection is false — it shows the panel is doing directional analysis.
  const agentOutputs: Record<string, any> = {
    featureEngineering: feAgent as any,
    marketRegime: regimeAgent as any,
    direction: dirAgent as any,   // always include for panel display
    evCalculator: evAgent as any,
    riskManager: riskAgent as any,
    executionTiming: timingAgent as any,
    performanceFeedback: perfAgent as any,
  };

  // Only include digitDistribution in weighted consensus if there's real digit edge
  if (wantDigit && hasDigitEdge) {
    agentOutputs["digitDistribution"] = digitAgent as any;
  }

  // Build digit stats for the UI
  const digitStats = ctx.digits.length >= 10 ? analyzeDigits(ctx.digits.slice(-100)) : undefined;

  const { output } = makeFinalDecision({
    ctx,
    agents: agentOutputs,
    bestEV,
    riskDecision,
    timingResult,
    strategyStats,
    regimeOutput: regimeAgent.regimeOutput,
    probUp: dirResult.probUp,
    vol20: features.price.vol20,
    digitStats,
    optimizedDuration,
  });

  // Attach duration optimizer output to the agents record for the UI panel
  (output.agents as any)["durationOptimizer"] = {
    agentId: "durationOptimizer",
    score: durationOpt.confidence,
    confidence: durationOpt.confidence,
    signal: "neutral" as const,
    reasoning: durationOpt.reasoning,
    data: { duration: durationOpt.duration, allScores: durationOpt.allScores },
    executionTimeMs: 0,
  };

  logger.debug({
    symbol: ctx.symbol,
    shouldTrade: output.shouldTrade,
    quality: output.qualityScore,
    ev: bestEV?.expectedValue,
    regime,
    duration: optimizedDuration,
    ms: Date.now() - t0,
  }, "Coordinator scan complete");

  return output;
}

// ── Backward-compatible wrapper (matches old analyzeMarket + finalizeAnalysis API) ─

export function buildLegacyAnalysis(output: CoordinatorOutput): LegacyAnalysis {
  const rec = output.recommendation;
  const agents = output.agents;

  // Build backward-compatible agentScores shape
  const agentScores = {
    marketScanner: toAgentScore(agents["featureEngineering"] ?? agents["marketRegime"], 0.10),
    trendAnalysis: toAgentScore(agents["direction"] ?? agents["digitDistribution"], 0.18),
    volatilityAnalysis: toAgentScore(agents["marketRegime"], 0.13),
    patternRecognition: toAgentScore(agents["direction"] ?? agents["featureEngineering"], 0.15),
    riskManagement: toAgentScore(agents["riskManager"], 0.13),
    capitalPreservation: toAgentScore(agents["riskManager"], 0.08),
    tradeExecution: toAgentScore(agents["executionTiming"], 0.08),
    selfLearning: toAgentScore(agents["performanceFeedback"], 0.15),
  };

  const isDigit = rec.product.startsWith("DIGIT");

  return {
    symbol: output.symbol,
    qualityScore: output.qualityScore,
    confidenceScore: output.confidenceScore,
    riskScore: output.riskScore,
    trend: output.trend,
    volatility: output.volatility,
    recommendedContractType: rec.product,
    direction: output.direction,
    recommendedStake: rec.stake,
    profitability: Math.round((output.qualityScore * 0.6 + output.confidenceScore * 0.4) * 0.95),
    agentScores,
    shouldTrade: output.shouldTrade,
    reasoning: output.reasoning,
    warnings: output.warnings,
    suggestedContractTypes: buildContractOptions(output),
    digitStats: output.digitStats,
    digitBarrier: rec.barrier,
    digitConfidence: isDigit ? rec.winProbability : undefined,
    recommendedDuration: rec.duration,
    winProbability: rec.winProbability,
    mlModels: undefined,
    // Finalized fields
    calibratedConfidence: rec.winProbability,
    expectedValue: rec.expectedValue,
    breakevenWinRate: rec.breakevenWinRate,
    payoutMultiplier: rec.payoutMultiplier,
    // Extended: full agent outputs for new UI
    agentOutputs: output.agents,
    regime: output.regime,
  };
}

function toAgentScore(agent: any, weight: number) {
  if (!agent) return { score: 50, weight, signal: "neutral" as const, reasoning: "N/A" };
  return {
    score: agent.score ?? 50,
    weight,
    signal: agent.signal ?? "neutral",
    reasoning: agent.reasoning ?? "",
  };
}

function buildContractOptions(output: CoordinatorOutput) {
  const opts = [];
  const rec = output.recommendation;
  const agents = output.agents;
  const evData = agents["evCalculator"]?.data as any;
  const allEV = (evData?.allEVResults ?? []) as any[];

  for (const ev of allEV.slice(0, 4)) {
    opts.push({
      contractType: ev.product,
      label: `${ev.product}${ev.barrier !== undefined ? ` ${ev.barrier}` : ""}`,
      description: `EV=${(ev.expectedValue * 100).toFixed(1)}%, P(win)=${(ev.winProbability * 100).toFixed(0)}%`,
      suitable: ev.isPositiveEV,
      confidence: Math.round(ev.winProbability * 100),
      recommendedStake: rec.stake,
      riskLevel: ev.winProbability > 0.65 ? "low" : ev.winProbability > 0.55 ? "medium" : "high" as any,
    });
  }
  return opts;
}

export interface LegacyAnalysis {
  symbol: string;
  qualityScore: number;
  confidenceScore: number;
  riskScore: number;
  trend: CoordinatorOutput["trend"];
  volatility: CoordinatorOutput["volatility"];
  recommendedContractType: string;
  direction: "up" | "down";
  recommendedStake: number;
  profitability: number;
  agentScores: Record<string, { score: number; weight: number; signal: string; reasoning: string }>;
  shouldTrade: boolean;
  reasoning: string;
  warnings: string[];
  suggestedContractTypes: any[];
  digitStats?: any;
  digitBarrier?: number;
  digitConfidence?: number;
  recommendedDuration: number;
  winProbability: number;
  mlModels?: any;
  calibratedConfidence: number;
  expectedValue: number;
  breakevenWinRate: number;
  payoutMultiplier: number;
  agentOutputs: Record<string, any>;
  regime: string;
  tickWindow?: number;
}

import { db } from "@workspace/db";
import { tradeFeaturesTable } from "@workspace/db";
import type { MarketAnalysis } from "./ai-engine";
import { getContractProposal } from "./deriv";
import { calibrateConfidence, computeBreakevenWinRate, computeExpectedValue } from "./calibration";

export interface FinalizedAnalysis extends MarketAnalysis {
  calibratedConfidence: number;
  winProbability: number;
  expectedValue: number;
  breakevenWinRate: number;
  payoutMultiplier: number;
  recommendedDuration: number;
}

export async function finalizeAnalysis(
  analysis: MarketAnalysis,
  opts: {
    symbol: string;
    currency: string;
    token: string | null;
    defaultDuration: number;
    barrier?: number;
  },
): Promise<FinalizedAnalysis> {
  const duration = analysis.recommendedDuration ?? opts.defaultDuration;
  const barrier = analysis.digitBarrier ?? opts.barrier;

  const proposal = await getContractProposal(opts.token, {
    symbol: opts.symbol,
    contractType: analysis.recommendedContractType,
    stake: analysis.recommendedStake,
    duration,
    durationUnit: "t",
    currency: opts.currency,
    barrier: analysis.recommendedContractType.includes("DIGIT") ? barrier : undefined,
  });

  const payoutMultiplier = proposal?.payoutMultiplier ?? 1.87;
  const calibratedConfidence = await calibrateConfidence(analysis.confidenceScore, analysis.recommendedContractType);
  const winProbability = analysis.recommendedContractType.includes("DIGIT")
    ? (analysis.digitConfidence ?? calibratedConfidence)
    : Math.round(analysis.winProbability ?? calibratedConfidence);

  const expectedValue = computeExpectedValue(winProbability, analysis.recommendedStake, payoutMultiplier);
  const breakevenWinRate = computeBreakevenWinRate(payoutMultiplier);

  return {
    ...analysis,
    calibratedConfidence,
    winProbability,
    expectedValue: Math.round(expectedValue * 100) / 100,
    breakevenWinRate,
    payoutMultiplier: Math.round(payoutMultiplier * 1000) / 1000,
    recommendedDuration: duration,
  };
}

export async function logTradeFeatures(
  tradeId: number,
  analysis: FinalizedAnalysis,
  opts: {
    symbol: string;
    barrier?: number | null;
    tickWindow?: number | null;
    duration: number;
    featuresJson?: Record<string, unknown>;
    isPaperTrade?: boolean;
  },
): Promise<void> {
  try {
    await db.insert(tradeFeaturesTable).values({
      tradeId,
      symbol: opts.symbol,
      contractType: analysis.recommendedContractType,
      barrier: opts.barrier ?? analysis.digitBarrier ?? null,
      tickWindow: opts.tickWindow ?? analysis.tickWindow ?? null,
      duration: opts.duration,
      featuresJson: JSON.stringify(opts.featuresJson ?? {}),
      rfProb: analysis.mlModels ? String(analysis.mlModels.randomForest) : null,
      gbProb: analysis.mlModels ? String(analysis.mlModels.gradientBoosting) : null,
      lrProb: analysis.mlModels ? String(analysis.mlModels.logistic) : null,
      rawConfidence: String(analysis.confidenceScore),
      calibratedConfidence: String(analysis.calibratedConfidence),
      expectedValue: String(analysis.expectedValue),
      payoutMultiplier: String(analysis.payoutMultiplier),
      breakevenWinRate: String(analysis.breakevenWinRate),
      isPaperTrade: opts.isPaperTrade ? 1 : 0,
    });
  } catch {
    // table may not exist until schema push
  }
}

export function shouldExecuteTrade(
  analysis: FinalizedAnalysis,
  opts: { minConfidence: number; requirePositiveEv: boolean },
): { execute: boolean; reason?: string } {
  if (!analysis.shouldTrade) {
    return { execute: false, reason: "ML risk gates failed (shouldTrade=false)" };
  }
  if (analysis.calibratedConfidence < opts.minConfidence) {
    return { execute: false, reason: `Calibrated confidence ${analysis.calibratedConfidence}% below threshold ${opts.minConfidence}%` };
  }
  if (opts.requirePositiveEv && analysis.expectedValue <= 0) {
    return { execute: false, reason: `Negative EV ($${analysis.expectedValue.toFixed(2)}) — breakeven ${analysis.breakevenWinRate}%` };
  }
  return { execute: true };
}

/**
 * Expected Value Calculator Agent
 *
 * RESPONSIBILITY: Compute the true expected value for each potential trade,
 * using calibrated win probabilities and actual (not estimated) payout multipliers.
 *
 * EV = P(win) × net_payout - P(lose) × stake
 *    = P(win) × (payout_multiplier - 1) - (1 - P(win))
 *    per $1 stake
 *
 * Breakeven win rate = 1 / payout_multiplier
 *
 * RISE/FALL: Real Deriv payouts on synthetic indices are 1.87–1.95x.
 * We default to 1.91x which is representative and gives a 52.4% breakeven.
 * CALL/PUT: ~1.87x (slightly less than RISE/FALL on most synthetics).
 *
 * Task 2 fix: Direction trades need achievable thresholds.
 * With 1.91x payout, only 52.4% win probability is needed — achievable by the
 * direction model when market regime and momentum strongly agree.
 */

import type { AgentOutput, ProductType, ScanContext } from "./types";
import { scoreToSignal } from "./types";
import type { DirectionResult } from "./direction-agent";
import type { BarrierOption } from "./digit-agent";

// ── Default payout table ──────────────────────────────────────────────────────
// Updated to more realistic Deriv values for synthetic indices.
// CALL/PUT (Rise/Fall) on Volatility indices typically pay 1.88–1.95x.
// DIGITEVEN/DIGITODD are 50/50 contracts that pay ~1.95x on Deriv.
// NOTE: Deriv API uses CALL (price ends higher = Rise) and PUT (price ends lower = Fall).
export const DEFAULT_PAYOUTS: Record<string, number> = {
  CALL:        1.91,   // Rise — price ends higher than entry
  PUT:         1.91,   // Fall — price ends lower than entry
  RISE:        1.91,   // Alias for backward compatibility
  FALL:        1.91,   // Alias for backward compatibility
  DIGITOVER:   1.96,   // barrier=5 (most common)
  DIGITUNDER:  1.96,
  DIGITEVEN:   1.95,   // 50/50 contract: even digit wins
  DIGITODD:    1.95,   // 50/50 contract: odd digit wins
};

// Minimum EV threshold for "near-breakeven" classification.
// Widened to -0.05 so direction trades at ~50% win rate are still returned as
// candidates (EV ≈ -4.5%) rather than null. The master-decision gate then decides
// whether to execute; returning null here permanently kills the engine.
export const MIN_POSITIVE_EV = -0.05; // -5% lower bound for near-breakeven

// ── EV calculation ────────────────────────────────────────────────────────────

export interface EVResult {
  product: ProductType;
  barrier?: number;
  winProbability: number;
  payoutMultiplier: number;
  expectedValue: number;      // per $1 stake
  breakevenWinRate: number;
  edge: number;               // winProbability - breakevenWinRate
  isPositiveEV: boolean;
  isNearBreakeven: boolean;   // EV within ±1% — marginal opportunity
  stake: number;
  dollarEV: number;
  kellyFraction: number;
}

export function computeEV(
  winProbability: number,
  payoutMultiplier: number,
): EVResult["expectedValue"] {
  return winProbability * (payoutMultiplier - 1) - (1 - winProbability);
}

export function kellyFraction(winProbability: number, payoutMultiplier: number): number {
  const b = payoutMultiplier - 1;
  const p = winProbability;
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  return Math.max(0, Math.min(0.25, kelly * 0.5));
}

export function buildEVResult(
  product: ProductType,
  winProbability: number,
  payoutMultiplier: number,
  stake: number,
  barrier?: number,
): EVResult {
  const ev = computeEV(winProbability, payoutMultiplier);
  const breakeven = 1 / payoutMultiplier;
  return {
    product,
    barrier,
    winProbability,
    payoutMultiplier,
    expectedValue: ev,
    breakevenWinRate: breakeven,
    edge: winProbability - breakeven,
    isPositiveEV: ev > 0,
    isNearBreakeven: ev >= MIN_POSITIVE_EV && ev <= 0.015,
    stake,
    dollarEV: ev * stake,
    kellyFraction: kellyFraction(winProbability, payoutMultiplier),
  };
}

// ── Direction products ────────────────────────────────────────────────────────

function evForDirectionProducts(
  dirResult: DirectionResult,
  payouts: { rise: number; fall: number },
  stake: number,
  preferredTypes: string[],
): EVResult[] {
  const results: EVResult[] = [];
  const probUp = dirResult.probUp;
  const probDown = dirResult.probDown;

  // Accept both CALL/PUT (canonical) and RISE/FALL (legacy alias)
  if (preferredTypes.some((t) => ["RISE", "FALL", "CALL", "PUT"].includes(t))) {
    results.push(buildEVResult("CALL", probUp, payouts.rise, stake));
    results.push(buildEVResult("PUT", probDown, payouts.fall, stake));
  }

  return results;
}

// ── Digit products ────────────────────────────────────────────────────────────

function evForDigitProducts(
  barrierOptions: BarrierOption[],
  stake: number,
): EVResult[] {
  // Include ALL barriers (not just positive EV) so there is always a candidate
  // for the master-decision to evaluate. Sort best-first so index [0] is optimal.
  return barrierOptions
    .sort((a, b) => b.expectedValue - a.expectedValue)
    .map((opt) => ({
      product: opt.contractType,
      barrier: opt.barrier,
      winProbability: opt.winProbability,
      payoutMultiplier: opt.payout,
      expectedValue: opt.expectedValue,
      breakevenWinRate: 1 / opt.payout,
      edge: opt.edge,
      isPositiveEV: opt.expectedValue > 0,
      isNearBreakeven: opt.expectedValue >= MIN_POSITIVE_EV && opt.expectedValue <= 0.015,
      stake,
      dollarEV: opt.expectedValue * stake,
      kellyFraction: kellyFraction(opt.winProbability, opt.payout),
    }));
}

// ── Even / Odd products ───────────────────────────────────────────────────────
// evenProb = fraction of recent digits that were even (0,2,4,6,8).
// Both products always use payout ~1.95x (50/50 contract on Deriv).

function evForEvenOddProducts(
  evenProb: number,
  stake: number,
  livePayouts: Record<string, number> | null,
): EVResult[] {
  const evenPayout = livePayouts?.["DIGITEVEN"] ?? DEFAULT_PAYOUTS["DIGITEVEN"];
  const oddPayout  = livePayouts?.["DIGITODD"]  ?? DEFAULT_PAYOUTS["DIGITODD"];
  const oddProb    = 1 - evenProb;
  return [
    buildEVResult("DIGITEVEN", evenProb, evenPayout, stake),
    buildEVResult("DIGITODD",  oddProb,  oddPayout,  stake),
  ];
}

// ── Agent runner ──────────────────────────────────────────────────────────────

export interface EVAgentOutput extends AgentOutput {
  allEVResults: EVResult[];
  bestEVResult: EVResult | null;
  payoutsSource: "live" | "default";
}

export function runEVCalculatorAgent(
  ctx: ScanContext,
  dirResult: DirectionResult | null,
  barrierOptions: BarrierOption[],
  livePayouts: Record<string, number> | null,
  evenProb?: number,
): EVAgentOutput {
  const t0 = Date.now();
  const stake = computeStake(ctx);
  const preferred = ctx.settings.preferredContractTypes;

  const payoutsSource = livePayouts ? "live" : "default";
  const payouts = {
    rise:  livePayouts?.["CALL"]  ?? livePayouts?.["RISE"]  ?? DEFAULT_PAYOUTS["CALL"],
    fall:  livePayouts?.["PUT"]   ?? livePayouts?.["FALL"]  ?? DEFAULT_PAYOUTS["PUT"],
  };

  const allEV: EVResult[] = [];

  if (dirResult) {
    allEV.push(...evForDirectionProducts(dirResult, payouts, stake, preferred));
  }

  if (preferred.some((t) => t.startsWith("DIGIT")) && barrierOptions.length > 0) {
    allEV.push(...evForDigitProducts(barrierOptions, stake));
  }

  // EVEN/ODD: compute when preferred and we have a valid probability
  if (
    evenProb !== undefined &&
    preferred.some((t) => t === "DIGITEVEN" || t === "DIGITODD")
  ) {
    allEV.push(...evForEvenOddProducts(evenProb, stake, livePayouts));
  }

  // Best result: prefer strictly positive EV → near-breakeven → any result (best EV overall).
  // Never return null when there are candidates — a null bestEV permanently kills the engine
  // because master-decision blocks with "No EV calculation available".
  const strictPositiveEV = allEV.filter((r) => r.isPositiveEV).sort((a, b) => b.dollarEV - a.dollarEV);
  const nearBreakevenAny = allEV
    .filter((r) => r.isNearBreakeven)
    .sort((a, b) => b.dollarEV - a.dollarEV);
  const anySorted = [...allEV].sort((a, b) => b.expectedValue - a.expectedValue);

  const bestEVResult = strictPositiveEV[0] ?? nearBreakevenAny[0] ?? anySorted[0] ?? null;

  const score = bestEVResult
    ? Math.min(95, Math.round(50 + bestEVResult.expectedValue * 300))
    : 10;

  const allEVCount = allEV.length;
  const positiveEVCount = strictPositiveEV.length;

  const reasoning = bestEVResult
    ? `Best EV: ${bestEVResult.product}${bestEVResult.barrier !== undefined ? ` barrier=${bestEVResult.barrier}` : ""} — EV=${(bestEVResult.expectedValue * 100).toFixed(1)}% per $1 stake ($${bestEVResult.dollarEV.toFixed(3)}/trade). P(win)=${(bestEVResult.winProbability * 100).toFixed(1)}%, breakeven=${(bestEVResult.breakevenWinRate * 100).toFixed(1)}%. Payouts from ${payoutsSource}.${bestEVResult.isNearBreakeven ? " [Near-breakeven — marginal edge]" : ""}`
    : `No positive-EV opportunity found among ${allEVCount} options. Best was ${allEV.length > 0 ? (Math.max(...allEV.map(r => r.expectedValue)) * 100).toFixed(1) + "%" : "N/A"}`;

  return {
    agentId: "evCalculator",
    score,
    confidence: bestEVResult ? Math.min(95, Math.round(Math.abs(bestEVResult.edge) * 500)) : 0,
    signal: scoreToSignal(score),
    reasoning,
    data: {
      bestEVResult,
      allEVCount,
      positiveEVCount,
      payoutsSource,
    },
    executionTimeMs: Date.now() - t0,
    allEVResults: allEV,
    bestEVResult,
    payoutsSource,
  };
}

/** Compute initial stake based on Kelly criterion and risk settings */
export function computeStake(ctx: ScanContext): number {
  const { balance, settings } = ctx;
  const maxRisk = settings.maxRiskPerTrade / 100;
  const riskMult = settings.riskProfile === "conservative" ? 0.4
    : settings.riskProfile === "aggressive" ? 1.2 : 0.7;
  const rawStake = balance * maxRisk * riskMult;
  return Math.max(0.35, Math.min(rawStake, settings.maxTradeStake));
}

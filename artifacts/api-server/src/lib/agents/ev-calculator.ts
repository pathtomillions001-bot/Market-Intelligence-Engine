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
 * Example: Payout 1.87x → breakeven = 53.5%. If your model says P(win)=57%, EV>0.
 *
 * Deriv payout approximations by product (without live Deriv API token):
 *   RISE/FALL: ~1.87x (varies by market and volatility)
 *   CALL/PUT:  ~1.80x (time-based, slight premium for carry)
 *   OVER/UNDER: see digit-agent.ts payout table (varies greatly by barrier)
 *
 * With a live token, we query Deriv's proposal API for exact payouts.
 */

import type { AgentOutput, ProductType, ScanContext } from "./types";
import { scoreToSignal } from "./types";
import type { DirectionResult } from "./direction-agent";
import type { BarrierOption } from "./digit-agent";

// ── Default payout table (used when no token / proposal unavailable) ─────────

export const DEFAULT_PAYOUTS: Record<string, number> = {
  RISE:        1.87,
  FALL:        1.87,
  CALL:        1.80,
  PUT:         1.80,
  DIGITOVER:   1.96,   // barrier=5 (most common)
  DIGITUNDER:  1.96,
};

// ── EV calculation ────────────────────────────────────────────────────────────

export interface EVResult {
  product: ProductType;
  barrier?: number;
  winProbability: number;     // 0-1
  payoutMultiplier: number;   // e.g. 1.87
  expectedValue: number;      // per $1 stake (positive = profitable)
  breakevenWinRate: number;   // minimum P(win) to break even
  edge: number;               // winProbability - breakevenWinRate
  isPositiveEV: boolean;
  stake: number;
  dollarEV: number;           // EV × stake in dollars
  kellyFraction: number;      // optimal Kelly position fraction
}

export function computeEV(
  winProbability: number,   // 0-1
  payoutMultiplier: number,
  stake: number,
): EVResult["expectedValue"] {
  // Per-dollar EV: P(win) * net_win - P(lose) * 1
  // net_win = payoutMultiplier - 1 (we get back stake + profit)
  return winProbability * (payoutMultiplier - 1) - (1 - winProbability);
}

export function kellyFraction(winProbability: number, payoutMultiplier: number): number {
  // Kelly criterion: f* = (b*p - q) / b where b=net odds, p=P(win), q=P(lose)
  const b = payoutMultiplier - 1;
  const p = winProbability;
  const q = 1 - p;
  const kelly = (b * p - q) / b;
  // Use half-Kelly for safety (full Kelly is too aggressive for binary options)
  return Math.max(0, Math.min(0.25, kelly * 0.5));
}

export function buildEVResult(
  product: ProductType,
  winProbability: number,
  payoutMultiplier: number,
  stake: number,
  barrier?: number,
): EVResult {
  const ev = computeEV(winProbability, payoutMultiplier, stake);
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
    stake,
    dollarEV: ev * stake,
    kellyFraction: kellyFraction(winProbability, payoutMultiplier),
  };
}

// ── Build EV for direction products ──────────────────────────────────────────

function evForDirectionProducts(
  dirResult: DirectionResult,
  payouts: { rise: number; fall: number; call: number; put: number },
  stake: number,
  preferredTypes: string[],
): EVResult[] {
  const results: EVResult[] = [];
  const probUp = dirResult.probUp;
  const probDown = dirResult.probDown;

  if (preferredTypes.some((t) => ["RISE", "FALL", "CALL", "PUT"].includes(t))) {
    if (preferredTypes.includes("RISE") || preferredTypes.includes("FALL")) {
      results.push(buildEVResult("RISE", probUp, payouts.rise, stake));
      results.push(buildEVResult("FALL", probDown, payouts.fall, stake));
    }
    if (preferredTypes.includes("CALL") || preferredTypes.includes("PUT")) {
      results.push(buildEVResult("CALL", probUp, payouts.call, stake));
      results.push(buildEVResult("PUT", probDown, payouts.put, stake));
    }
  }

  return results;
}

// ── Build EV for digit products ──────────────────────────────────────────────

function evForDigitProducts(
  barierOptions: BarrierOption[],
  stake: number,
): EVResult[] {
  return barierOptions
    .filter((opt) => opt.expectedValue > 0)
    .map((opt) => ({
      product: opt.contractType,
      barrier: opt.barrier,
      winProbability: opt.winProbability,
      payoutMultiplier: opt.payout,
      expectedValue: opt.expectedValue,
      breakevenWinRate: 1 / opt.payout,
      edge: opt.edge,
      isPositiveEV: opt.expectedValue > 0,
      stake,
      dollarEV: opt.expectedValue * stake,
      kellyFraction: kellyFraction(opt.winProbability, opt.payout),
    }));
}

// ── Agent runner ──────────────────────────────────────────────────────────────

export interface EVAgentOutput extends AgentOutput {
  allEVResults: EVResult[];
  bestEVResult: EVResult | null;
  /** Live payout data (from Deriv proposal API if available) */
  payoutsSource: "live" | "default";
}

export function runEVCalculatorAgent(
  ctx: ScanContext,
  dirResult: DirectionResult | null,
  barierOptions: BarrierOption[],
  livePayouts: Record<string, number> | null,
): EVAgentOutput {
  const t0 = Date.now();
  const stake = computeStake(ctx);
  const preferred = ctx.settings.preferredContractTypes;

  const payoutsSource = livePayouts ? "live" : "default";
  const payouts = {
    rise:  livePayouts?.["RISE"]  ?? DEFAULT_PAYOUTS["RISE"],
    fall:  livePayouts?.["FALL"]  ?? DEFAULT_PAYOUTS["FALL"],
    call:  livePayouts?.["CALL"]  ?? DEFAULT_PAYOUTS["CALL"],
    put:   livePayouts?.["PUT"]   ?? DEFAULT_PAYOUTS["PUT"],
  };

  const allEV: EVResult[] = [];

  // Direction products
  if (dirResult) {
    allEV.push(...evForDirectionProducts(dirResult, payouts, stake, preferred));
  }

  // Digit products
  if (preferred.some((t) => t.startsWith("DIGIT")) && barierOptions.length > 0) {
    allEV.push(...evForDigitProducts(barierOptions, stake));
  }

  // Pick best positive EV result
  const positiveEV = allEV.filter((r) => r.isPositiveEV).sort((a, b) => b.dollarEV - a.dollarEV);
  const bestEVResult = positiveEV[0] ?? null;

  const score = bestEVResult
    ? Math.min(95, Math.round(50 + bestEVResult.expectedValue * 300))
    : 10;

  const reasoning = bestEVResult
    ? `Best EV: ${bestEVResult.product}${bestEVResult.barrier !== undefined ? ` barrier=${bestEVResult.barrier}` : ""} — EV=${(bestEVResult.expectedValue * 100).toFixed(1)}% per $1 stake ($${bestEVResult.dollarEV.toFixed(3)}/trade). P(win)=${(bestEVResult.winProbability * 100).toFixed(1)}%, breakeven=${(bestEVResult.breakevenWinRate * 100).toFixed(1)}%. Payouts from ${payoutsSource} data.`
    : `No positive-EV opportunity found among ${allEV.length} options evaluated. All ${allEV.length} options have negative EV.`;

  return {
    agentId: "evCalculator",
    score,
    confidence: bestEVResult ? Math.min(95, Math.round(bestEVResult.edge * 500)) : 0,
    signal: scoreToSignal(score),
    reasoning,
    data: {
      bestEVResult,
      allEVCount: allEV.length,
      positiveEVCount: positiveEV.length,
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

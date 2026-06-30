/**
 * Digit Distribution Agent — Tiered Barrier Selection
 *
 * BARRIER TIERS (per user specification):
 *
 *   TIER 1 — Normal / Safe compounding:
 *     OVER 1, 2, 3    → theoretical win prob 80%, 70%, 60%
 *     UNDER 6, 7, 8   → theoretical win prob 60%, 70%, 80%
 *
 *   TIER 2 — Recovery (after a loss, until fully recovered):
 *     OVER 4, 5, 6    → theoretical win prob 50%, 40%, 30%
 *     UNDER 3, 4, 5   → theoretical win prob 30%, 40%, 50%
 *
 * Within each tier, barriers are ranked by probability-adjusted EV.
 * If no positive-EV option exists in the preferred tier, fallback to
 * any positive-EV barrier from tier 1 or tier 2.
 *
 * HARD BLOCKED — these are never selected regardless of EV:
 *   OVER 7, OVER 8   → ultra-low win prob (20%, 10%), too risky
 *   UNDER 1, UNDER 2 → ultra-low win prob (10%, 20%), too risky
 *
 * OVER 0 (90% win, 1.05x payout) and UNDER 9 (90% win, 1.05x payout)
 * are assigned tier 0 but NOT hard-blocked — they can be a fallback when
 * nothing else has positive EV (though their very low payout means they
 * rarely score above tier-1/2 options).
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";
import type { DigitFeatures } from "./feature-engineering";

// ── Deriv payout table (validated against live Deriv API) ─────────────────────
const OVER_PAYOUTS: Record<number, number> = {
  0: 1.05, 1: 1.11, 2: 1.19, 3: 1.32, 4: 1.50,
  5: 1.96, 6: 2.65, 7: 4.36, 8: 9.54,
};
const UNDER_PAYOUTS: Record<number, number> = {
  1: 9.54, 2: 4.36, 3: 2.65, 4: 1.96, 5: 1.50,
  6: 1.32, 7: 1.19, 8: 1.11, 9: 1.05,
};

// Theoretical uniform distribution probabilities
const OVER_THEORETICAL: Record<number, number> = {
  0: 9/10, 1: 8/10, 2: 7/10, 3: 6/10, 4: 5/10,
  5: 4/10, 6: 3/10, 7: 2/10, 8: 1/10,
};
const UNDER_THEORETICAL: Record<number, number> = {
  1: 1/10, 2: 2/10, 3: 3/10, 4: 4/10, 5: 5/10,
  6: 6/10, 7: 7/10, 8: 8/10, 9: 9/10,
};

// ── Tier definitions ─────────────────────────────────────────────────────────
// Tier 1: normal mode — ONLY the one safest barrier per side
// OVER 2 → ~70% win rate;  UNDER 8 → ~70% win rate
// Normal mode: ONLY OVER 2 (~70% win) or UNDER 8 (~70% win)
const TIER1_OVER  = new Set([2]);
const TIER1_UNDER = new Set([8]);

// Recovery mode (after any loss): OVER 4 (~50% win) or UNDER 5 (~50% win)
// AI picks whichever has better digit-distribution probability for the current market
const TIER2_OVER  = new Set([4]);
const TIER2_UNDER = new Set([5]);

// Hard-blocked: EVERYTHING except the two allowed barriers per mode.
// Normal allowed: OVER 2, UNDER 8. Recovery allowed: OVER 4, UNDER 5.
// Any barrier not in [2,4] for OVER or [5,8] for UNDER is forbidden.
const HARD_BLOCKED_OVER  = new Set([0, 1, 3, 5, 6, 7, 8, 9]);
const HARD_BLOCKED_UNDER = new Set([0, 1, 2, 3, 4, 6, 7, 9]);

function inPreferredTier(
  contractType: "DIGITOVER" | "DIGITUNDER",
  barrier: number,
  inRecovery: boolean,
): boolean {
  if (inRecovery) {
    return contractType === "DIGITOVER" ? TIER2_OVER.has(barrier) : TIER2_UNDER.has(barrier);
  }
  return contractType === "DIGITOVER" ? TIER1_OVER.has(barrier) : TIER1_UNDER.has(barrier);
}

// ── In-memory recovery state ─────────────────────────────────────────────────
// Tracks unrecovered loss per symbol so we can switch tiers automatically.
interface RecoveryState {
  unrecoveredLoss: number;  // USD amount not yet recovered
  lastLossAt: number;       // unix ms
}
const recoveryStore = new Map<string, RecoveryState>();

// ── Global digit recovery state (set by the autonomous loop) ─────────────────
// When the global cross-market recovery is active, ALL symbols enter digit
// recovery tier 2 (OVER 4 / UNDER 5) regardless of per-symbol history.
let _globalDigitRecoveryActive = false;
let _globalDigitUnrecoveredAmount = 0;

/** Called by the autonomous loop to sync global recovery state into the digit agent. */
export function setGlobalDigitRecovery(active: boolean, amount: number): void {
  _globalDigitRecoveryActive = active;
  _globalDigitUnrecoveredAmount = amount;
}

/** Call after every DIGIT trade to update recovery state. */
export function updateDigitRecovery(
  symbol: string,
  contractType: string,
  won: boolean,
  profit: number,
  stake: number,
): void {
  if (!contractType.startsWith("DIGIT")) return;
  const prev = recoveryStore.get(symbol) ?? { unrecoveredLoss: 0, lastLossAt: 0 };
  let unrecoveredLoss: number;
  if (won) {
    // Any win fully clears per-symbol recovery
    unrecoveredLoss = 0;
  } else {
    // New loss: add stake to unrecovered amount
    unrecoveredLoss = prev.unrecoveredLoss + Math.abs(stake);
  }
  recoveryStore.set(symbol, { unrecoveredLoss, lastLossAt: won ? prev.lastLossAt : Date.now() });
}

/**
 * True when this symbol's digit trades are in recovery mode.
 * Returns true if EITHER the global recovery is active (cross-market loss)
 * OR there is a per-symbol unrecovered loss.
 */
export function isInDigitRecovery(symbol: string): boolean {
  if (_globalDigitRecoveryActive) return true;
  return (recoveryStore.get(symbol)?.unrecoveredLoss ?? 0) > 0;
}

export function getDigitRecoveryAmount(symbol: string): number {
  // Return the larger of global or per-symbol amount
  const perSymbol = recoveryStore.get(symbol)?.unrecoveredLoss ?? 0;
  return Math.max(perSymbol, _globalDigitUnrecoveredAmount);
}

// ── Markov chain ──────────────────────────────────────────────────────────────
function buildTransitionMatrix(digits: number[]): number[][] {
  const matrix = Array.from({ length: 10 }, () => Array(10).fill(0));
  for (let i = 1; i < digits.length; i++) {
    matrix[digits[i - 1]][digits[i]]++;
  }
  return matrix.map((row) => {
    const sum = row.reduce((a: number, b: number) => a + b, 0) + 10;
    return row.map((c: number) => (c + 1) / sum);
  });
}

function markovNextProbs(trans: number[][], lastDigit: number): number[] {
  return trans[lastDigit];
}

// ── Chi-square test ───────────────────────────────────────────────────────────
function chiSquare(digits: number[]): number {
  const counts = Array(10).fill(0);
  for (const d of digits) counts[d]++;
  const expected = digits.length / 10;
  return counts.reduce((s: number, c: number) => s + ((c - expected) ** 2) / expected, 0);
}

// ── Window selection ──────────────────────────────────────────────────────────
const WINDOWS = [30, 50, 75, 100, 150, 200];

function selectOptimalWindow(digits: number[]): number {
  let bestWindow = 50, bestScore = -Infinity;
  for (const w of WINDOWS) {
    if (digits.length < w) continue;
    const window = digits.slice(-w);
    const chi2 = chiSquare(window);
    const trans = buildTransitionMatrix(window);
    const last = window[window.length - 1];
    const markovEntropy = -trans[last].reduce((s: number, p: number) => p > 0 ? s + p * Math.log2(p) : s, 0);
    const score = chi2 * 0.4 - markovEntropy * 0.5 + Math.log(w) * 0.1;
    if (score > bestScore) { bestScore = score; bestWindow = w; }
  }
  return Math.min(bestWindow, digits.length);
}

// ── Barrier scoring ───────────────────────────────────────────────────────────
export interface BarrierOption {
  contractType: "DIGITOVER" | "DIGITUNDER";
  barrier: number;
  winProbability: number;
  theoreticalWinProb: number;
  edge: number;
  payout: number;
  expectedValue: number;
  evScore: number;
  tier: 1 | 2 | 0;  // 1=safe, 2=recovery, 0=risky (OVER 7-8, UNDER 1-2)
  isConservative: boolean;
  adjustedEvScore: number;
}

function scoreAllBarriers(
  _digits: number[],
  markovProbs: number[],
  multinomialProbs: number[],
  inRecovery: boolean,
): BarrierOption[] {
  // Combined model: 55% Markov, 45% multinomial
  const combined = Array.from({ length: 10 }, (_, d) =>
    markovProbs[d] * 0.55 + multinomialProbs[d] * 0.45
  );

  const rawOptions: BarrierOption[] = [];

  // OVER barriers: B from 0 to 8 (0 is ultra-safe, 8 is ultra-risky)
  for (let b = 0; b <= 8; b++) {
    const pWin = combined.slice(b + 1).reduce((s: number, p: number) => s + p, 0);
    const payout = OVER_PAYOUTS[b] ?? 1.1;
    const theoretical = OVER_THEORETICAL[b];
    const edge = pWin - theoretical;
    const ev = pWin * payout - 1;
    const tier: 1 | 2 | 0 = TIER1_OVER.has(b) ? 1 : TIER2_OVER.has(b) ? 2 : 0;
    const baseEvScore = ev > 0 ? edge * (1 + ev) : -1;
    rawOptions.push({
      contractType: "DIGITOVER",
      barrier: b,
      winProbability: pWin,
      theoreticalWinProb: theoretical,
      edge,
      payout,
      expectedValue: ev,
      evScore: baseEvScore,
      tier,
      isConservative: tier === 1,
      adjustedEvScore: baseEvScore,
    });
  }

  // UNDER barriers: B from 1 to 9 (9 is ultra-safe, 1 is ultra-risky)
  for (let b = 1; b <= 9; b++) {
    const pWin = combined.slice(0, b).reduce((s: number, p: number) => s + p, 0);
    const payout = UNDER_PAYOUTS[b] ?? 1.1;
    const theoretical = UNDER_THEORETICAL[b];
    const edge = pWin - theoretical;
    const ev = pWin * payout - 1;
    const tier: 1 | 2 | 0 = TIER1_UNDER.has(b) ? 1 : TIER2_UNDER.has(b) ? 2 : 0;
    const baseEvScore = ev > 0 ? edge * (1 + ev) : -1;
    rawOptions.push({
      contractType: "DIGITUNDER",
      barrier: b,
      winProbability: pWin,
      theoreticalWinProb: theoretical,
      edge,
      payout,
      expectedValue: ev,
      evScore: baseEvScore,
      tier,
      isConservative: tier === 1,
      adjustedEvScore: baseEvScore,
    });
  }

  // ── Hard-block specific risky barriers — NEVER select these ──────────────
  // Only block OVER 7/8 (10-20% win) and UNDER 1/2 (10-20% win).
  // OVER 0 (90% win, 1.05x payout) and UNDER 9 (90% win, 1.05x payout) are
  // tier-0 but NOT blocked — they can serve as a last-resort fallback.
  for (const opt of rawOptions) {
    const isHardBlocked = opt.contractType === "DIGITOVER"
      ? HARD_BLOCKED_OVER.has(opt.barrier)
      : HARD_BLOCKED_UNDER.has(opt.barrier);
    if (isHardBlocked) {
      opt.adjustedEvScore = -Infinity;
    }
  }

  // ── Apply tiered preference ───────────────────────────────────────────────
  // 1. First try: positive-EV options in the current preferred tier
  const preferredTier = inRecovery ? 2 : 1;
  const preferredWithEV = rawOptions
    .filter((o) => o.tier === preferredTier && o.expectedValue > 0.003)
    .sort((a, b) => b.evScore - a.evScore);

  // Tier-1/2 with positive EDGE (actual win rate > theoretical) — no positive EV required.
  // OVER 2 pays 1.19x so breakeven is 84% — unreachable. But if the market is skewed so
  // that digit 3–9 appear more than 70% of the time, that IS a real edge worth trading.
  const preferredWithEdge = rawOptions
    .filter((o) => o.tier === preferredTier && o.edge > 0)
    .sort((a, b) => b.evScore - a.evScore);

  if (preferredWithEdge.length > 0) {
    // Found preferred-tier options with positive edge — boost so they always win the sort
    for (const opt of preferredWithEdge) {
      opt.adjustedEvScore = opt.evScore * 10 + opt.edge * 50; // guaranteed top
    }
  } else if (preferredWithEV.length > 0) {
    // Preferred tier has positive EV (rare but possible in extreme skew)
    for (const opt of preferredWithEV) {
      opt.adjustedEvScore = opt.evScore * 8;
    }
  } else {
    // Fallback: any tier 1 or 2 option with positive EV (tier 0 remains blocked)
    const anyPositive = rawOptions.filter((o) => o.expectedValue > 0 && o.tier !== 0);
    if (anyPositive.length > 0) {
      for (const opt of anyPositive) {
        opt.adjustedEvScore = opt.evScore * 2;
      }
    }
  }

  return rawOptions.sort((a, b) => b.adjustedEvScore - a.adjustedEvScore);
}

// ── Main digit analysis ───────────────────────────────────────────────────────
export interface DigitAnalysisResult {
  bestOption: BarrierOption | null;
  topOptions: BarrierOption[];
  tier1Options: BarrierOption[];  // Tier 1 safe options (with or without positive EV)
  tier2Options: BarrierOption[];  // Tier 2 recovery options
  windowSize: number;
  chiSquare: number;
  hasEdge: boolean;
  multinomialProbs: number[];
  markovProbs: number[];
  lastDigit: number;
  inRecovery: boolean;
  unrecoveredLoss: number;
}

export function analyzeDigitEdge(
  digitFeatures: DigitFeatures,
  inRecovery: boolean = false,
  unrecoveredLoss: number = 0,
): DigitAnalysisResult {
  const digits = digitFeatures.digits;
  if (digits.length < 30) {
    return {
      bestOption: null, topOptions: [], tier1Options: [], tier2Options: [],
      windowSize: 0, chiSquare: 0,
      hasEdge: false, multinomialProbs: Array(10).fill(0.1),
      markovProbs: Array(10).fill(0.1), lastDigit: digitFeatures.lastDigit,
      inRecovery, unrecoveredLoss,
    };
  }

  const windowSize = selectOptimalWindow(digits);
  const window = digits.slice(-windowSize);
  const chi2 = chiSquare(window);
  const trans = buildTransitionMatrix(window);
  const lastDigit = window[window.length - 1];

  const counts = Array(10).fill(0);
  for (const d of window) counts[d]++;
  const total = window.length;
  const multinomialProbs = counts.map((c: number) => (c + 1) / (total + 10));
  const markovProbs = markovNextProbs(trans, lastDigit);

  const allOptions = scoreAllBarriers(window, markovProbs, multinomialProbs, inRecovery);

  // Build tier views (all barriers, sorted by evScore within tier)
  const tier1Options = allOptions
    .filter((o) => o.tier === 1 && o.expectedValue > -0.1)
    .sort((a, b) => b.evScore - a.evScore);
  const tier2Options = allOptions
    .filter((o) => o.tier === 2 && o.expectedValue > -0.1)
    .sort((a, b) => b.evScore - a.evScore);

  // Exclude hard-blocked barriers (OVER 7/8, UNDER 1/2) from eligible options.
  const isHardBlockedOption = (o: BarrierOption) =>
    o.contractType === "DIGITOVER" ? HARD_BLOCKED_OVER.has(o.barrier) : HARD_BLOCKED_UNDER.has(o.barrier);

  // Primary: preferred tier (tier 1 normal, tier 2 recovery) with positive EDGE.
  // OVER 2 pays only 1.19x — positive EV requires an impossible 84% win rate, so
  // we use EDGE (actual win rate > theoretical) as the signal instead.
  const preferredTier = inRecovery ? 2 : 1;
  const preferredEdgeOptions = allOptions
    .filter((o) => o.tier === preferredTier && o.edge > 0 && !isHardBlockedOption(o))
    .sort((a, b) => b.adjustedEvScore - a.adjustedEvScore);

  // Fallback: any non-blocked option with strict positive EV
  const positiveEV = allOptions.filter((o) => o.expectedValue > 0.003 && !isHardBlockedOption(o));

  const bestOption = preferredEdgeOptions[0] ?? positiveEV[0] ?? null;

  // topOptions = preferred-tier edge options UNION positive-EV options, deduplicated, best first
  const topOptionSet = new Set<BarrierOption>([...preferredEdgeOptions, ...positiveEV]);
  const topOptions = [...topOptionSet]
    .sort((a, b) => b.adjustedEvScore - a.adjustedEvScore)
    .slice(0, 8);

  return {
    bestOption,
    topOptions,
    tier1Options,
    tier2Options,
    windowSize,
    chiSquare: chi2,
    // hasEdge = true whenever the preferred-tier barrier has a positive deviation from theoretical
    hasEdge: bestOption !== null && bestOption.edge > 0,
    multinomialProbs,
    markovProbs,
    lastDigit,
    inRecovery,
    unrecoveredLoss,
  };
}

// ── Agent runner ──────────────────────────────────────────────────────────────
export function runDigitAgent(
  ctx: ScanContext,
  digitFeatures: DigitFeatures | null,
  inRecovery: boolean = false,
): AgentOutput & { digitResult: DigitAnalysisResult | null } {
  const t0 = Date.now();

  if (!digitFeatures || digitFeatures.digits.length < 30) {
    return {
      agentId: "digitDistribution",
      score: 0, confidence: 0, signal: "neutral",
      reasoning: "Insufficient digit data (need ≥30 ticks).",
      data: { inRecovery, topOptions: [], tier1Options: [], tier2Options: [] },
      executionTimeMs: Date.now() - t0, digitResult: null,
    };
  }

  const unrecoveredLoss = getDigitRecoveryAmount(ctx.symbol);
  const result = analyzeDigitEdge(digitFeatures, inRecovery, unrecoveredLoss);
  const best = result.bestOption;

  let score = 0;
  let reasoning = "No edge setup found for preferred digit barrier.";

  if (best) {
    // Tier-1 barriers (OVER 2, UNDER 8) have low payouts by design — positive EV
    // is mathematically impossible. Score them by edge quality (actual win rate
    // above theoretical) rather than EV, so they don't drag down the consensus.
    const isTier1 = best.tier === 1;
    const primaryScore = isTier1
      ? Math.min(100, 50 + best.edge * 600)   // edge-based: +1% edge → +6 pts
      : Math.min(100, 50 + best.expectedValue * 400); // EV-based for tier 2+
    const edgeScore = Math.min(100, 50 + best.edge * 500);
    const chi2Bonus = Math.min(10, result.chiSquare * 0.5);
    score = Math.round((primaryScore * 0.6 + edgeScore * 0.3 + chi2Bonus * 0.1));

    const tierLabel = best.tier === 1
      ? "[TIER 1 — Safe compounding]"
      : best.tier === 2
        ? "[TIER 2 — Recovery mode]"
        : "[HIGH-RISK — last resort]";

    reasoning = [
      `${inRecovery ? "🔄 RECOVERY MODE" : "✅ NORMAL MODE"} ${tierLabel}`,
      `Best: ${best.contractType} barrier=${best.barrier}`,
      `WinP=${(best.winProbability * 100).toFixed(1)}%`,
      `(theoretical=${(best.theoreticalWinProb * 100).toFixed(0)}%)`,
      `edge=${(best.edge * 100).toFixed(1)}%`,
      `EV=${(best.expectedValue * 100).toFixed(1)}%`,
      `payout=${best.payout}x`,
      `chi²=${result.chiSquare.toFixed(1)}`,
      `window=${result.windowSize}`,
      inRecovery ? `unrecovered=$${unrecoveredLoss.toFixed(2)}` : "",
    ].filter(Boolean).join(", ");
  } else if (inRecovery) {
    reasoning = `🔄 Recovery mode active ($${unrecoveredLoss.toFixed(2)} to recover) — no positive-EV setup in Tier 2.`;
  }

  return {
    agentId: "digitDistribution",
    score,
    confidence: result.hasEdge ? Math.min(95, Math.round(result.chiSquare * 2 + score * 0.5)) : 0,
    signal: scoreToSignal(score),
    reasoning,
    data: {
      bestOption: best,
      topOptions: result.topOptions,
      tier1Options: result.tier1Options,
      tier2Options: result.tier2Options,
      inRecovery,
      unrecoveredLoss,
      windowSize: result.windowSize,
      chiSquare: result.chiSquare,
      lastDigit: result.lastDigit,
    },
    executionTimeMs: Date.now() - t0,
    digitResult: result,
  };
}

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

// ── Allowed barriers — always OVER 2 / UNDER 7 ───────────────────────────────
// The engine always uses these safe, consistent barriers regardless of
// win/loss history. Tier 1 (safe) only.
const ALLOWED_OVER  = new Set([2]);
const ALLOWED_UNDER = new Set([7]);

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
): BarrierOption[] {
  // Combined model: 55% Markov, 45% multinomial
  const combined = Array.from({ length: 10 }, (_, d) =>
    markovProbs[d] * 0.55 + multinomialProbs[d] * 0.45
  );

  const rawOptions: BarrierOption[] = [];

  // OVER 2 only
  for (const b of ALLOWED_OVER) {
    const pWin = combined.slice(b + 1).reduce((s: number, p: number) => s + p, 0);
    const payout = OVER_PAYOUTS[b] ?? 1.1;
    const theoretical = OVER_THEORETICAL[b];
    const edge = pWin - theoretical;
    const ev = pWin * payout - 1;
    const baseEvScore = ev > 0 ? edge * (1 + ev) : -1;
    const adjustedEvScore = edge > 0 ? baseEvScore * 10 + edge * 50 : baseEvScore;
    rawOptions.push({
      contractType: "DIGITOVER",
      barrier: b,
      winProbability: pWin,
      theoreticalWinProb: theoretical,
      edge,
      payout,
      expectedValue: ev,
      evScore: baseEvScore,
      tier: 1,
      isConservative: true,
      adjustedEvScore,
    });
  }

  // UNDER 7 only
  for (const b of ALLOWED_UNDER) {
    const pWin = combined.slice(0, b).reduce((s: number, p: number) => s + p, 0);
    const payout = UNDER_PAYOUTS[b] ?? 1.1;
    const theoretical = UNDER_THEORETICAL[b];
    const edge = pWin - theoretical;
    const ev = pWin * payout - 1;
    const baseEvScore = ev > 0 ? edge * (1 + ev) : -1;
    const adjustedEvScore = edge > 0 ? baseEvScore * 10 + edge * 50 : baseEvScore;
    rawOptions.push({
      contractType: "DIGITUNDER",
      barrier: b,
      winProbability: pWin,
      theoreticalWinProb: theoretical,
      edge,
      payout,
      expectedValue: ev,
      evScore: baseEvScore,
      tier: 1,
      isConservative: true,
      adjustedEvScore,
    });
  }

  return rawOptions.sort((a, b) => b.adjustedEvScore - a.adjustedEvScore);
}

// ── Main digit analysis ───────────────────────────────────────────────────────
export interface DigitAnalysisResult {
  bestOption: BarrierOption | null;
  topOptions: BarrierOption[];
  tier1Options: BarrierOption[];
  tier2Options: BarrierOption[];
  windowSize: number;
  chiSquare: number;
  hasEdge: boolean;
  multinomialProbs: number[];
  markovProbs: number[];
  lastDigit: number;
}

export function analyzeDigitEdge(
  digitFeatures: DigitFeatures,
): DigitAnalysisResult {
  const digits = digitFeatures.digits;
  if (digits.length < 30) {
    return {
      bestOption: null, topOptions: [], tier1Options: [], tier2Options: [],
      windowSize: 0, chiSquare: 0,
      hasEdge: false, multinomialProbs: Array(10).fill(0.1),
      markovProbs: Array(10).fill(0.1), lastDigit: digitFeatures.lastDigit,
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

  const allOptions = scoreAllBarriers(window, markovProbs, multinomialProbs);

  // Tier 1 only (OVER 2 / UNDER 7)
  const tier1Options = allOptions
    .filter((o) => o.tier === 1 && o.expectedValue > -0.1)
    .sort((a, b) => b.evScore - a.evScore);
  const tier2Options: BarrierOption[] = []; // no tier 2 — always normal barriers

  // Pick best option: prefer positive edge, fall back to any option
  const edgeOptions = allOptions.filter((o) => o.edge > 0).sort((a, b) => b.adjustedEvScore - a.adjustedEvScore);
  const bestOption = edgeOptions[0] ?? allOptions[0] ?? null;

  const topOptions = allOptions.slice(0, 8);

  return {
    bestOption,
    topOptions,
    tier1Options,
    tier2Options,
    windowSize,
    chiSquare: chi2,
    hasEdge: bestOption !== null && bestOption.edge > 0,
    multinomialProbs,
    markovProbs,
    lastDigit,
  };
}

// ── Agent runner ──────────────────────────────────────────────────────────────
export function runDigitAgent(
  ctx: ScanContext,
  digitFeatures: DigitFeatures | null,
): AgentOutput & { digitResult: DigitAnalysisResult | null } {
  const t0 = Date.now();

  if (!digitFeatures || digitFeatures.digits.length < 30) {
    return {
      agentId: "digitDistribution",
      score: 0, confidence: 0, signal: "neutral",
      reasoning: "Insufficient digit data (need ≥30 ticks).",
      data: { topOptions: [], tier1Options: [], tier2Options: [] },
      executionTimeMs: Date.now() - t0, digitResult: null,
    };
  }

  const result = analyzeDigitEdge(digitFeatures);
  const best = result.bestOption;

  let score = 0;
  let reasoning = "No edge setup found for OVER 2 / UNDER 7 barrier.";

  if (best) {
    // OVER 2 / UNDER 7 have low payouts by design — positive EV is very rare.
    // Score by edge quality (actual win rate above theoretical) instead.
    const primaryScore = Math.min(100, 50 + best.edge * 600);
    const edgeScore = Math.min(100, 50 + best.edge * 500);
    const chi2Bonus = Math.min(10, result.chiSquare * 0.5);
    score = Math.round((primaryScore * 0.6 + edgeScore * 0.3 + chi2Bonus * 0.1));

    reasoning = [
      `✅ NORMAL MODE [OVER 2 / UNDER 7]`,
      `Best: ${best.contractType} barrier=${best.barrier}`,
      `WinP=${(best.winProbability * 100).toFixed(1)}%`,
      `(theoretical=${(best.theoreticalWinProb * 100).toFixed(0)}%)`,
      `edge=${(best.edge * 100).toFixed(1)}%`,
      `EV=${(best.expectedValue * 100).toFixed(1)}%`,
      `payout=${best.payout}x`,
      `chi²=${result.chiSquare.toFixed(1)}`,
      `window=${result.windowSize}`,
    ].join(", ");
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
      windowSize: result.windowSize,
      chiSquare: result.chiSquare,
      lastDigit: result.lastDigit,
    },
    executionTimeMs: Date.now() - t0,
    digitResult: result,
  };
}

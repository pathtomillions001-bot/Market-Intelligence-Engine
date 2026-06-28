/**
 * Digit Distribution Agent
 *
 * RESPONSIBILITY: Analyze digit sequences exclusively for OVER/UNDER contracts.
 * This agent is completely separated from the direction agent because Over/Under
 * mechanics are fundamentally different from Rise/Fall:
 *   - Only the LAST DIGIT of the exit price matters
 *   - Duration = number of ticks (we only care about the Nth tick)
 *   - Distribution should be near-uniform (0-9, each ~10%) but can have temporary bias
 *
 * Methods:
 *   1. Multinomial frequency model (smoothed counts)
 *   2. First-order Markov chain (transition probabilities)
 *   3. Chi-square test to measure deviation from uniform
 *   4. EV-weighted barrier selection across all possible barriers
 *
 * Key insight: OVER barrier=B wins when digit > B → P(win) = fraction of digits > B.
 * UNDER barrier=B wins when digit < B → P(win) = fraction of digits < B.
 * We pick the barrier that maximizes positive expected value given the actual payout.
 */

import type { AgentOutput, ScanContext } from "./types";
import { scoreToSignal } from "./types";
import type { DigitFeatures } from "./feature-engineering";

// ── Deriv payout table (approximate, validated against live Deriv prices) ─────
// OVER barrier B: wins when last digit > B. B=0 → 9/10 digits win → lowest payout.
// UNDER barrier B: wins when last digit < B. B=9 → 9/10 digits win → lowest payout.
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

// ── Markov chain for digit sequences ─────────────────────────────────────────

function buildTransitionMatrix(digits: number[]): number[][] {
  const matrix = Array.from({ length: 10 }, () => Array(10).fill(0));
  for (let i = 1; i < digits.length; i++) {
    matrix[digits[i - 1]][digits[i]]++;
  }
  // Laplace smoothing
  return matrix.map((row) => {
    const sum = row.reduce((a, b) => a + b, 0) + 10;
    return row.map((c) => (c + 1) / sum);
  });
}

function markovNextProbs(trans: number[][], lastDigit: number): number[] {
  return trans[lastDigit];
}

// ── Chi-square test ──────────────────────────────────────────────────────────

function chiSquare(digits: number[]): number {
  const counts = Array(10).fill(0);
  for (const d of digits) counts[d]++;
  const expected = digits.length / 10;
  return counts.reduce((s, c) => s + ((c - expected) ** 2) / expected, 0);
}

// ── Optimal window selection ─────────────────────────────────────────────────
// Try multiple windows and pick the one with highest statistical signal
const WINDOWS = [30, 50, 75, 100, 150, 200];

function selectOptimalWindow(digits: number[]): number {
  let bestWindow = 50, bestScore = -Infinity;
  for (const w of WINDOWS) {
    if (digits.length < w) continue;
    const window = digits.slice(-w);
    const chi2 = chiSquare(window);
    const trans = buildTransitionMatrix(window);
    const last = window[window.length - 1];
    // Low Markov entropy = more predictable next digit
    const markovEntropy = -trans[last].reduce((s, p) => p > 0 ? s + p * Math.log2(p) : s, 0);
    // Score: more chi2 deviation + less Markov entropy = better edge
    const score = chi2 * 0.4 - markovEntropy * 0.5 + Math.log(w) * 0.1;
    if (score > bestScore) { bestScore = score; bestWindow = w; }
  }
  return Math.min(bestWindow, digits.length);
}

// ── Barrier scoring ───────────────────────────────────────────────────────────

export interface BarrierOption {
  contractType: "DIGITOVER" | "DIGITUNDER";
  barrier: number;
  winProbability: number;      // empirical from combined model
  theoreticalWinProb: number;  // from uniform assumption
  edge: number;                // empirical - theoretical (positive = favorable)
  payout: number;
  expectedValue: number;       // EV per $1 stake: winProb * payout - 1
  evScore: number;             // rank metric
}

function scoreAllBarriers(
  digits: number[],
  markovProbs: number[],
  multinomialProbs: number[],
): BarrierOption[] {
  // Combined model: 55% Markov, 45% multinomial
  const combined = Array.from({ length: 10 }, (_, d) =>
    markovProbs[d] * 0.55 + multinomialProbs[d] * 0.45
  );

  const options: BarrierOption[] = [];

  // OVER barriers: B from 0 to 8
  for (let b = 0; b <= 8; b++) {
    const pWin = combined.slice(b + 1).reduce((s, p) => s + p, 0);
    const payout = OVER_PAYOUTS[b] ?? 1.1;
    const theoretical = OVER_THEORETICAL[b];
    const edge = pWin - theoretical;
    const ev = pWin * payout - 1;  // EV per $1 stake
    options.push({
      contractType: "DIGITOVER",
      barrier: b,
      winProbability: pWin,
      theoreticalWinProb: theoretical,
      edge,
      payout,
      expectedValue: ev,
      evScore: ev > 0 ? edge * (1 + ev) : -1,
    });
  }

  // UNDER barriers: B from 1 to 9
  for (let b = 1; b <= 9; b++) {
    const pWin = combined.slice(0, b).reduce((s, p) => s + p, 0);
    const payout = UNDER_PAYOUTS[b] ?? 1.1;
    const theoretical = UNDER_THEORETICAL[b];
    const edge = pWin - theoretical;
    const ev = pWin * payout - 1;
    options.push({
      contractType: "DIGITUNDER",
      barrier: b,
      winProbability: pWin,
      theoreticalWinProb: theoretical,
      edge,
      payout,
      expectedValue: ev,
      evScore: ev > 0 ? edge * (1 + ev) : -1,
    });
  }

  return options.sort((a, b) => b.evScore - a.evScore);
}

// ── Main digit analysis ───────────────────────────────────────────────────────

export interface DigitAnalysisResult {
  bestOption: BarrierOption | null;
  topOptions: BarrierOption[];  // top 3 by EV
  windowSize: number;
  chiSquare: number;
  hasEdge: boolean;
  multinomialProbs: number[];
  markovProbs: number[];
  lastDigit: number;
}

export function analyzeDigitEdge(digitFeatures: DigitFeatures): DigitAnalysisResult {
  const digits = digitFeatures.digits;
  if (digits.length < 30) {
    return {
      bestOption: null,
      topOptions: [],
      windowSize: 0,
      chiSquare: 0,
      hasEdge: false,
      multinomialProbs: Array(10).fill(0.1),
      markovProbs: Array(10).fill(0.1),
      lastDigit: digitFeatures.lastDigit,
    };
  }

  const windowSize = selectOptimalWindow(digits);
  const window = digits.slice(-windowSize);
  const chi2 = chiSquare(window);
  const trans = buildTransitionMatrix(window);
  const lastDigit = window[window.length - 1];

  // Multinomial (frequency model)
  const counts = Array(10).fill(0);
  for (const d of window) counts[d]++;
  const total = window.length;
  const multinomialProbs = counts.map((c) => (c + 1) / (total + 10)); // Laplace

  const markovProbs = markovNextProbs(trans, lastDigit);

  const allOptions = scoreAllBarriers(window, markovProbs, multinomialProbs);
  const positiveEV = allOptions.filter((o) => o.expectedValue > 0.01);
  const bestOption = positiveEV.length > 0 ? positiveEV[0] : null;

  return {
    bestOption,
    topOptions: positiveEV.slice(0, 3),
    windowSize,
    chiSquare: chi2,
    hasEdge: bestOption !== null && bestOption.edge > 0.02,
    multinomialProbs,
    markovProbs,
    lastDigit,
  };
}

// ── Agent runner ──────────────────────────────────────────────────────────────

export function runDigitAgent(ctx: ScanContext, digitFeatures: DigitFeatures | null): AgentOutput & { digitResult: DigitAnalysisResult | null } {
  const t0 = Date.now();

  if (!digitFeatures || digitFeatures.digits.length < 30) {
    return {
      agentId: "digitDistribution",
      score: 0,
      confidence: 0,
      signal: "neutral",
      reasoning: "Insufficient digit data (need ≥30 ticks).",
      data: {},
      executionTimeMs: Date.now() - t0,
      digitResult: null,
    };
  }

  const result = analyzeDigitEdge(digitFeatures);
  const best = result.bestOption;

  // Agent score: how strong is the digit edge?
  let score = 0;
  let reasoning = "No positive-EV digit setup found.";

  if (best) {
    // Scale score based on EV quality
    // EV of 0 = breakeven (score ~55), EV of 0.10 = excellent (score ~85)
    const evScore = Math.min(100, 50 + best.expectedValue * 400);
    const edgeScore = Math.min(100, 50 + best.edge * 500);
    const chi2Bonus = Math.min(10, result.chiSquare * 0.5);
    score = Math.round((evScore * 0.6 + edgeScore * 0.3 + chi2Bonus * 0.1));

    reasoning = [
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
      chiSquare: result.chiSquare,
      windowSize: result.windowSize,
      hasEdge: result.hasEdge,
      lastDigit: result.lastDigit,
    },
    executionTimeMs: Date.now() - t0,
    digitResult: result,
  };
}

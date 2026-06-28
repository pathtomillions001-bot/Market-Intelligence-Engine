/**
 * Digit Distribution Agent
 *
 * RESPONSIBILITY: Analyze digit sequences exclusively for OVER/UNDER contracts.
 *
 * Selection philosophy (Task 1 redesign):
 *   - Rank ALL Over and Under barriers by probability-adjusted expected value
 *   - Prefer CONSERVATIVE options (OVER 1-4, UNDER 6-9) when their EV is within
 *     CONSERVATIVE_BONUS_THRESHOLD of the best option. This avoids chasing
 *     high-payout low-probability bets (OVER 7, OVER 8, UNDER 1, UNDER 2)
 *     that produce poor real-world performance despite occasional high payouts.
 *   - The chosen contract is always justified by the probability model — we
 *     never force a particular digit if another has materially better support.
 *
 * Conservative definitions:
 *   OVER barriers 0-4: win probability ≥ 50% by uniform distribution
 *   UNDER barriers 6-9: win probability ≥ 40% by uniform distribution
 *   → These are inherently lower risk per-contract
 *
 * Methods:
 *   1. Multinomial frequency model (smoothed counts)
 *   2. First-order Markov chain (transition probabilities)
 *   3. Chi-square test to measure deviation from uniform
 *   4. EV-weighted barrier selection with conservative preference
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

// ── Conservative barrier definitions ─────────────────────────────────────────
// Conservative = higher win probability = lower payout multiplier
// These are reliable, compounding plays vs gambling on extremes.
function isConservativeBarrier(contractType: "DIGITOVER" | "DIGITUNDER", barrier: number): boolean {
  if (contractType === "DIGITOVER") return barrier <= 4;  // OVER 0-4: win prob ≥50%
  if (contractType === "DIGITUNDER") return barrier >= 6; // UNDER 6-9: win prob ≥40%
  return false;
}

// Conservative preference: if a conservative option has EV within this fraction
// of the best option, prefer it. E.g. 0.25 means "within 25% of best EV".
const CONSERVATIVE_BONUS_THRESHOLD = 0.25;
// Extra score multiplier for conservative options to break ties
const CONSERVATIVE_BONUS_SCORE = 0.15;

// ── Markov chain ──────────────────────────────────────────────────────────────

function buildTransitionMatrix(digits: number[]): number[][] {
  const matrix = Array.from({ length: 10 }, () => Array(10).fill(0));
  for (let i = 1; i < digits.length; i++) {
    matrix[digits[i - 1]][digits[i]]++;
  }
  return matrix.map((row) => {
    const sum = row.reduce((a, b) => a + b, 0) + 10;
    return row.map((c) => (c + 1) / sum);
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
  return counts.reduce((s, c) => s + ((c - expected) ** 2) / expected, 0);
}

// ── Optimal window selection ──────────────────────────────────────────────────
const WINDOWS = [30, 50, 75, 100, 150, 200];

function selectOptimalWindow(digits: number[]): number {
  let bestWindow = 50, bestScore = -Infinity;
  for (const w of WINDOWS) {
    if (digits.length < w) continue;
    const window = digits.slice(-w);
    const chi2 = chiSquare(window);
    const trans = buildTransitionMatrix(window);
    const last = window[window.length - 1];
    const markovEntropy = -trans[last].reduce((s, p) => p > 0 ? s + p * Math.log2(p) : s, 0);
    const score = chi2 * 0.4 - markovEntropy * 0.5 + Math.log(w) * 0.1;
    if (score > bestScore) { bestScore = score; bestWindow = w; }
  }
  return Math.min(bestWindow, digits.length);
}

// ── Barrier scoring with conservative preference ───────────────────────────────

export interface BarrierOption {
  contractType: "DIGITOVER" | "DIGITUNDER";
  barrier: number;
  winProbability: number;
  theoreticalWinProb: number;
  edge: number;               // empirical - theoretical
  payout: number;
  expectedValue: number;      // EV per $1 stake: winProb * payout - 1
  evScore: number;            // primary ranking metric
  isConservative: boolean;    // true for lower-risk barriers
  adjustedEvScore: number;    // evScore with conservative bonus applied
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

  const rawOptions: BarrierOption[] = [];

  // OVER barriers: B from 0 to 8
  for (let b = 0; b <= 8; b++) {
    const pWin = combined.slice(b + 1).reduce((s, p) => s + p, 0);
    const payout = OVER_PAYOUTS[b] ?? 1.1;
    const theoretical = OVER_THEORETICAL[b];
    const edge = pWin - theoretical;
    const ev = pWin * payout - 1;
    const isConservative = isConservativeBarrier("DIGITOVER", b);
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
      isConservative,
      adjustedEvScore: baseEvScore, // will be set below
    });
  }

  // UNDER barriers: B from 1 to 9
  for (let b = 1; b <= 9; b++) {
    const pWin = combined.slice(0, b).reduce((s, p) => s + p, 0);
    const payout = UNDER_PAYOUTS[b] ?? 1.1;
    const theoretical = UNDER_THEORETICAL[b];
    const edge = pWin - theoretical;
    const ev = pWin * payout - 1;
    const isConservative = isConservativeBarrier("DIGITUNDER", b);
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
      isConservative,
      adjustedEvScore: baseEvScore,
    });
  }

  // ── Apply conservative preference ────────────────────────────────────────
  const positiveEV = rawOptions.filter((o) => o.expectedValue > 0);
  if (positiveEV.length === 0) return rawOptions.sort((a, b) => b.evScore - a.evScore);

  const bestEV = positiveEV.reduce((best, o) => o.expectedValue > best.expectedValue ? o : best, positiveEV[0]);

  for (const opt of rawOptions) {
    if (opt.expectedValue <= 0) {
      opt.adjustedEvScore = opt.evScore;
      continue;
    }

    // Conservative bonus: if this option's EV is within CONSERVATIVE_BONUS_THRESHOLD
    // of the best option's EV, and it IS conservative, boost its ranking score.
    const evRatio = opt.expectedValue / Math.max(0.001, bestEV.expectedValue);
    const isCompetitive = evRatio >= (1 - CONSERVATIVE_BONUS_THRESHOLD);

    if (opt.isConservative && isCompetitive) {
      // Boost the adjustedEvScore to prefer this conservative option
      opt.adjustedEvScore = opt.evScore * (1 + CONSERVATIVE_BONUS_SCORE);
    } else {
      opt.adjustedEvScore = opt.evScore;
    }
  }

  // Sort by adjustedEvScore descending
  return rawOptions.sort((a, b) => b.adjustedEvScore - a.adjustedEvScore);
}

// ── Main digit analysis ───────────────────────────────────────────────────────

export interface DigitAnalysisResult {
  bestOption: BarrierOption | null;
  topOptions: BarrierOption[];
  windowSize: number;
  chiSquare: number;
  hasEdge: boolean;
  multinomialProbs: number[];
  markovProbs: number[];
  lastDigit: number;
  conservativeSelected: boolean;  // whether conservative preference was applied
}

export function analyzeDigitEdge(digitFeatures: DigitFeatures): DigitAnalysisResult {
  const digits = digitFeatures.digits;
  if (digits.length < 30) {
    return {
      bestOption: null, topOptions: [], windowSize: 0, chiSquare: 0,
      hasEdge: false, multinomialProbs: Array(10).fill(0.1),
      markovProbs: Array(10).fill(0.1), lastDigit: digitFeatures.lastDigit,
      conservativeSelected: false,
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
  const multinomialProbs = counts.map((c) => (c + 1) / (total + 10));
  const markovProbs = markovNextProbs(trans, lastDigit);

  const allOptions = scoreAllBarriers(window, markovProbs, multinomialProbs);

  // Filter to only positive EV options, already sorted by adjustedEvScore
  const positiveEV = allOptions.filter((o) => o.expectedValue > 0.005);
  const bestOption = positiveEV.length > 0 ? positiveEV[0] : null;

  // Check if conservative preference was applied (i.e., best option is conservative)
  const conservativeSelected = bestOption?.isConservative ?? false;

  return {
    bestOption,
    topOptions: positiveEV.slice(0, 5),
    windowSize,
    chiSquare: chi2,
    hasEdge: bestOption !== null && bestOption.edge > 0.015,
    multinomialProbs,
    markovProbs,
    lastDigit,
    conservativeSelected,
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
      data: {}, executionTimeMs: Date.now() - t0, digitResult: null,
    };
  }

  const result = analyzeDigitEdge(digitFeatures);
  const best = result.bestOption;

  let score = 0;
  let reasoning = "No positive-EV digit setup found.";

  if (best) {
    const evScore = Math.min(100, 50 + best.expectedValue * 400);
    const edgeScore = Math.min(100, 50 + best.edge * 500);
    const chi2Bonus = Math.min(10, result.chiSquare * 0.5);
    score = Math.round((evScore * 0.6 + edgeScore * 0.3 + chi2Bonus * 0.1));

    const conservativeNote = best.isConservative
      ? ` [CONSERVATIVE — preferred for stability]`
      : ` [HIGH-RISK barrier — only selected because EV is materially superior]`;

    reasoning = [
      `Best: ${best.contractType} barrier=${best.barrier}${conservativeNote}`,
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
      conservativeSelected: result.conservativeSelected,
    },
    executionTimeMs: Date.now() - t0,
    digitResult: result,
  };
}

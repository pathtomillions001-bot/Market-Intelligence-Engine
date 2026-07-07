/**
 * Agent 3: Digit Probability Engine
 *
 * RESPONSIBILITY: Full statistical analysis of the digit distribution.
 * Markov chain transition probabilities, Bayesian frequency estimation,
 * chi-square goodness-of-fit, streak/reversal analysis, and optimal
 * barrier selection for OVER/UNDER/EVEN/ODD contracts.
 *
 * This is an enhanced replacement for the original digit-agent.ts.
 */

import type { AgentOutput, ProductType, ScanContext } from "./types";
import { scoreToSignal } from "./types";

// ── Digit payout table (Deriv's actual payout schedule) ──────────────────────
// OVER 0/UNDER 9 = lowest risk = lowest payout
// OVER 8/UNDER 1 = highest risk = highest payout
export const DIGIT_PAYOUTS: Record<string, Record<number, number>> = {
  DIGITOVER: {
    0: 1.04, 1: 1.08, 2: 1.19, 3: 1.37, 4: 1.63,
    5: 1.96, 6: 2.45, 7: 3.27, 8: 4.90,
  },
  DIGITUNDER: {
    9: 1.04, 8: 1.08, 7: 1.19, 6: 1.37, 5: 1.63,
    4: 1.96, 3: 2.45, 2: 3.27, 1: 4.90,
  },
};

// Tier 1 = safest barriers; Tier 2 = medium-risk; Tier 3 = high risk
export const DIGIT_TIERS: Record<string, Record<number, number>> = {
  DIGITOVER:  { 0: 0, 1: 1, 2: 1, 3: 1, 4: 2, 5: 2, 6: 2, 7: 3, 8: 3 },
  DIGITUNDER: { 9: 0, 8: 1, 7: 1, 6: 1, 5: 2, 4: 2, 3: 2, 2: 3, 1: 3 },
};

export interface BarrierOption {
  contractType: ProductType;
  barrier: number;
  winProbability: number;
  payout: number;
  expectedValue: number;
  edge: number;
  tier: number;
  adjustedEvScore: number;
}

// ── Markov chain ───────────────────────────────────────────────────────────────

interface MarkovMatrix {
  transitions: number[][];  // 10×10 transition counts
  nextProb: number[];       // P(next digit = d | current digit)
}

function buildMarkov(digits: number[]): MarkovMatrix {
  const mat = Array.from({ length: 10 }, () => Array(10).fill(0));
  for (let i = 1; i < digits.length; i++) {
    const from = digits[i - 1];
    const to = digits[i];
    if (from >= 0 && from <= 9 && to >= 0 && to <= 9) mat[from][to]++;
  }

  const last = digits[digits.length - 1] ?? 5;
  const row = mat[last];
  const rowSum = row.reduce((a, b) => a + b, 0) || 10;
  const nextProb = row.map(v => v / rowSum);

  return { transitions: mat, nextProb };
}

// ── Chi-square test for uniform distribution ───────────────────────────────────

function chiSquareUniformP(digitCounts: number[]): number {
  const n = digitCounts.reduce((a, b) => a + b, 0);
  if (n === 0) return 1;
  const expected = n / 10;
  const chi2 = digitCounts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
  // Approximate p-value from chi2 with df=9 (Wilson-Hilferty approximation)
  const df = 9;
  const k = 2 / (9 * df);
  const z = (Math.pow(chi2 / df, 1 / 3) - (1 - k)) / Math.sqrt(k);
  // Abramowitz & Stegun erfc approximation (max error ≈ 1.5e-7) — Math.erfc is not in Node.js
  function erfc(x: number): number {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const result = poly * Math.exp(-x * x);
    return x >= 0 ? result : 2 - result;
  }
  const pValue = 0.5 * erfc(z / Math.sqrt(2));
  return Math.max(0, Math.min(1, pValue));
}

// ── Digit frequency analysis ───────────────────────────────────────────────────

export function analyzeDigits(digits: number[]): {
  frequency: number[];    // Frequency of each digit 0-9 (0-1)
  bayesianProb: number[]; // Smoothed Bayesian estimate
  evenProbability: number;
  oddProbability: number;
  markov: MarkovMatrix;
  chiSquarePValue: number;
  isUniform: boolean;
  hotDigits: number[];
  coldDigits: number[];
  lastDigit: number;
  recentStreakDigit: number;
  recentStreakLength: number;
} {
  const counts = Array(10).fill(0);
  for (const d of digits) if (d >= 0 && d <= 9) counts[d]++;
  const n = counts.reduce((a, b) => a + b, 0) || 1;

  // Raw frequency
  const frequency = counts.map(c => c / n);

  // Bayesian smoothing: Dirichlet prior with alpha=2 per digit (mild uniform prior)
  const alpha = 2;
  const bayesianProb = counts.map(c => (c + alpha) / (n + 10 * alpha));

  const evenProbability = [0, 2, 4, 6, 8].reduce((s, d) => s + bayesianProb[d], 0);
  const oddProbability = 1 - evenProbability;

  const markov = buildMarkov(digits);
  const chiSquarePValue = chiSquareUniformP(counts);
  const isUniform = chiSquarePValue > 0.05; // can't reject uniform

  const avgFreq = 0.1;
  const hotDigits = frequency.map((f, i) => ({ d: i, f })).filter(x => x.f > avgFreq * 1.15).map(x => x.d);
  const coldDigits = frequency.map((f, i) => ({ d: i, f })).filter(x => x.f < avgFreq * 0.85).map(x => x.d);

  // Recent streak
  const lastDigit = digits[digits.length - 1] ?? -1;
  let streakLen = 0;
  let streakDigit = lastDigit;
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] === lastDigit) streakLen++;
    else { streakDigit = digits[i + 1] ?? lastDigit; break; }
  }

  return {
    frequency, bayesianProb, evenProbability, oddProbability,
    markov, chiSquarePValue, isUniform,
    hotDigits, coldDigits,
    lastDigit, recentStreakDigit: streakDigit, recentStreakLength: streakLen,
  };
}

// ── Theoretical (random) win probability for any barrier ──────────────────────
// This is the house's long-run expectation under a uniform digit distribution.
// OVER N wins when last digit > N  → (9 - N) / 10 winning digits
// UNDER N wins when last digit < N → N / 10 winning digits
// Used as the baseline for relative-favorability scoring.

export function theoreticalWinP(contractType: "DIGITOVER" | "DIGITUNDER", barrier: number): number {
  if (contractType === "DIGITOVER") return Math.max(0, (9 - barrier) / 10);
  return Math.max(0, barrier / 10);
}

// Validate a user-specified barrier. Returns an error string when invalid.
// Invalid: DIGITOVER 9 (0 digits > 9, can never win)
//          DIGITUNDER 0 (0 digits < 0, can never win)
export function validateBarrier(contractType: "DIGITOVER" | "DIGITUNDER", barrier: number): string | null {
  if (!Number.isInteger(barrier)) return `Barrier must be a whole number, got ${barrier}`;
  if (contractType === "DIGITOVER") {
    if (barrier < 0 || barrier > 8) return `DIGITOVER barrier must be 0–8; got ${barrier}. (OVER 9 is impossible — no digit exceeds 9.)`;
  } else {
    if (barrier < 1 || barrier > 9) return `DIGITUNDER barrier must be 1–9; got ${barrier}. (UNDER 0 is impossible — no digit is below 0.)`;
  }
  return null;
}

// ── Win probability for barriers using Markov + Bayesian ensemble ─────────────

function winProbForBarrier(
  contractType: "DIGITOVER" | "DIGITUNDER",
  barrier: number,
  analysis: ReturnType<typeof analyzeDigits>,
): number {
  // Bayesian base probability
  let bayesianWinP = 0;
  if (contractType === "DIGITOVER") {
    for (let d = barrier + 1; d <= 9; d++) bayesianWinP += analysis.bayesianProb[d];
  } else {
    for (let d = 0; d < barrier; d++) bayesianWinP += analysis.bayesianProb[d];
  }

  // Markov adjustment: use the next-digit distribution from Markov chain
  let markovWinP = 0;
  if (contractType === "DIGITOVER") {
    for (let d = barrier + 1; d <= 9; d++) markovWinP += analysis.markov.nextProb[d];
  } else {
    for (let d = 0; d < barrier; d++) markovWinP += analysis.markov.nextProb[d];
  }

  // Ensemble: 70% Bayesian, 30% Markov
  return bayesianWinP * 0.7 + markovWinP * 0.3;
}

// ── Barrier option builder ─────────────────────────────────────────────────────
//
// USER-CONFIGURED BARRIER POLICY:
//   Always trade EXACTLY the barrier the user configured in Settings.
//   For normal mode: normalOverDigit / normalUnderDigit.
//   For recovery mode: recoveryOverDigit / recoveryUnderDigit.
//
// Invalid barriers (OVER 9, UNDER 0) are rejected — they can never win.
// The AI does NOT pick a "better" barrier; it analyses market conditions
// to find the optimal TIMING to enter the user's chosen barrier.
//
// Scoring is RELATIVE-FAVORABILITY based:
//   theoreticalWinP  = long-run uniform-distribution probability for this barrier
//   actualWinP       = Bayesian + Markov ensemble from live digit buffer
//   relativeEdge     = actualWinP − theoreticalWinP
//   score            = 50 + relativeEdge × 400   (clamped 10–95)
//
// This means a score of 50 = neutral (market is at the statistical baseline for
// this barrier), > 50 = currently favourable, < 50 = currently unfavourable.
// The engine will wait until the score clears the confidence threshold before
// executing, so the AI always looks for the best moment to trade the user's digit.

const DEFAULT_BARRIERS: Record<"DIGITOVER" | "DIGITUNDER", number> = {
  DIGITOVER:  2,
  DIGITUNDER: 7,
};

function buildBarrierOptions(
  analysis: ReturnType<typeof analyzeDigits>,
  allowedBarriers: Record<"DIGITOVER" | "DIGITUNDER", number> = DEFAULT_BARRIERS,
): BarrierOption[] {
  const options: BarrierOption[] = [];

  for (const [ct, payoutMap] of Object.entries(DIGIT_PAYOUTS)) {
    const contractType = ct as "DIGITOVER" | "DIGITUNDER";
    const barrier = allowedBarriers[contractType];

    // Reject invalid barriers before touching any analysis
    const validationError = validateBarrier(contractType, barrier);
    if (validationError) {
      // Skip this contract type — the engine will see an empty barrierOptions
      // and score 50 (neutral), effectively pausing until settings are corrected.
      continue;
    }

    const payout = payoutMap[barrier as keyof typeof payoutMap];
    if (!payout) continue; // barrier not in payout table (shouldn't happen after validation)

    const winP = winProbForBarrier(contractType, barrier, analysis);
    const ev   = winP * (payout - 1) - (1 - winP);
    const edge = winP - (1 / payout);
    const tier = DIGIT_TIERS[contractType]?.[barrier] ?? 2;

    // Relative favorability: how much better (or worse) is the current market
    // probability vs the long-run theoretical probability for this barrier.
    const baselineWinP    = theoreticalWinP(contractType, barrier);
    const relativeEdge    = winP - baselineWinP;  // positive = favourable conditions
    // adjustedEvScore is used for ranking when both OVER and UNDER are analysed;
    // use relative edge so both can score fairly regardless of payout tier.
    const adjustedEvScore = relativeEdge;

    options.push({ contractType, barrier, winProbability: winP, payout, expectedValue: ev, edge, tier, adjustedEvScore });
  }

  return options;
}

// ── Even/Odd analysis ──────────────────────────────────────────────────────────

export function analyzeEvenOdd(digits: number[]): {
  evenProb: number;
  oddProb: number;
  markovEvenGivenEven: number;
  markovEvenGivenOdd: number;
  markovNextEvenProb: number;
  streakReversalSignal: boolean;
  recommendation: "even" | "odd" | "none";
} {
  if (digits.length < 10) {
    return {
      evenProb: 0.5, oddProb: 0.5,
      markovEvenGivenEven: 0.5, markovEvenGivenOdd: 0.5,
      markovNextEvenProb: 0.5,
      streakReversalSignal: false,
      recommendation: "none",
    };
  }

  const analysis = analyzeDigits(digits);
  const evenProb = analysis.evenProbability;

  // Markov E/O transitions
  const isEven = (d: number) => d % 2 === 0;
  let eeCount = 0, eoCount = 0, oeCount = 0, ooCount = 0;
  for (let i = 1; i < digits.length; i++) {
    const prev = isEven(digits[i - 1]);
    const curr = isEven(digits[i]);
    if (prev && curr) eeCount++;
    else if (prev && !curr) eoCount++;
    else if (!prev && curr) oeCount++;
    else ooCount++;
  }

  const eTotal = eeCount + eoCount || 1;
  const oTotal = oeCount + ooCount || 1;
  const markovEvenGivenEven = eeCount / eTotal;
  const markovEvenGivenOdd = oeCount / oTotal;

  const lastIsEven = isEven(digits[digits.length - 1] ?? 1);
  const markovNextEvenProb = lastIsEven ? markovEvenGivenEven : markovEvenGivenOdd;

  // Streak reversal signal: if the last 3 digits are all even or all odd
  const last3 = digits.slice(-3).map(isEven);
  const streakReversalSignal = (last3.every(Boolean) || last3.every(v => !v));

  // Need at least 2 corroborating signals AND a minimum probability edge to trade.
  // Thresholds raised from 0.52 → 0.54 to reduce false positives on near-50/50 markets.
  let signals = 0;
  const signalForEven = evenProb > 0.54 ? 1 : evenProb < 0.46 ? -1 : 0;
  const markovSignal = markovNextEvenProb > 0.54 ? 1 : markovNextEvenProb < 0.46 ? -1 : 0;
  const reversalSignal = streakReversalSignal ? (lastIsEven ? -1 : 1) : 0; // expect reversal
  signals = signalForEven + markovSignal + reversalSignal;

  // Additional guard: the dominant probability must show clear edge (> 0.54) for both
  // the Bayesian estimate AND the Markov estimate to agree. If they disagree, skip.
  const bayesMarkovAgree = (evenProb > 0.54 && markovNextEvenProb > 0.50) ||
                           (evenProb < 0.46 && markovNextEvenProb < 0.50);

  const recommendation: "even" | "odd" | "none" = (Math.abs(signals) < 2 || !bayesMarkovAgree) ? "none"
    : signals > 0 ? "even" : "odd";

  return {
    evenProb, oddProb: 1 - evenProb,
    markovEvenGivenEven, markovEvenGivenOdd, markovNextEvenProb,
    streakReversalSignal, recommendation,
  };
}

// ── Agent runner ───────────────────────────────────────────────────────────────

export interface DigitProbabilityOutput extends AgentOutput {
  barrierOptions: BarrierOption[];
  evenAnalysis: ReturnType<typeof analyzeEvenOdd>;
  bestBarrier: BarrierOption | null;
  frequency: number[];
  hotDigits: number[];
  coldDigits: number[];
  isUniform: boolean;
  evenProbability: number;
  chiSquarePValue: number;
}

export function runDigitProbabilityAgent(ctx: ScanContext): DigitProbabilityOutput {
  const t0 = Date.now();
  const digits = ctx.digits;

  if (digits.length < 10) {
    return {
      agentId: "digitProbability", score: 50, confidence: 0, signal: "hold",
      reasoning: `Insufficient digit data (${digits.length} samples — need ≥30).`,
      data: {}, executionTimeMs: Date.now() - t0,
      barrierOptions: [], evenAnalysis: analyzeEvenOdd([]),
      bestBarrier: null, frequency: Array(10).fill(0.1),
      hotDigits: [], coldDigits: [], isUniform: true,
      evenProbability: 0.5, chiSquarePValue: 1,
    };
  }

  const analysis = analyzeDigits(digits);
  const barrierOptions = buildBarrierOptions(analysis, ctx.recoveryBarrierOverride);
  const evenAnalysis = analyzeEvenOdd(digits);

  // Sort by relative edge (best conditions for user's chosen barrier first)
  const sorted = [...barrierOptions].sort((a, b) => b.adjustedEvScore - a.adjustedEvScore);
  const bestBarrier = sorted[0] ?? null;

  // ── Relative-favorability scoring ─────────────────────────────────────────
  // Score = 50 + (actualWinP − theoreticalWinP) × 400, scaled by data quality.
  //
  // Why relative rather than absolute edge:
  //   The user explicitly chose their barrier (e.g. OVER 4). The AI's job is to
  //   find the best TIMING to trade it, not to second-guess the choice. Absolute
  //   edge is always negative for mid-range barriers (the house edge), which used
  //   to make the score collapse to ~16 even during perfectly neutral conditions,
  //   so the engine would never fire.
  //
  //   Relative edge compares today's actual probability to the barrier's baseline
  //   (what you'd expect from a uniform distribution). A score > 50 means current
  //   market conditions are more favourable than average for this barrier.
  const dataSufficiency = Math.min(1, digits.length / 100);

  let score: number;
  if (!bestBarrier) {
    // No valid barrier configured (e.g. user set OVER 9 — impossible win).
    // Score 30 so the trade is rejected but the engine doesn't hard-block.
    score = 30;
  } else {
    const baselineWinP = theoreticalWinP(bestBarrier.contractType, bestBarrier.barrier);
    const relativeEdge = bestBarrier.winProbability - baselineWinP;

    // 400 sensitivity: +0.10 above baseline → score 90, −0.10 → score 10.
    const relativeScore = Math.round(50 + relativeEdge * 400);

    // Hot/cold digit bonus: if the winning digits for this barrier are currently
    // "hot" (appearing more than 15% above average), add a small boost.
    // Must enumerate ALL winning digits, not just a fixed window of 5:
    //   OVER N wins when digit > N  → digits N+1 … 9 (up to 9 digits for OVER 0)
    //   UNDER N wins when digit < N → digits 0 … N-1 (up to 9 digits for UNDER 9)
    const ct = bestBarrier.contractType as "DIGITOVER" | "DIGITUNDER";
    const winningDigits: number[] = ct === "DIGITOVER"
      ? Array.from({ length: 9 - bestBarrier.barrier }, (_, i) => bestBarrier.barrier + 1 + i)
      : Array.from({ length: bestBarrier.barrier }, (_, i) => i);
    const hotBonus = winningDigits.filter(d => analysis.hotDigits.includes(d)).length * 2;
    const coldPenalty = winningDigits.filter(d => analysis.coldDigits.includes(d)).length * 2;

    // Blend: relative score (primary) + data quality dampener + hot/cold nudge
    const rawScore = relativeScore + hotBonus - coldPenalty;
    score = Math.round(rawScore * dataSufficiency + 50 * (1 - dataSufficiency));
  }

  const isUniform = analysis.isUniform;

  const reasoning = [
    `${digits.length} digits. Chi-sq p=${analysis.chiSquarePValue.toFixed(3)} (${isUniform ? "uniform" : "skewed"}).`,
    `Hot: [${analysis.hotDigits.join(",")}]. Cold: [${analysis.coldDigits.join(",")}].`,
    bestBarrier
      ? (() => {
          const bct = bestBarrier.contractType as "DIGITOVER" | "DIGITUNDER";
          const baseline = theoreticalWinP(bct, bestBarrier.barrier);
          const rel = ((bestBarrier.winProbability - baseline) * 100).toFixed(1);
          return `User barrier: ${bestBarrier.contractType} ${bestBarrier.barrier} | P(win)=${(bestBarrier.winProbability * 100).toFixed(1)}% (baseline ${(baseline * 100).toFixed(0)}%, ${Number(rel) >= 0 ? "+" : ""}${rel}pp) | EV=${(bestBarrier.expectedValue * 100).toFixed(1)}%.`;
        })()
      : "No valid barrier — check settings (OVER must be 0–8, UNDER must be 1–9).",
    `Even prob: ${(analysis.evenProbability * 100).toFixed(1)}% | Markov recommendation: ${evenAnalysis.recommendation}.`,
  ].join(" ");

  return {
    agentId: "digitProbability",
    score: Math.min(95, Math.max(10, score)),
    confidence: Math.round(dataSufficiency * 90),
    signal: scoreToSignal(score),
    reasoning,
    data: {
      bestBarrier,
      hotDigits: analysis.hotDigits,
      coldDigits: analysis.coldDigits,
      isUniform,
      evenProbability: analysis.evenProbability,
      chiSquarePValue: analysis.chiSquarePValue,
    },
    executionTimeMs: Date.now() - t0,
    barrierOptions,
    evenAnalysis,
    bestBarrier,
    frequency: analysis.frequency,
    hotDigits: analysis.hotDigits,
    coldDigits: analysis.coldDigits,
    isUniform,
    evenProbability: analysis.evenProbability,
    chiSquarePValue: analysis.chiSquarePValue,
  };
}

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
// DIGITMATCH barrier 0-9: ~9.00× (10% theoretical win rate)
// DIGITDIFF  barrier 0-9: ~1.04× (90% theoretical win rate)
export const DIGIT_PAYOUTS: Record<string, Record<number, number>> = {
  DIGITOVER: {
    0: 1.04, 1: 1.08, 2: 1.19, 3: 1.37, 4: 1.63,
    5: 1.96, 6: 2.45, 7: 3.27, 8: 4.90,
  },
  DIGITUNDER: {
    9: 1.04, 8: 1.08, 7: 1.19, 6: 1.37, 5: 1.63,
    4: 1.96, 3: 2.45, 2: 3.27, 1: 4.90,
  },
  DIGITMATCH: {
    0: 9.00, 1: 9.00, 2: 9.00, 3: 9.00, 4: 9.00,
    5: 9.00, 6: 9.00, 7: 9.00, 8: 9.00, 9: 9.00,
  },
  DIGITDIFF: {
    0: 1.04, 1: 1.04, 2: 1.04, 3: 1.04, 4: 1.04,
    5: 1.04, 6: 1.04, 7: 1.04, 8: 1.04, 9: 1.04,
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
// STRICT BARRIER POLICY:
//   Always → ONLY OVER 2  and UNDER 7  (safe, consistent barriers)
//
// All other barriers are excluded regardless of edge or EV score.

const ALLOWED_BARRIERS: Record<"DIGITOVER" | "DIGITUNDER", number> = {
  DIGITOVER:  2,
  DIGITUNDER: 7,
};

function buildBarrierOptions(
  analysis: ReturnType<typeof analyzeDigits>,
  allowedBarriers: Record<"DIGITOVER" | "DIGITUNDER", number> = ALLOWED_BARRIERS,
): BarrierOption[] {
  const options: BarrierOption[] = [];

  for (const [ct, payoutMap] of Object.entries(DIGIT_PAYOUTS)) {
    const contractType = ct as "DIGITOVER" | "DIGITUNDER";

    for (const [bStr, payout] of Object.entries(payoutMap)) {
      const barrier = Number(bStr);

      // STRICT: only allow the one permitted barrier — OVER 2 / UNDER 7 normally,
      // or OVER 4 / UNDER 5 while this family is in Recovery Mode.
      if (barrier !== allowedBarriers[contractType]) continue;

      const winP = winProbForBarrier(contractType, barrier, analysis);
      const ev = winP * (payout - 1) - (1 - winP);
      const edge = winP - (1 / payout);
      const tier = DIGIT_TIERS[contractType]?.[barrier] ?? 2;
      const adjustedEvScore = edge > 0 ? ev * 10 : ev;

      options.push({ contractType, barrier, winProbability: winP, payout, expectedValue: ev, edge, tier, adjustedEvScore });
    }
  }

  return options;
}

// ── Matches / Differs analysis ────────────────────────────────────────────────
//
// DIGITMATCH: win if last digit = chosen digit. Best choice: the "hot" digit
//   (highest frequency). Positive EV when that digit's frequency > 1/payout = ~11.1%.
//
// DIGITDIFF:  win if last digit ≠ chosen digit. Best choice: the "hot" digit
//   (differ from the most frequent one gives LOWEST win rate — actually we want
//   to differ from the COLDEST digit so we almost always win). EV positive when
//   frequency of chosen digit < (1 - 1/1.04) = ~3.8%.
//
// The agent returns the best match digit and best diff digit along with their
// estimated win probabilities.

export interface MatchDiffersAnalysis {
  // DIGITMATCH: pick the digit predicted most likely to appear next
  matchDigit: number;           // 0-9: best digit to match
  matchWinProbability: number;  // estimated P(last digit = matchDigit)
  matchExpectedValue: number;   // EV per $1 stake
  matchEdge: number;            // winP - 1/payout
  matchRecommended: boolean;    // true if EV > 0

  // DIGITDIFF: pick the digit predicted least likely to appear next
  diffDigit: number;            // 0-9: best digit to differ from
  diffWinProbability: number;   // estimated P(last digit ≠ diffDigit)
  diffExpectedValue: number;    // EV per $1 stake
  diffEdge: number;             // winP - 1/payout
  diffRecommended: boolean;     // true if EV > 0
}

export function analyzeMatchDiffers(
  digits: number[],
  analysis: ReturnType<typeof analyzeDigits>,
): MatchDiffersAnalysis {
  const MATCH_PAYOUT = 9.00;
  const DIFF_PAYOUT  = 1.04;

  // For DIGITMATCH: use ensemble of Bayesian + Markov next-digit probability
  const ensembleProb = analysis.bayesianProb.map((bayP, d) => {
    const markovP = analysis.markov.nextProb[d] ?? 0.1;
    return bayP * 0.7 + markovP * 0.3;
  });

  // Best DIGITMATCH: digit with highest ensemble probability
  let matchDigit = 0;
  let matchWinP = 0;
  for (let d = 0; d <= 9; d++) {
    if (ensembleProb[d] > matchWinP) { matchWinP = ensembleProb[d]; matchDigit = d; }
  }
  const matchEV   = matchWinP * (MATCH_PAYOUT - 1) - (1 - matchWinP);
  const matchEdge = matchWinP - 1 / MATCH_PAYOUT;

  // Best DIGITDIFF: differ from the digit with the LOWEST ensemble probability
  // (we are predicting "not that digit", so pick the rarest one to differ from
  // so that P(win) = 1 - P(rarest digit) is maximised).
  let diffDigit = 0;
  let diffTargetP = 1;   // probability of the digit we'll differ FROM (want this LOW)
  for (let d = 0; d <= 9; d++) {
    if (ensembleProb[d] < diffTargetP) { diffTargetP = ensembleProb[d]; diffDigit = d; }
  }
  const diffWinP  = 1 - diffTargetP;
  const diffEV    = diffWinP * (DIFF_PAYOUT - 1) - (1 - diffWinP);
  const diffEdge  = diffWinP - 1 / DIFF_PAYOUT;

  return {
    matchDigit, matchWinProbability: matchWinP,
    matchExpectedValue: matchEV, matchEdge,
    // matchRecommended: allow slightly-negative EV so the option enters the coordinator's
    // barrier list; master-decision.ts applies the real hard gate (expectedValue > 0 strictly).
    // This lets the option be EVALUATED — not necessarily traded.
    matchRecommended: matchEV > -0.03 && digits.length >= 30,
    diffDigit, diffWinProbability: diffWinP,
    diffExpectedValue: diffEV, diffEdge,
    // diffRecommended: gate on edge (not EV) with -4% slack — a win rate of ~92%+ is worth
    // evaluating; master-decision.ts gates at edge > 0 (win > 96.15%) before any trade fires.
    diffRecommended: diffEdge > -0.04 && digits.length >= 30,
  };
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
  matchDiffersAnalysis: MatchDiffersAnalysis | null;
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
      matchDiffersAnalysis: null,
      bestBarrier: null, frequency: Array(10).fill(0.1),
      hotDigits: [], coldDigits: [], isUniform: true,
      evenProbability: 0.5, chiSquarePValue: 1,
    };
  }

  const analysis = analyzeDigits(digits);
  const barrierOptions = buildBarrierOptions(analysis, ctx.recoveryBarrierOverride);
  const evenAnalysis = analyzeEvenOdd(digits);
  const matchDiffersAnalysis = analyzeMatchDiffers(digits, analysis);

  // Sort by adjustedEvScore
  const sorted = [...barrierOptions].sort((a, b) => b.adjustedEvScore - a.adjustedEvScore);
  const bestBarrier = sorted[0] ?? null;

  // Score based on best barrier edge and data quality
  const dataSufficiency = Math.min(1, digits.length / 100);
  const edgeScore = bestBarrier
    ? Math.min(95, Math.round(50 + bestBarrier.edge * 300))
    : 50;
  let score = Math.round(edgeScore * dataSufficiency + 50 * (1 - dataSufficiency));

  // During a loss streak, penalise zero or negative edge strongly.
  // The AI should never repeat a trade with no statistical edge after consecutive losses.
  const sessionLosses = ctx.daily.consecutiveLosses;
  if (sessionLosses >= 2 && bestBarrier) {
    if (bestBarrier.edge <= 0) {
      // No edge at all — strong penalty: effectively blocks this barrier in recovery
      score = Math.max(10, score - 20);
    } else if (sessionLosses >= 3 && bestBarrier.edge < 0.02) {
      // Weak edge during a deeper streak — require at least 2% edge
      score = Math.max(10, score - 12);
    }
  }

  const isUniform = analysis.isUniform;

  const reasoning = [
    `${digits.length} digits. Chi-sq p=${analysis.chiSquarePValue.toFixed(3)} (${isUniform ? "uniform" : "skewed"}).`,
    `Hot: [${analysis.hotDigits.join(",")}]. Cold: [${analysis.coldDigits.join(",")}].`,
    bestBarrier
      ? `Best barrier: ${bestBarrier.contractType} ${bestBarrier.barrier} | P(win)=${(bestBarrier.winProbability * 100).toFixed(1)}% | EV=${(bestBarrier.expectedValue * 100).toFixed(1)}%.`
      : "No suitable barrier found.",
    `Even prob: ${(analysis.evenProbability * 100).toFixed(1)}% | Markov recommendation: ${evenAnalysis.recommendation}.`,
    matchDiffersAnalysis.matchRecommended
      ? `MATCH digit=${matchDiffersAnalysis.matchDigit} P=${(matchDiffersAnalysis.matchWinProbability * 100).toFixed(1)}%.`
      : "",
    matchDiffersAnalysis.diffRecommended
      ? `DIFF digit=${matchDiffersAnalysis.diffDigit} P(win)=${(matchDiffersAnalysis.diffWinProbability * 100).toFixed(1)}%.`
      : "",
  ].filter(Boolean).join(" ");

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
      matchDiffersAnalysis,
    },
    executionTimeMs: Date.now() - t0,
    barrierOptions,
    evenAnalysis,
    matchDiffersAnalysis,
    bestBarrier,
    frequency: analysis.frequency,
    hotDigits: analysis.hotDigits,
    coldDigits: analysis.coldDigits,
    isUniform,
    evenProbability: analysis.evenProbability,
    chiSquarePValue: analysis.chiSquarePValue,
  };
}

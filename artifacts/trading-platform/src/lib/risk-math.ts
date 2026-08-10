// ── Risk Calculator Math ──────────────────────────────────────────────────────
// Pure functions — no React, no side effects.
// Sources: digit-probability.ts (payout tables), ev-calculator.ts (EV formulas)

export type ContractType =
  | "CALL" | "PUT"
  | "DIGITOVER" | "DIGITUNDER"
  | "DIGITEVEN" | "DIGITODD"
  | "DIGITMATCH" | "DIGITDIFF";

// Barrier-specific payouts — from api-server/lib/agents/digit-probability.ts
export const OVER_PAYOUTS: Record<number, number> = {
  0: 1.04, 1: 1.08, 2: 1.19, 3: 1.37, 4: 1.63,
  5: 1.96, 6: 2.45, 7: 3.27, 8: 4.90,
};
export const UNDER_PAYOUTS: Record<number, number> = {
  9: 1.04, 8: 1.08, 7: 1.19, 6: 1.37, 5: 1.63,
  4: 1.96, 3: 2.45, 2: 3.27, 1: 4.90,
};

export function getPayout(type: ContractType, barrier?: number): number {
  switch (type) {
    case "CALL": case "PUT":            return 1.91;
    case "DIGITEVEN": case "DIGITODD":  return 1.95;
    case "DIGITMATCH":                  return 9.00;
    case "DIGITDIFF":                   return 1.04;
    case "DIGITOVER":   return OVER_PAYOUTS[barrier ?? 5]  ?? 1.96;
    case "DIGITUNDER":  return UNDER_PAYOUTS[barrier ?? 4] ?? 1.96;
    default:                            return 1.91;
  }
}

// Theoretical win probability assuming uniform digit distribution [0–9]
export function getWinProb(type: ContractType, barrier?: number): number {
  switch (type) {
    case "CALL": case "PUT":            return 0.50;
    case "DIGITEVEN": case "DIGITODD":  return 0.50;
    case "DIGITMATCH":                  return 0.10;
    case "DIGITDIFF":                   return 0.90;
    case "DIGITOVER":  return (9 - (barrier ?? 5)) / 10;   // P(digit > barrier)
    case "DIGITUNDER": return (barrier ?? 4) / 10;          // P(digit < barrier)
    default:                            return 0.50;
  }
}

// ── Instant Recovery Ladder ───────────────────────────────────────────────────
// Each recovery stake = totalDebt / (recoveryPayout - 1)
// so that a single win recoups all losses and earns +baseStake profit.
export function buildInstantLadder(
  base: number,
  recoveryPayout: number,
  maxLosses: number,
): number[] {
  const edge = recoveryPayout - 1;
  if (edge <= 0) return Array(maxLosses).fill(base);
  const ladder: number[] = [base];
  for (let i = 1; i < maxLosses; i++) {
    const debt = ladder.reduce((a, b) => a + b, 0);
    ladder.push(Math.max(debt / edge, 0.35)); // Deriv minimum stake $0.35
  }
  return ladder;
}

// ── Split Recovery Ladder ─────────────────────────────────────────────────────
// Progressive cap: step N = base × (multiplier + N - 1)
export function buildSplitLadder(
  base: number,
  multiplier: number,
  maxLosses: number,
): number[] {
  return Array.from({ length: maxLosses }, (_, i) =>
    parseFloat((base * (multiplier + i)).toFixed(2)),
  );
}

// ── Streak Probability (exact DP) ─────────────────────────────────────────────
// P(at least one run of `streak` consecutive losses in `trades` Bernoulli trials)
// Time: O(trades × streak) — safe for trades ≤ 200, streak ≤ 15
export function streakProb(winP: number, streak: number, trades: number): number {
  if (streak <= 0 || trades <= 0) return 0;
  if (winP >= 1) return 0;
  if (winP <= 0) return 1;

  const lossP = 1 - winP;
  // dp[k] = prob of being at k consecutive losses WITHOUT having hit `streak`
  let dp = new Float64Array(streak);
  dp[0] = 1; // start

  for (let t = 0; t < trades; t++) {
    const next = new Float64Array(streak);
    for (let k = 0; k < streak; k++) {
      if (dp[k] === 0) continue;
      // win → reset to 0 consecutive losses
      next[0] += dp[k] * winP;
      // lose → increment streak counter (if still < streak)
      if (k + 1 < streak) next[k + 1] += dp[k] * lossP;
      // else → bad streak occurred; probability escapes the DP (not added back)
    }
    dp = next;
  }

  const pNoStreak = dp.reduce((a, b) => a + b, 0);
  return Math.min(1, Math.max(0, 1 - pNoStreak));
}

// ── Suggested Stake ───────────────────────────────────────────────────────────
// Three constraints are computed independently and the tightest wins:
//
// 1. SL constraint   — full recovery ladder × 1.1 uses ≤ 60 % of the SL budget.
//    Using 60 % (not 100 %) leaves room for multiple failed recovery attempts
//    and back-to-back bad sessions.
//
// 2. TP constraint   — stake is large enough to reach the daily TP target in a
//    realistic session of (max(30, maxLosses × 4)) trades.
//
// 3. Balance cap     — max 1 % of balance per base trade.  Industry-standard
//    conservative ceiling for binary / digit contracts.
//
// All three are combined with Math.min; floor is Deriv's $0.35 minimum.

// Internal: binary-search for the largest base stake whose ladder sums to ≤ targetCost.
function maxStakeForLadderCost(
  targetCost: number,
  recoveryMethod: "instant" | "split",
  recoveryPayout: number,
  recoveryMultiplier: number,
  maxLosses: number,
): number {
  let lo = 0.35, hi = Math.max(targetCost * 2, 1);
  for (let i = 0; i < 64; i++) {
    const mid = (lo + hi) / 2;
    const ladder =
      recoveryMethod === "instant"
        ? buildInstantLadder(mid, recoveryPayout, maxLosses)
        : buildSplitLadder(mid, recoveryMultiplier, maxLosses);
    const cost = ladder.reduce((a, b) => a + b, 0);
    if (cost <= targetCost) lo = mid;
    else hi = mid;
  }
  return Math.max(0.35, lo);
}

export function calcSuggestedStake(
  balance: number,
  targetSLFraction: number,       // e.g. 0.30
  recoveryMethod: "instant" | "split",
  recoveryPayout: number,
  recoveryMultiplier: number,
  maxLosses: number,
  primaryPayout: number,          // e.g. 1.04 for DIGITDIFF
  primaryWinProb: number,         // e.g. 0.90 for DIGITDIFF
  targetTPFraction: number,       // e.g. 0.10
): number {
  if (balance <= 0) return 0.35;

  // ── Constraint 1: SL-based maximum ────────────────────────────────────────
  // Use 60 % of SL budget so there is headroom for multiple recovery failures.
  const slCostTarget = (targetSLFraction * balance * 0.6) / 1.1;
  const maxFromSL = maxStakeForLadderCost(
    slCostTarget, recoveryMethod, recoveryPayout, recoveryMultiplier, maxLosses,
  );

  // ── Constraint 2: TP-driven stake ─────────────────────────────────────────
  // How large does the stake need to be to reach the TP in a practical session?
  // Session = max(30, maxLosses × 4) trades; expected wins at primaryWinProb.
  const sessionTrades  = Math.max(30, maxLosses * 4);
  const expectedWins   = sessionTrades * primaryWinProb;
  const profitPerUnit  = Math.max(primaryPayout - 1, 0.001); // avoid ÷0
  const stakeFromTP    = (balance * targetTPFraction) / (expectedWins * profitPerUnit);

  // ── Constraint 3: Balance cap (1 % per trade) ──────────────────────────────
  const maxFromBalance = balance * 0.01;

  const result = Math.min(maxFromSL, stakeFromTP, maxFromBalance);
  return Math.max(0.35, parseFloat(result.toFixed(2)));
}

// ── Suggested-stake breakdown (which constraint binds) ───────────────────────
// Exposes the three independent constraints that feed calcSuggestedStake so the
// UI can tell the user WHY a stake was chosen — the binding constraint drives
// the recommendation.
export interface StakeBreakdown {
  slCap: number;        // max stake the stop-loss budget allows
  tpDriven: number;     // stake needed to reach TP in a realistic session
  balanceCap: number;   // 1 % of balance ceiling
  suggested: number;
  binding: "stop-loss" | "take-profit" | "balance-cap" | "minimum";
}

export function suggestedStakeBreakdown(
  balance: number,
  targetSLFraction: number,
  recoveryMethod: "instant" | "split",
  recoveryPayout: number,
  recoveryMultiplier: number,
  maxLosses: number,
  primaryPayout: number,
  primaryWinProb: number,
  targetTPFraction: number,
): StakeBreakdown {
  if (balance <= 0) {
    return { slCap: 0.35, tpDriven: 0.35, balanceCap: 0.35, suggested: 0.35, binding: "minimum" };
  }
  const slCostTarget = (targetSLFraction * balance * 0.6) / 1.1;
  const slCap = maxStakeForLadderCost(slCostTarget, recoveryMethod, recoveryPayout, recoveryMultiplier, maxLosses);
  const sessionTrades = Math.max(30, maxLosses * 4);
  const expectedWins = sessionTrades * primaryWinProb;
  const profitPerUnit = Math.max(primaryPayout - 1, 0.001);
  const tpDriven = (balance * targetTPFraction) / (expectedWins * profitPerUnit);
  const balanceCap = balance * 0.01;

  const candidates: Array<[number, StakeBreakdown["binding"]]> = [
    [slCap, "stop-loss"],
    [tpDriven, "take-profit"],
    [balanceCap, "balance-cap"],
  ];
  candidates.sort((a, b) => a[0] - b[0]);
  const raw = candidates[0][0];
  const suggested = Math.max(0.35, parseFloat(raw.toFixed(2)));
  const binding: StakeBreakdown["binding"] =
    suggested <= 0.35 + 1e-9 ? "minimum" : candidates[0][1];

  return { slCap, tpDriven, balanceCap, suggested, binding };
}

// ── Main Calculation ──────────────────────────────────────────────────────────
export interface RiskResult {
  ladder: number[];
  totalLadderCost: number;
  recommendedSL: number;
  recommendedTP: number;
  riskScore: number;            // 0-100; higher = safer
  riskLabel: "SAFE" | "MODERATE" | "RISKY" | "EXTREME";
  riskColor: string;
  streakProbSession: number;    // P(bad streak in tradesPerSession)
  streakProb50: number;         // P(bad streak in 50 trades)
  balanceCoverage: number;      // how many full ladders balance can fund
  evPerTrade: number;
  breakevenWinRate: number;
  netAfterRecovery: number;     // P&L after one complete win-recovery cycle
  warnings: string[];
}

export function calcRisk(p: {
  baseStake: number;
  balance: number;
  primaryPayout: number;
  primaryWinProb: number;
  recoveryPayout: number;
  maxLosses: number;
  recoveryMethod: "instant" | "split";
  recoveryMultiplier: number;
  tradesPerSession: number;
}): RiskResult {
  const {
    baseStake, balance,
    primaryPayout, primaryWinProb,
    recoveryPayout, maxLosses,
    recoveryMethod, recoveryMultiplier,
    tradesPerSession,
  } = p;

  const ladder =
    recoveryMethod === "instant"
      ? buildInstantLadder(baseStake, recoveryPayout, maxLosses)
      : buildSplitLadder(baseStake, recoveryMultiplier, maxLosses);

  const totalLadderCost = ladder.reduce((a, b) => a + b, 0);

  // ─ SL: cost of one full losing streak + 10 % buffer ─
  const recommendedSL = parseFloat((totalLadderCost * 1.1).toFixed(2));

  // ─ TP: enough base-stake wins to feel meaningful ─
  // After surviving maxLosses consecutive losses (worst case), user needs
  // maxLosses × 2 consecutive base wins to feel the day was worthwhile.
  const profitPerBaseWin = baseStake * (primaryPayout - 1);
  const recommendedTP = parseFloat((profitPerBaseWin * maxLosses * 2).toFixed(2));

  // ─ Streak probabilities ─
  const streakProbSession = streakProb(primaryWinProb, maxLosses, tradesPerSession);
  const sp50             = streakProb(primaryWinProb, maxLosses, 50);

  // ─ Balance coverage ─
  const balanceCoverage = totalLadderCost > 0 ? balance / totalLadderCost : Infinity;

  // ─ EV & breakeven ─
  const evPerTrade     = primaryWinProb * (primaryPayout - 1) - (1 - primaryWinProb);
  const breakevenWinRate = 1 / primaryPayout;

  // ─ Net profit after one complete recovery cycle ─
  // Instant: by design, winning the Nth+1 trade covers all losses → net = +baseStake
  // Split: each recovery trade targets base × multiplier profit after covering loss
  const netAfterRecovery =
    recoveryMethod === "instant"
      ? baseStake
      : baseStake * (recoveryMultiplier - 1);

  // ─ Risk Score (0–100) ─
  // Three weighted components:
  // 1. Balance coverage   (0–40 pts): 5+ ladders = full marks, <1 = 0
  // 2. Streak avoidance   (0–40 pts): 0% probability = full marks
  // 3. Ladder/balance     (0–20 pts): ladder < 10% of balance = full marks
  const coverageScore = Math.min(40, (Math.min(balanceCoverage, 5) / 5) * 40);
  const streakScore   = Math.max(0, (1 - streakProbSession) * 40);
  const ratioScore    = Math.max(0, 20 - (totalLadderCost / balance) * 40);
  const riskScore     = Math.round(Math.min(100, coverageScore + streakScore + ratioScore));

  let riskLabel: RiskResult["riskLabel"];
  let riskColor: string;
  if (riskScore >= 70)      { riskLabel = "SAFE";     riskColor = "#10b981"; }
  else if (riskScore >= 45) { riskLabel = "MODERATE"; riskColor = "#f59e0b"; }
  else if (riskScore >= 25) { riskLabel = "RISKY";    riskColor = "#f97316"; }
  else                      { riskLabel = "EXTREME";  riskColor = "#ef4444"; }

  // ─ Warnings ─
  const warnings: string[] = [];
  if (balanceCoverage < 2)
    warnings.push("Balance covers fewer than 2 full recovery cycles — one bad run could wipe you out.");
  if (streakProbSession > 0.5)
    warnings.push(`${(streakProbSession * 100).toFixed(0)}% chance of hitting your loss limit in a single session.`);
  if (totalLadderCost > balance * 0.4)
    warnings.push("One full recovery cycle would consume over 40% of your balance.");
  if (ladder[ladder.length - 1] > baseStake * 30)
    warnings.push("Your final recovery stake is 30× your base — consider reducing max losses.");
  if (evPerTrade < -0.15)
    warnings.push("High house edge on this contract — long-term profitability requires strict discipline.");

  return {
    ladder, totalLadderCost,
    recommendedSL, recommendedTP,
    riskScore, riskLabel, riskColor,
    streakProbSession, streakProb50: sp50,
    balanceCoverage, evPerTrade, breakevenWinRate, netAfterRecovery,
    warnings,
  };
}

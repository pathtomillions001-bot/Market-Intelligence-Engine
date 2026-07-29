/**
 * Recovery Intelligence Engine
 *
 * SINGLE GLOBAL RECOVERY STATE — recovery applies regardless of which contract
 * type (Rise/Fall, Over/Under, Even/Odd) caused the loss. A loss on ANY
 * contract type puts the whole engine into recovery; the very next trade —
 * whatever contract type the AI picks — is treated as the recovery attempt.
 *
 * The Over/Under barrier used while trading is NOT chosen by scanning
 * candidates here. It is fixed by user-configured settings:
 *   - Normal mode:   settings.normalOverDigit   / settings.normalUnderDigit
 *   - Recovery mode: settings.recoveryOverDigit / settings.recoveryUnderDigit
 * (wired in ai.ts → ScanContext.recoveryBarrierOverride, consumed by
 * digit-probability.ts). This module only tracks recovery STATE and STAKE.
 *
 * Partial recovery: if a win doesn't fully cover the accumulated unrecovered
 * amount, the remaining balance stays active in recovery — it does NOT reset
 * to "normal" until a win (or sequence of wins) fully covers the debt.
 *
 * State persisted to DB (recoveryStateJson) so recovery survives restarts.
 */

import { getLocalTodayKey } from "../tz";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecoveryState {
  inRecovery:               boolean;
  recoveryStep:             number;       // 0 = not in recovery; increments per consecutive recovery loss
  unrecoveredAmount:        number;       // dollars still owed before returning to normal mode
  baseStake:                number;       // normal stake the engine recovers back to
  streakLossCount:          number;       // consecutive losses in the current streak (drives dashboard + cooldown gate)
  streakStartAmount:        number;       // total lost in this streak (display)
  resetDate:                string;       // local YYYY-MM-DD this state belongs to — drives the daily auto-reset
  consecutiveMatchLosses:   number;       // DIGITMATCH losses in a row while in recovery — triggers DIFF fallback at ≥3
}

/** Local calendar date in user's timezone in YYYY-MM-DD. Uses the tz offset stored in lib/tz so it agrees with the daily stats on the frontend. */
function todayKey(): string {
  return getLocalTodayKey();
}

function freshState(): RecoveryState {
  return {
    inRecovery:               false,
    recoveryStep:             0,
    unrecoveredAmount:        0,
    baseStake:                0,
    streakLossCount:          0,
    streakStartAmount:        0,
    resetDate:                todayKey(),
    consecutiveMatchLosses:   0,
  };
}

let state: RecoveryState = freshState();

/**
 * Inner new-day transition: resets state and applies 50%-debt carry-over.
 * Extracted so both `ensureFreshDay` (lazy check) and `forceNewDay`
 * (midnight scheduler) share identical logic.
 */
function applyNewDay(): void {
  const prevDebt      = state.unrecoveredAmount;
  const prevBaseStake = state.baseStake;
  const hadCarryOver  = state.inRecovery || prevDebt > 0 || state.streakLossCount > 0;

  state = freshState();

  // Carry 50% of any unrecovered debt into the new day (capped at 3× base stake).
  // A hard wipe would silently discard real account losses from late-night trades.
  // Half-carry enters at step 1 so previous escalating multipliers don't compound.
  if (prevDebt > 0 && prevBaseStake > 0) {
    const carryDebt = Math.min(prevDebt * 0.5, prevBaseStake * 3);
    if (carryDebt >= 0.35) {
      state.inRecovery        = true;
      state.unrecoveredAmount = carryDebt;
      state.baseStake         = prevBaseStake;
      state.recoveryStep      = 1;
      state.streakLossCount   = 1;
      state.streakStartAmount = carryDebt;
    }
  }

  if (hadCarryOver) persistToDb().catch(() => {});
}

/**
 * Every day starts on a clean slate — no unrecovered debt, streak, or recovery
 * mode carries over from a previous day, regardless of whether it was fully
 * covered or not. Called at the top of every read/write entry point so the
 * rollover is detected the instant the calendar day changes, whether the engine
 * is idle, mid-recovery, or mid-loop.
 */
function ensureFreshDay(): void {
  if (state.resetDate !== todayKey()) applyNewDay();
}

/**
 * Force an immediate new-day transition without checking the date.
 * Called by the midnight scheduler exactly at 00:00 in the user's local
 * timezone — avoids any lag waiting for the next trade/request to arrive.
 */
export function forceNewDay(): void {
  applyNewDay();
}

// ── DB persistence (auto, on every outcome) ────────────────────────────────────
// Persistence is triggered automatically inside recordOutcome() so it can never be
// forgotten by a call site (manual trade route, autonomous loop, etc). Lazily import
// the db module to avoid a hard circular/startup dependency on the db package for
// pure in-memory consumers/tests of this module.
let persistFn: (() => Promise<void>) | null = null;

async function persistToDb(): Promise<void> {
  try {
    if (!persistFn) {
      const { db, settingsTable } = await import("@workspace/db");
      persistFn = async () => {
        await db.update(settingsTable).set({ recoveryStateJson: JSON.stringify(state), updatedAt: new Date() });
      };
    }
    await persistFn();
  } catch {
    /* best-effort — in-memory state remains authoritative for the running process */
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Contract types the recovery engine tracks outcomes for. */
const TRACKED_CONTRACT_TYPES = new Set([
  "CALL", "PUT", "RISE", "FALL", "DIGITOVER", "DIGITUNDER", "DIGITEVEN", "DIGITODD",
  "DIGITMATCH", "DIGITDIFF",
]);

export function isTrackedContract(contractType: string): boolean {
  return TRACKED_CONTRACT_TYPES.has(contractType);
}

export function getState(): RecoveryState {
  ensureFreshDay();
  return state;
}

export function isInRecovery(): boolean {
  ensureFreshDay();
  return state.inRecovery;
}

// ── Stake calculation ─────────────────────────────────────────────────────────

/**
 * Compute the stake for a recovery trade.
 *
 * SPLIT mode (default): cap stake at `baseStake × recoveryMultiplier`.
 *   If the required stake exceeds this cap, partial recovery happens —
 *   the remaining debt persists until the next winning recovery trade.
 *   The multiplier comes from settings (default 1.62×), meaning the
 *   recovery stake is at most 1.62× the original trade stake per step.
 *
 * INSTANT mode: use the SAME recoveryMultiplier as Split whenever that's enough
 *   to cover the debt in one trade (i.e. it behaves exactly like Split's step 1,
 *   just always attempted in a single shot instead of progressively). Only when
 *   the accumulated debt is too large for that multiplier to fully cover does the
 *   stake grow beyond it — and even then, only up to the exact minimum needed to
 *   recover the debt, never more. This keeps Instant from ever over-exposing the
 *   user's capital chasing a bigger win than the debt requires.
 *
 * In both modes the stake is floored at $0.35 and capped at maxTradeStake.
 *
 * SPLIT mode progressive cap: each consecutive recovery LOSS raises the cap by
 *   1.0× so the sequence naturally becomes recoveryMultiplier, recoveryMultiplier+1,
 *   recoveryMultiplier+2, … (e.g. 1.62 → 2.62 → 3.62 for OVER 3 / UNDER 6).
 *   Step 1 stakes enough to cover the base loss; later steps grow to cover
 *   accumulated debt while keeping stakes predictable and non-exponential.
 *
 * Example (SPLIT, OVER 3, payout 1.62×, multiplier 1.62):
 *   Step 1: cap = base × 1.62;  win profit = 1.62 × 0.62 = 1.004 × base ✓
 *   Step 2: cap = base × 2.62;  win profit = 2.62 × 0.62 = 1.624 × base ✓
 *   Step 3: cap = base × 3.62;  win profit = 3.62 × 0.62 = 2.244 × base
 *
 * Example (INSTANT, small loss — the standard multiplier is enough):
 *   base=$10, lost $10, payout 1.62× → splitEquivalentStake = $16.20;
 *   $16.20 × 0.62 = $10.04 ≥ $10 debt → use $16.20 (same as Split step 1, not larger).
 *
 * Example (INSTANT, larger accumulated debt — standard multiplier isn't enough):
 *   base=$10, debt=$40, payout 1.62× → $16.20 × 0.62 = $10.04 < $40, so scale up to
 *   minRecovery = $40 / 0.62 × 1.02 ≈ $65.80 — the exact minimum to win back ~$41
 *   (debt + small buffer), not an oversized stake chasing a much bigger profit.
 */
function computeDynamicStake(
  unrecoveredAmount: number,
  payout: number,
  _blendedWinP: number,   // intentionally unused — win probability does not inflate stake
  balance: number,
  maxTradeStake: number,
  riskProfile: "conservative" | "moderate" | "aggressive",
  baseStake: number,
  recoveryMultiplier: number,  // from settings (default 1.62); only used in manual mode
  recoveryMethod: "split" | "instant",
  recoveryStep: number,        // how many consecutive recovery losses so far (drives progressive cap)
  maxRecoverySteps: number,    // from settings — bounds instant mode's exposure the same way split mode is bounded
  recoveryAutoMode: boolean,   // true = AI computes exact stake; false = manual multiplier-driven
): number {
  const netPayout = payout - 1;
  if (netPayout <= 0) return 0.35;

  // Exact minimum stake to recover the full unrecovered amount in one win,
  // plus a 2% buffer for Deriv's decimal rounding and near-1.0 payout edge cases.
  const minRecovery = (unrecoveredAmount / netPayout) * 1.02;

  // Profile-based safety cap: never risk more than this fraction of balance.
  const maxExposurePct = riskProfile === "conservative" ? 0.08
    : riskProfile === "aggressive" ? 0.20
    : 0.12;   // moderate
  const maxExposure = Math.min(balance * maxExposurePct, maxTradeStake);

  // ── AUTO MODE ────────────────────────────────────────────────────────────────
  // AI-computed stake: the exact minimum to recover the full accumulated debt
  // given this barrier's real payout — no multiplier, no progressive cap.
  // Split vs Instant still governs the recovery *style* choice the user made,
  // but both use the same minimum stake calculation here so there is no
  // unnecessary over-exposure.
  //
  // Capital-protection guard still applies: for very-low net-payout barriers
  // (OVER 0, OVER 1, DIGITDIFF — netPayout < 0.15) the math-minimum would be
  // enormous (26× debt for net 0.04). We cap at maxExposure to protect capital;
  // recovery will take multiple steps instead of one.
  if (recoveryAutoMode) {
    return Math.max(0.35, Math.min(minRecovery, maxExposure, maxTradeStake));
  }

  // ── MANUAL MODE ──────────────────────────────────────────────────────────────
  // Capital-protection override: for very-low net-payout contracts such as
  // DIGITDIFF (payout 1.04×, netPayout = 0.04), full instant recovery in one
  // trade would require a stake ≈ 26× the accumulated debt — dangerously
  // over-exposing the user's capital. Always use split-mode progressive capping
  // for these contracts regardless of the recoveryMethod setting so recovery
  // happens gradually over multiple near-certain wins rather than one huge bet.
  //
  // Threshold: netPayout < 0.15 covers DIGITDIFF (0.04) while leaving all
  // DIGITOVER/DIGITUNDER barriers (minimum OVER 8 netPayout = 3.9) unaffected.
  const isLowNetPayout = netPayout < 0.15;

  if (recoveryMethod === "instant" && !isLowNetPayout) {
    // Instant: use the SAME reasonable multiplier Split mode uses (recoveryMultiplier,
    // e.g. 1.62×) whenever that's enough to cover the loss in one trade — Instant
    // should never stake more than Split's own step-1 stake just because it's
    // "instant". Only when the accumulated debt is too large for that multiplier to
    // cover in one shot does the stake grow — and even then, only up to the exact
    // minimum needed to fully recover (plus a 5% rounding buffer), never further.
    const splitEquivalentStake = baseStake > 0 ? baseStake * recoveryMultiplier : minRecovery;
    const stake = (splitEquivalentStake * netPayout >= unrecoveredAmount)
      ? splitEquivalentStake   // the standard multiplier already covers the debt — use it, nothing bigger
      : minRecovery;           // debt exceeds what the standard multiplier covers — use the exact minimum needed instead
    return Math.max(0.35, Math.min(stake, maxExposure, maxTradeStake));
  }

  // Split (and low-net-payout instant): progressive cap grows per consecutive recovery loss.
  //
  // KEY FIX — payout-calibrated cap: the user-configured recoveryMultiplier is the FLOOR,
  // but the cap can never be lower than what the live barrier payout mathematically requires
  // to cover exactly one base-stake loss in a single win.
  //
  //   payoutImpliedMinMult = 1 / netPayout × 1.05
  //   → OVER 3  (payout 1.37×, netPayout 0.37): needs 2.84× — user's 1.62× would only
  //     win back 0.60× base, leaving partial debt after every recovery step.
  //   → OVER 5  (payout 1.96×, netPayout 0.96): needs 1.09× — user's 1.62× is more
  //     than sufficient; minRecovery wins and the stake stays at ~1.09×.
  //   → DIGITMATCH (payout 9×, netPayout 8):    needs 0.13× — minRecovery governs
  //     as always (tiny stake fully covers the debt at 9× payout).
  //
  // Progressive step still grows by 1× baseEffectiveMult so each consecutive recovery
  // loss raises the cap predictably: step1=baseEffective, step2=baseEffective+1, …
  const stepOffset = Math.max(0, recoveryStep - 1);
  const payoutImpliedMinMult = (1 / netPayout) * 1.05;
  const baseEffectiveMult    = Math.max(recoveryMultiplier, payoutImpliedMinMult);
  const progressiveMultiplier = Math.max(1.1, baseEffectiveMult + stepOffset);
  const splitCap = baseStake > 0 ? baseStake * progressiveMultiplier : maxTradeStake;

  return Math.max(0.35, Math.min(minRecovery, maxExposure, splitCap, maxTradeStake));
}

/**
 * Get the stake for the next trade. Outside of recovery, this is just the
 * AI-computed base stake. Inside recovery, the stake is sized to recover the
 * accumulated unrecovered amount given the payout/win-probability of whatever
 * contract type the AI has selected for this trade (recovery is not tied to a
 * specific contract type).
 *
 * @param recoveryMultiplier  From settings — controls the split-mode base multiplier (and Instant's floor, see
 *                            computeDynamicStake above). Must be calibrated to the REAL payout of the recovery
 *                            barrier so step 1 recovers exactly one base-stake loss: multiplier ≈ 1/(payout-1) × 1.02.
 *                            The frontend's "Auto" button computes this from the actual Deriv payout table —
 *                            a generic barrier-index formula disconnected from real payouts was the previous bug.
 * @param recoveryMethod      "split" (progressive, non-exponential) or "instant" (full recovery in one trade)
 */
export function getDynamicRecoveryStake(
  baseStakeFromAI: number,
  maxTradeStake: number,
  balance: number,
  payoutMultiplier: number,
  winProbability01: number,
  riskProfile: "conservative" | "moderate" | "aggressive",
  recoveryMultiplier = 1.62,
  recoveryMethod: "split" | "instant" = "split",
  maxRecoverySteps = 3,
  recoveryAutoMode = true,
): number {
  ensureFreshDay();
  if (!state.inRecovery) {
    if (baseStakeFromAI > 0 && isFinite(baseStakeFromAI)) state.baseStake = baseStakeFromAI;
    return baseStakeFromAI;
  }

  const raw = computeDynamicStake(
    state.unrecoveredAmount, payoutMultiplier, winProbability01, balance, maxTradeStake, riskProfile,
    state.baseStake, recoveryMultiplier, recoveryMethod, state.recoveryStep, maxRecoverySteps,
    recoveryAutoMode,
  );
  return Math.max(0.35, Math.min(raw, maxTradeStake));
}

// ── Outcome recording ─────────────────────────────────────────────────────────

/**
 * Record the outcome of ANY trade (regardless of contract type) against the
 * single global recovery state.
 *
 * - Loss: enters/extends recovery. The debt (unrecoveredAmount) and streak
 *   accumulate regardless of what contract type just lost.
 * - Win while in recovery: reduces the debt by the profit earned. Only
 *   resets to "normal" once the win (or wins) fully cover the debt — a
 *   partial win leaves the remaining balance active in recovery.
 * - Win while NOT in recovery: no-op (already normal).
 */
export function recordOutcome(
  won: boolean,
  profit: number,
  stakeUsed: number,
  maxRecoverySteps: number,
  contractType?: string,
): RecoveryState {
  ensureFreshDay();
  const isMatch = contractType === "DIGITMATCH";

  if (won) {
    if (state.inRecovery) {
      const recovered = Math.max(0, profit);
      const remaining = state.unrecoveredAmount - recovered;
      // Use a half-cent epsilon so floating-point accumulation across many partial
      // recovery steps (e.g. 0.1 + 0.2 style drift) can never leave a phantom few
      // cents of "debt" that rounds to $0.00 on screen but keeps the card stuck in
      // recovery mode forever. Anything under half a cent counts as fully cleared.
      if (remaining <= 0.005) {
        // Fully recovered — return to normal immediately, regardless of whether the
        // winning trade was placed manually or by the AI engine.
        state = freshState();
      } else {
        state.unrecoveredAmount = remaining;
        // Streak is broken by a win, but the debt (and recovery mode) persists
        // until it is fully covered. Reset consecutive MATCH loss counter on any win.
        state.streakLossCount = 0;
        state.consecutiveMatchLosses = 0;
      }
    }
  } else {
    if (!state.inRecovery) {
      state.inRecovery               = true;
      state.recoveryStep             = 1;
      state.baseStake                = state.baseStake > 0 ? state.baseStake : stakeUsed;
      state.unrecoveredAmount        = stakeUsed;
      state.streakLossCount          = 1;
      state.streakStartAmount        = stakeUsed;
      // If the very first loss was a MATCH trade, start the counter
      state.consecutiveMatchLosses   = isMatch ? 1 : 0;
    } else {
      const cap                = maxRecoverySteps > 0 ? maxRecoverySteps : 3;
      state.recoveryStep       = Math.min(state.recoveryStep + 1, cap);
      state.unrecoveredAmount += stakeUsed;
      state.streakLossCount++;
      state.streakStartAmount += stakeUsed;
      // Track consecutive MATCH losses during recovery for the DIFF fallback gate.
      // Reset to 0 when any non-MATCH trade loses (we're already on a DIFF attempt).
      if (isMatch) {
        state.consecutiveMatchLosses++;
      } else {
        // A non-MATCH loss during recovery — reset the MATCH counter so the next
        // recovery cycle restarts with MATCH before falling back to DIFF again.
        state.consecutiveMatchLosses = 0;
      }
    }
  }

  // Persist on EVERY outcome (win or loss, manual or autonomous) — fire-and-forget so
  // callers never block on DB latency, but the call itself can never be forgotten since
  // it lives here rather than at each call site.
  persistToDb().catch(() => {});

  return state;
}

// ── State management ──────────────────────────────────────────────────────────

export function resetAll(): void {
  state = freshState();
}

/** Overwrite the entire recovery state (used when syncing from the Deriv journal). */
export function seedState(data: RecoveryState): void {
  state = { ...data };
}

export function serializeState(): string {
  return JSON.stringify(state);
}

export function loadState(json: string): void {
  try {
    const parsed = JSON.parse(json);
    // Backward compatibility: older versions stored an array of per-family states.
    // Collapse them into a single global state so a saved-before-migration DB row
    // doesn't crash — sum unrecovered amounts / streaks across all former families.
    if (Array.isArray(parsed)) {
      const inRecovery = parsed.some((s: any) => s?.inRecovery);
      state = {
        inRecovery,
        recoveryStep:      Math.max(0, ...parsed.map((s: any) => Number(s?.recoveryStep) || 0)),
        unrecoveredAmount: parsed.reduce((sum: number, s: any) => sum + (Number(s?.unrecoveredAmount) || 0), 0),
        baseStake:         Math.max(0, ...parsed.map((s: any) => Number(s?.baseStake) || 0)),
        streakLossCount:   parsed.reduce((sum: number, s: any) => sum + (Number(s?.streakLossCount) || 0), 0),
        streakStartAmount:        parsed.reduce((sum: number, s: any) => sum + (Number(s?.streakStartAmount) || 0), 0),
        // Legacy per-family rows predate this feature — always treat as "not today".
        resetDate:                "",
        consecutiveMatchLosses:   0,
      };
      if (!inRecovery) state = freshState();
      ensureFreshDay();
      return;
    }

    state = {
      inRecovery:               !!parsed.inRecovery,
      recoveryStep:             Number(parsed.recoveryStep)       || 0,
      unrecoveredAmount:        Number(parsed.unrecoveredAmount)  || 0,
      baseStake:                Number(parsed.baseStake)          || 0,
      streakLossCount:          Number(parsed.streakLossCount)    || 0,
      streakStartAmount:        Number(parsed.streakStartAmount)  || 0,
      // Older/legacy saved rows never had resetDate — treat as "not today" so a
      // pre-existing carry-over debt from before this feature existed is cleared
      // immediately on load rather than silently resurrected.
      resetDate:                typeof parsed.resetDate === "string" ? parsed.resetDate : "",
      // New field — default to 0 for rows saved before this feature existed
      consecutiveMatchLosses:   Number(parsed.consecutiveMatchLosses) || 0,
    };
  } catch {
    /* ignore malformed state — start fresh */
  }
  // Collapse anything loaded from a previous calendar day back to a clean slate —
  // covers server restarts/deploys that happen to land after midnight.
  ensureFreshDay();
}

export function getLossStreakSummary(): {
  active: boolean;
  totalUnrecovered: number;
  totalStreakLosses: number;
  totalStreakAmount: number;
} {
  ensureFreshDay();
  return {
    active:            state.inRecovery,
    totalUnrecovered:  state.unrecoveredAmount,
    totalStreakLosses: state.streakLossCount,
    totalStreakAmount: state.streakStartAmount,
  };
}

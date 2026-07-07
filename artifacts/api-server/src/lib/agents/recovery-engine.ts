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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecoveryState {
  inRecovery:          boolean;
  recoveryStep:        number;       // 0 = not in recovery; increments per consecutive recovery loss
  unrecoveredAmount:   number;       // dollars still owed before returning to normal mode
  baseStake:           number;       // normal stake the engine recovers back to
  streakLossCount:     number;       // consecutive losses in the current streak (drives dashboard + cooldown gate)
  streakStartAmount:   number;       // total lost in this streak (display)
  resetDate:           string;       // local YYYY-MM-DD this state belongs to — drives the daily auto-reset
}

/** Local calendar date (server time) in YYYY-MM-DD, matching how "today" is computed elsewhere (daily P&L, daily stats). */
function todayKey(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function freshState(): RecoveryState {
  return {
    inRecovery:          false,
    recoveryStep:        0,
    unrecoveredAmount:   0,
    baseStake:           0,
    streakLossCount:     0,
    streakStartAmount:   0,
    resetDate:           todayKey(),
  };
}

let state: RecoveryState = freshState();

/**
 * Every day starts on a clean slate — no unrecovered debt, streak, or recovery
 * mode carries over from a previous day, regardless of whether it was fully
 * covered or not. Called at the top of every read/write entry point so the
 * rollover is detected the instant the calendar day changes (no separate
 * cron/timer needed), whether the engine is idle, mid-recovery, or mid-loop.
 */
function ensureFreshDay(): void {
  const today = todayKey();
  if (state.resetDate !== today) {
    const hadCarryOver = state.inRecovery || state.unrecoveredAmount > 0 || state.streakLossCount > 0;
    state = freshState();
    if (hadCarryOver) persistToDb().catch(() => {});
  }
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
 * Compute the MINIMUM stake required to recover `unrecoveredAmount` in a single
 * winning trade. We use the exact mathematical minimum (unrecovered / netPayout)
 * plus a tiny 2% rounding buffer — no inflation by win probability, which was
 * inflating stakes well above what was needed and unnecessarily exposing capital.
 *
 * Example: lost $17.78 on a trade paying 1.63×
 *   netPayout = 0.63
 *   minRecovery = 17.78 / 0.63 = 28.22  →  with 2% buffer = $28.78
 *   That stake at 1.63× yields profit of $18.13 — just enough to cover the loss.
 */
function computeDynamicStake(
  unrecoveredAmount: number,
  payout: number,
  _blendedWinP: number,   // intentionally unused — see note above
  balance: number,
  maxTradeStake: number,
  riskProfile: "conservative" | "moderate" | "aggressive",
): number {
  const netPayout = payout - 1;
  if (netPayout <= 0) return 0.35;

  // Exact minimum stake to fully recover in one winning trade,
  // plus a 2% buffer to absorb Deriv's 2-decimal-place rounding.
  const minRecovery = (unrecoveredAmount / netPayout) * 1.02;

  // Profile-based safety cap: never risk more than this fraction of balance
  // on a single recovery trade, regardless of the unrecovered amount.
  const maxExposurePct = riskProfile === "conservative" ? 0.08
    : riskProfile === "aggressive" ? 0.20
    : 0.12;   // moderate
  const maxExposure = Math.min(balance * maxExposurePct, maxTradeStake);

  return Math.max(0.35, Math.min(minRecovery, maxExposure));
}

/**
 * Get the stake for the next trade. Outside of recovery, this is just the
 * AI-computed base stake. Inside recovery, the stake is sized to recover the
 * accumulated unrecovered amount given the payout/win-probability of whatever
 * contract type the AI has selected for this trade (recovery is not tied to a
 * specific contract type).
 */
export function getDynamicRecoveryStake(
  baseStakeFromAI: number,
  maxTradeStake: number,
  balance: number,
  payoutMultiplier: number,
  winProbability01: number,
  riskProfile: "conservative" | "moderate" | "aggressive",
): number {
  ensureFreshDay();
  if (!state.inRecovery) {
    if (baseStakeFromAI > 0 && isFinite(baseStakeFromAI)) state.baseStake = baseStakeFromAI;
    return baseStakeFromAI;
  }

  const raw = computeDynamicStake(
    state.unrecoveredAmount, payoutMultiplier, winProbability01, balance, maxTradeStake, riskProfile,
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
): RecoveryState {
  ensureFreshDay();
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
        // until it is fully covered.
        state.streakLossCount = 0;
      }
    }
  } else {
    if (!state.inRecovery) {
      state.inRecovery        = true;
      state.recoveryStep      = 1;
      state.baseStake         = state.baseStake > 0 ? state.baseStake : stakeUsed;
      state.unrecoveredAmount = stakeUsed;
      state.streakLossCount   = 1;
      state.streakStartAmount = stakeUsed;
    } else {
      const cap                = maxRecoverySteps > 0 ? maxRecoverySteps : 3;
      state.recoveryStep       = Math.min(state.recoveryStep + 1, cap);
      state.unrecoveredAmount += stakeUsed;
      state.streakLossCount++;
      state.streakStartAmount += stakeUsed;
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
        streakStartAmount: parsed.reduce((sum: number, s: any) => sum + (Number(s?.streakStartAmount) || 0), 0),
        // Legacy per-family rows predate this feature — always treat as "not today".
        resetDate:         "",
      };
      if (!inRecovery) state = freshState();
      ensureFreshDay();
      return;
    }

    state = {
      inRecovery:          !!parsed.inRecovery,
      recoveryStep:        Number(parsed.recoveryStep)       || 0,
      unrecoveredAmount:   Number(parsed.unrecoveredAmount)  || 0,
      baseStake:           Number(parsed.baseStake)          || 0,
      streakLossCount:     Number(parsed.streakLossCount)    || 0,
      streakStartAmount:   Number(parsed.streakStartAmount)  || 0,
      // Older/legacy saved rows never had resetDate — treat as "not today" so a
      // pre-existing carry-over debt from before this feature existed is cleared
      // immediately on load rather than silently resurrected.
      resetDate:           typeof parsed.resetDate === "string" ? parsed.resetDate : "",
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

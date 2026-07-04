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
}

function freshState(): RecoveryState {
  return {
    inRecovery:          false,
    recoveryStep:        0,
    unrecoveredAmount:   0,
    baseStake:           0,
    streakLossCount:     0,
    streakStartAmount:   0,
  };
}

let state: RecoveryState = freshState();

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
  return state;
}

export function isInRecovery(): boolean {
  return state.inRecovery;
}

// ── Stake calculation ─────────────────────────────────────────────────────────

/**
 * Compute the minimum stake required to recover `unrecoveredAmount` in a single
 * winning trade, then risk-adjust for win probability. Always cap at maxTradeStake
 * and never go below $0.35.
 */
function computeDynamicStake(
  unrecoveredAmount: number,
  payout: number,
  blendedWinP: number,
  balance: number,
  maxTradeStake: number,
  riskProfile: "conservative" | "moderate" | "aggressive",
): number {
  const netPayout = payout - 1;
  if (netPayout <= 0) return 0.35;

  // Minimum stake to fully recover in one win:
  const minRecovery = unrecoveredAmount / netPayout;

  // Risk-adjusted: account for the probability of winning — use conservative sizing
  // so we don't over-expose. Conservative factor: divide by (0.7 * winP + 0.3)
  const conservativeFactor = 0.7 * Math.max(0.4, blendedWinP) + 0.3;
  const riskAdjusted = minRecovery / conservativeFactor;

  // Profile-based max exposure (% of balance)
  const maxExposurePct = riskProfile === "conservative" ? 0.08
    : riskProfile === "aggressive" ? 0.20
    : 0.12;   // moderate
  const maxExposure = Math.min(balance * maxExposurePct, maxTradeStake);

  return Math.max(0.35, Math.min(riskAdjusted, maxExposure));
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
  if (won) {
    if (state.inRecovery) {
      const recovered = Math.max(0, profit);
      if (recovered >= state.unrecoveredAmount) {
        // Fully recovered — return to normal.
        state = freshState();
      } else {
        state.unrecoveredAmount -= recovered;
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
      };
      if (!inRecovery) state = freshState();
      return;
    }

    state = {
      inRecovery:          !!parsed.inRecovery,
      recoveryStep:        Number(parsed.recoveryStep)       || 0,
      unrecoveredAmount:   Number(parsed.unrecoveredAmount)  || 0,
      baseStake:           Number(parsed.baseStake)          || 0,
      streakLossCount:     Number(parsed.streakLossCount)    || 0,
      streakStartAmount:   Number(parsed.streakStartAmount)  || 0,
    };
  } catch {
    /* ignore malformed state — start fresh */
  }
}

export function getLossStreakSummary(): {
  active: boolean;
  totalUnrecovered: number;
  totalStreakLosses: number;
  totalStreakAmount: number;
} {
  return {
    active:            state.inRecovery,
    totalUnrecovered:  state.unrecoveredAmount,
    totalStreakLosses: state.streakLossCount,
    totalStreakAmount: state.streakStartAmount,
  };
}

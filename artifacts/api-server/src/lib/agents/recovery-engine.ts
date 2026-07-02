/**
 * Recovery Engine
 *
 * RESPONSIBILITY: Track real, independent recovery state per contract family
 * (Over/Under, Rise/Fall, Even/Odd) and compute the correct barrier/stake
 * overrides while a family is "in recovery" after a loss.
 *
 * Rules implemented (per product spec):
 *   1. Over/Under: on loss, switch to OVER 4 / UNDER 5 (matching AI direction)
 *      instead of the normal OVER 2 / UNDER 7. Stay there until the
 *      accumulated losses are fully recovered, then return to normal barriers.
 *   2. Over/Under stake: nextStake = baseStake * (recoveryMultiplier ^ recoveryStep).
 *      recoveryStep increments by 1 on every consecutive recovery loss.
 *   3. Rise/Fall & Even/Odd: on loss, only the stake escalates (same formula) —
 *      no parameter/barrier changes. Reset to base stake once recovered.
 *   4. Each contract family keeps fully independent recovery state.
 *   5. Gradual recovery: a partial win reduces the remaining unrecovered
 *      amount but keeps the family in recovery (at the current stake) until
 *      accumulated recovery profit fully covers the unrecovered amount.
 *
 * State is persisted to the DB (recoveryStateJson in settings table) so
 * recovery survives server restarts — the engine always resumes in recovery
 * mode if there was an unrecovered loss streak when it last stopped.
 */

export type ContractFamily = "overunder" | "risefall" | "evenodd";

export const CONTRACT_FAMILIES: ContractFamily[] = ["overunder", "risefall", "evenodd"];

export interface FamilyRecoveryState {
  family: ContractFamily;
  inRecovery: boolean;
  recoveryStep: number;       // 0 = not in recovery; increments per consecutive recovery loss
  unrecoveredAmount: number;  // dollars still owed before returning to normal mode
  baseStake: number;          // the normal stake this family recovers back to
  streakLossCount: number;    // how many losses in the current streak (for display)
  streakStartAmount: number;  // total amount lost in this streak (for display)
}

function freshState(family: ContractFamily): FamilyRecoveryState {
  return {
    family,
    inRecovery: false,
    recoveryStep: 0,
    unrecoveredAmount: 0,
    baseStake: 0,
    streakLossCount: 0,
    streakStartAmount: 0,
  };
}

const states = new Map<ContractFamily, FamilyRecoveryState>(
  CONTRACT_FAMILIES.map((f) => [f, freshState(f)])
);

/** Map a Deriv contract type to its recovery family, or null if not tracked. */
export function contractTypeToFamily(contractType: string): ContractFamily | null {
  if (contractType === "DIGITOVER" || contractType === "DIGITUNDER") return "overunder";
  if (["CALL", "PUT", "RISE", "FALL"].includes(contractType)) return "risefall";
  if (contractType === "DIGITEVEN" || contractType === "DIGITODD") return "evenodd";
  return null;
}

export function getState(family: ContractFamily): FamilyRecoveryState {
  return states.get(family) ?? freshState(family);
}

export function getAllStates(): FamilyRecoveryState[] {
  return CONTRACT_FAMILIES.map((f) => getState(f));
}

export function isInRecovery(family: ContractFamily): boolean {
  return getState(family).inRecovery;
}

export function isAnyInRecovery(): boolean {
  return getAllStates().some((s) => s.inRecovery);
}

/** OVER 4 / UNDER 5 recovery barrier override for the Over/Under family. */
export function getBarrierOverride(family: ContractFamily): { DIGITOVER: number; DIGITUNDER: number } | undefined {
  if (family !== "overunder") return undefined;
  const state = getState(family);
  if (!state.inRecovery) return undefined;
  return { DIGITOVER: 4, DIGITUNDER: 5 };
}

/**
 * The stake to actually use for the next trade in this family, given the
 * "normal" risk-based base stake computed for this scan.
 * While NOT in recovery, this is simply the base stake (and refreshes the
 * remembered baseStake so recovery always recovers back to a current value).
 */
export function getNextStake(family: ContractFamily, normalStake: number, recoveryMultiplier: number, maxTradeStake: number): number {
  const state = getState(family);
  if (!state.inRecovery) {
    state.baseStake = normalStake;
    return normalStake;
  }
  const mult = isFinite(recoveryMultiplier) && recoveryMultiplier > 1 ? recoveryMultiplier : 1.2;
  const raw = state.baseStake * Math.pow(mult, state.recoveryStep);
  return Math.max(0.35, Math.min(raw, maxTradeStake));
}

/**
 * Record the outcome of a settled trade for its contract family and update
 * recovery state accordingly. `stakeUsed` is the actual stake risked on this
 * trade (needed to know exactly how much still needs to be recovered).
 *
 * NB: The engine MUST call this immediately after every settled trade before
 * deciding on the next trade — recovery mode must always be aware of the
 * most recent outcome before opening a new position.
 */
export function recordOutcome(
  family: ContractFamily,
  won: boolean,
  profit: number,
  stakeUsed: number,
  maxRecoverySteps: number,
): FamilyRecoveryState {
  const state = getState(family);

  if (won) {
    if (state.inRecovery) {
      const recovered = Math.max(0, profit);
      if (recovered >= state.unrecoveredAmount) {
        // Fully recovered — return to normal mode, clear streak counters.
        states.set(family, freshState(family));
      } else {
        state.unrecoveredAmount -= recovered;
        // Stay in recovery at the current step/stake until the remainder clears.
      }
    }
    // Not in recovery + win: nothing to track.
  } else {
    if (!state.inRecovery) {
      // Enter recovery for the first time — this is the start of a loss streak.
      state.inRecovery = true;
      state.recoveryStep = 1;
      state.baseStake = state.baseStake > 0 ? state.baseStake : stakeUsed;
      state.unrecoveredAmount = stakeUsed;
      state.streakLossCount = 1;
      state.streakStartAmount = stakeUsed;
    } else {
      // Consecutive recovery loss — escalate stake, add to the amount owed.
      const cap = maxRecoverySteps > 0 ? maxRecoverySteps : 3;
      state.recoveryStep = Math.min(state.recoveryStep + 1, cap);
      state.unrecoveredAmount += stakeUsed;
      state.streakLossCount++;
      state.streakStartAmount += stakeUsed;
    }
  }

  return getState(family);
}

/** Reset every family back to normal mode (e.g. daily reset, not on restart). */
export function resetAll(): void {
  for (const f of CONTRACT_FAMILIES) states.set(f, freshState(f));
}

/**
 * Directly seed a family's recovery state from external data (e.g. DB journal sync).
 * Used by the journal-sync routine to ensure recovery state always matches actual
 * trade history, even for manual trades or after server restarts.
 */
export function seedFamilyState(
  family: ContractFamily,
  data: {
    inRecovery: boolean;
    recoveryStep: number;
    unrecoveredAmount: number;
    baseStake: number;
    streakLossCount: number;
    streakStartAmount: number;
  },
): void {
  states.set(family, { family, ...data });
}

/**
 * Serialize the current recovery state to a JSON string for DB persistence.
 * Call this after every recordOutcome() so the state survives server restarts.
 */
export function serializeState(): string {
  return JSON.stringify(CONTRACT_FAMILIES.map((f) => getState(f)));
}

/**
 * Load recovery state from a previously serialized JSON string (from DB).
 * Called on server startup so recovery resumes from where it left off.
 */
export function loadState(json: string): void {
  try {
    const parsed = JSON.parse(json) as FamilyRecoveryState[];
    for (const s of parsed) {
      if (CONTRACT_FAMILIES.includes(s.family)) {
        states.set(s.family, {
          family: s.family,
          inRecovery: !!s.inRecovery,
          recoveryStep: Number(s.recoveryStep) || 0,
          unrecoveredAmount: Number(s.unrecoveredAmount) || 0,
          baseStake: Number(s.baseStake) || 0,
          streakLossCount: Number(s.streakLossCount) || 0,
          streakStartAmount: Number(s.streakStartAmount) || 0,
        });
      }
    }
  } catch {
    /* ignore malformed state — start fresh */
  }
}

/**
 * Returns a summary of the last active loss streak across all families.
 * Used by the dashboard recovery card and the AI engine to know the
 * total unrecovered amount before opening the next trade.
 */
export function getLossStreakSummary(): {
  active: boolean;
  totalUnrecovered: number;
  totalStreakLosses: number;
  totalStreakAmount: number;
  families: ContractFamily[];
} {
  const active = getAllStates().filter((s) => s.inRecovery);
  return {
    active: active.length > 0,
    totalUnrecovered: active.reduce((s, f) => s + f.unrecoveredAmount, 0),
    totalStreakLosses: active.reduce((s, f) => s + f.streakLossCount, 0),
    totalStreakAmount: active.reduce((s, f) => s + f.streakStartAmount, 0),
    families: active.map((f) => f.family),
  };
}

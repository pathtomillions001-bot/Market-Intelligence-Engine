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
 * State lives in-memory only (matches the rest of the engine's session state,
 * e.g. sessionLossCount in ai.ts) — it resets on server restart.
 */

export type ContractFamily = "overunder" | "risefall" | "evenodd";

export const CONTRACT_FAMILIES: ContractFamily[] = ["overunder", "risefall", "evenodd"];

export interface FamilyRecoveryState {
  family: ContractFamily;
  inRecovery: boolean;
  recoveryStep: number;       // 0 = not in recovery; increments per consecutive recovery loss
  unrecoveredAmount: number;  // dollars still owed before returning to normal mode
  baseStake: number;          // the normal stake this family recovers back to
}

function freshState(family: ContractFamily): FamilyRecoveryState {
  return { family, inRecovery: false, recoveryStep: 0, unrecoveredAmount: 0, baseStake: 0 };
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
        // Fully recovered — return to normal mode.
        states.set(family, freshState(family));
      } else {
        state.unrecoveredAmount -= recovered;
        // Stay in recovery at the current step/stake until the remainder clears.
      }
    }
    // Not in recovery + win: nothing to track.
  } else {
    if (!state.inRecovery) {
      // Enter recovery for the first time.
      state.inRecovery = true;
      state.recoveryStep = 1;
      state.baseStake = state.baseStake > 0 ? state.baseStake : stakeUsed;
      state.unrecoveredAmount = stakeUsed;
    } else {
      // Consecutive recovery loss — escalate stake, add to the amount owed.
      const cap = maxRecoverySteps > 0 ? maxRecoverySteps : 3;
      state.recoveryStep = Math.min(state.recoveryStep + 1, cap);
      state.unrecoveredAmount += stakeUsed;
    }
  }

  return getState(family);
}

/** Reset every family back to normal mode (e.g. when the engine is manually stopped/started). */
export function resetAll(): void {
  for (const f of CONTRACT_FAMILIES) states.set(f, freshState(f));
}

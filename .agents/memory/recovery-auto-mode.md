---
name: Recovery auto mode
description: recoveryAutoMode field — how manual vs auto changes stake sizing in recovery-engine.ts and what the UI shows/hides.
---

# Recovery Auto Mode

## UI badge — contract-type-aware
`suggestedMultiplierInfo` in settings.tsx detects the actual recovery type from `preferredContractTypes` using the engine's own priority: DIGITMATCH (9× → 0.13×) → EVEN/ODD (1.96× → 1.04×) → OVER/UNDER (barrier-dependent). Badge shows "Calibrated to DIGITMATCH (9×)" etc. — not always the OVER digit. Backend uses the actual trade payout at runtime so it's always correct; the badge is display only.

## The rule
`recoveryAutoMode` (DB column `recovery_auto_mode`, boolean, default `false`) controls how `computeDynamicStake` sizes recovery stakes.

**Manual mode (false):** `baseEffectiveMult = recoveryMultiplier` — user's configured value is the hard cap, no payout override. Split-mode stakes are modest; each step may only partially recover the debt. This is the "previous" non-greedy behavior.

**Auto mode (true):** `baseEffectiveMult = 1/netPayout × 1.02` — exact multiplier for the barrier. Each step covers exactly one base-stake loss, calibrated to the actual barrier payout.

Also: `minRecovery` buffer is 1.02 (not 1.05 — reduced to be less aggressive).

**Why:** The old `Math.max(recoveryMultiplier, payoutImpliedMinMult)` in split mode forced full-debt recovery in one step even for split mode, making stakes ~2.8× base for OVER 3 (netPayout 0.37). Manual mode removes that floor.

## How to apply
- All callers of `getDynamicRecoveryStake` pass `tradingSettings.recoveryAutoMode` as the 10th arg (default `false`).
- `buildTradingSettings` and `buildTradingSettingsForManual` both read `s?.recoveryAutoMode ?? false`.
- `UpdateSettingsBody` in `lib/api-zod/src/generated/api.ts` has `recoveryAutoMode: zod.boolean().optional()`.
- UI: settings.tsx shows Manual/Auto toggle only when `recoveryMode` is ON; multiplier field hidden in auto mode; auto mode shows a badge with the computed multiplier from `suggestedMultiplier`.

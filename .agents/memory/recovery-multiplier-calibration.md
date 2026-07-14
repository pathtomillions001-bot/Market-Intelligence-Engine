---
name: Recovery multiplier must match the real barrier payout
description: Why a static/manually-set recoveryMultiplier can silently mismatch the configured recovery barrier, and how Instant recovery mode should size its stake.
---

The recovery multiplier (e.g. 1.62×) is only "correct" if it matches the REAL Deriv
payout of whatever OVER/UNDER barrier is currently configured for recovery:

```
requiredMultiplier ≈ 1 / (payout - 1) × 1.02   (covers exactly one base-stake loss)
```

**The bug:** the frontend's "Auto" suggestion button used a generic formula
(`10/(9-overDigit) × 0.972`) disentangled from the real Deriv payout table
(`DIGIT_PAYOUTS` in `digit-probability.ts`). For OVER 3/UNDER 6 (real payout 1.37×,
not the ~1.63× the formula implicitly assumed), the formula suggested 1.62× when the
barrier actually needs ~2.76× to cover one loss — so the "reasonable" multiplier the
user saw in Settings never matched what the math required, and any recovery stake
sizing built on top of it looked like unexplained overshoot.

**Why:** lower-payout barriers need a bigger multiplier to cover the same loss; there's
no way around that trade-off — only the multiplier fed into the stake formula must be
derived from the *actual* payout of the currently configured barrier, not a disconnected
approximation.

**How to apply:** any UI or backend code suggesting/calibrating a recovery multiplier
must read the real payout for the selected barrier from the same payout table the
trading engine uses, not a standalone formula. Instant recovery mode should try the
settings' recoveryMultiplier stake first (same as Split's step 1) and only escalate to
the exact minimum stake needed (`unrecoveredAmount/netPayout × 1.02`) when that
multiplier isn't enough to fully cover the debt — never stake more than the debt
actually requires. See `computeDynamicStake()` in `recovery-engine.ts`.

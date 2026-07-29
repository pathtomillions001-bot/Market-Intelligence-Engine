---
name: Recovery auto-mode step multiplier formula
description: Auto-mode recovery uses a step-based geometric formula (K=0.777/netPayout), not full single-trade recovery. Analytics 500-trade fallback removed.
---

## Auto-mode recovery: step-based geometric formula

Instead of "recover everything in one shot" (`minRecovery = unrecoveredAmount/netPayout × 1.02`),
auto mode now uses a calibrated per-barrier step sequence in `computeDynamicStake()`:

```
K = 0.777
step1Mult  = min(K / netPayout, 15)   // e.g. 2.10× for OVER 3/UNDER 6 (net=0.37)
growthRatio = 1 + step1Mult            // e.g. 3.10 for OVER 3
absoluteMult = step1Mult × growthRatio^(recoveryStep - 1)
stake = baseStake × absoluteMult
```

Verified against user examples:
- OVER 3/UNDER 6 (net≈0.37): step1=2.10×, step2≈3.10× relative → stake ~$4.56 vs user's $4.50 ✓
- OVER 4/UNDER 5 (net≈0.457): step1=1.70×, step2≈2.70× relative

**Why K=0.777:** derived from user example "OVER 3/UNDER 6 step-1 multiplier = 2.1". Since 2.1 × 0.37 = 0.777, each win recovers ~77.7% of the initial base stake rather than 100% — allowing partial recovery over several wins instead of one enormous bet.

**Cap at 15×:** for near-zero net-payout barriers (DIGITDIFF, OVER 0/1) where K/net would be absurd (>15×), clamped at 15. The `maxExposure` cap provides a further safety backstop.

**Why not single-trade recovery:** the old formula caused greedy escalation (2.76×, 3.76×, 4.76×…) because it tried to cover the FULL accumulated debt in each step. The new formula accepts that recovery may span 2-3 wins; `unrecoveredAmount` shrinks naturally with each partial win.

## Analytics 500-trade oscillation fix

`getDerivTransactions()` in `trades.ts` previously fell back to `fetchDerivProfitTable(token, 500)` when the JournalManager cache was empty. This returned at most 500 trades, causing the UI to show 500 → then jump to the real full count once pagination completed.

**Fix:** removed the fallback entirely. Now returns `[]` when cache is empty and kicks `journalManager.forceRefresh()`. The next poll (5-10 s) gets the fully-paginated dataset. Also removed the now-unused `fetchDerivProfitTable` import from `trades.ts`.

**How to apply:** never add a single-shot `fetchDerivProfitTable` fallback back to `getDerivTransactions`. The journalManager is the sole paginated source; empty cache = brief loading state, not a stale 500-trade snapshot.

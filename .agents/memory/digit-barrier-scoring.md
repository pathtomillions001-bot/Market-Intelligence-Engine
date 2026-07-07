---
name: Digit barrier scoring and user-config policy
description: How DIGITOVER/DIGITUNDER barriers are selected, scored, and validated across the engine.
---

# Digit Barrier Scoring — User-Configured Barrier Policy

## Core principle
The AI does NOT pick a "better" barrier. It analyzes market conditions to find the best TIMING to enter the user's explicitly chosen barrier. The user configures normalOverDigit / normalUnderDigit (and recovery equivalents) in Settings.

## Scoring: relative favorability (NOT absolute edge)
Old scoring: `score = 50 + edge × 300` where edge = winP − 1/payout.
This collapsed to ~16 for any mid-range barrier (e.g. OVER 4) because the house edge means absolute EV is always negative.

New scoring: `score = 50 + (actualWinP − theoreticalWinP) × 400`
- theoreticalWinP = (9 − barrier) / 10 for OVER; barrier / 10 for UNDER
- relativeEdge > 0 → market currently favours this barrier → trade
- relativeEdge < 0 → market currently unfavourable → wait for better moment
- dataSufficiency dampener blends toward 50 when < 100 digits
- Hot/cold digit adjustment: ±2 pts per winning digit that is hot/cold

**Why:** A score of 50 = neutral (market at statistical baseline). Engine waits until conditions tilt positive for the user's chosen barrier.

## EV gate in master-decision.ts — barrier-characteristic-aware
Old: hardcoded checks for barriers 2, 7, 4, 5 specifically.
New: checks theoretical win rate of whatever the user chose:
- theoreticalWinRate ≥ 60% (high win rate): gate on edge > 0 (positive EV impossible due to payout structure)
- theoreticalWinRate 40–60% (mid-range): EV ≥ −0.15
- theoreticalWinRate < 40% (high payout): EV ≥ −0.06

**Why:** Hardcoded barriers silently ignored every user config other than OVER 2/UNDER 7 and OVER 4/UNDER 5.

## Valid barriers
- DIGITOVER: 0–8 (OVER 9 = 0% win, impossible — no digit > 9)
- DIGITUNDER: 1–9 (UNDER 0 = 0% win, impossible — no digit < 0)
Validation enforced in:
1. settings.ts PUT handler (returns 400 with clear message)
2. buildTradingSettings() in ai.ts (clamps as safety net)
3. buildBarrierOptions() in digit-probability.ts (validates, skips invalid)

## Barrier flow through the engine
1. ai.ts: `activeBarrierOverride = isInRecovery ? {OVER: recoveryOverDigit, UNDER: recoveryUnderDigit} : {OVER: normalOverDigit, UNDER: normalUnderDigit}`
2. overunder family scan context: `famCtx.recoveryBarrierOverride = activeBarrierOverride`
3. digit-probability.ts: `buildBarrierOptions(analysis, ctx.recoveryBarrierOverride)` — only evaluates user's exact barrier
4. coordinator → master-decision → recommendation.barrier = user's barrier all the way to execution

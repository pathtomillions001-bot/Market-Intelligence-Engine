---
name: No recovery mode
description: All recovery logic has been removed from the engine. After any loss the engine continues trading normally with the same barriers and stake.
---

## Rule
There is no recovery mode. After any loss the engine continues looking for trades normally — same OVER 2 / UNDER 7 barriers, same AI-recommended stake, no multiplying.

**Why:** User explicitly requested removal of all recovery logic: no stake multiplying, no barrier switching, no recovery dashboard card, no recovery SSE events.

**How to apply:**
- `recovery-intelligence.ts` — still runs as an informational agent in the 13-agent pipeline; always returns `mode: "normal"`, `recommendedStakeMultiplier: 1.0`. Do NOT restore mode switching.
- `ai.ts` — no `globalRecovery` state, no `updateDigitRecovery` calls, stake comes directly from `rec.stake`, `scheduleNext` fires normally after any loss
- `agent-coordinator.ts` — `updateDigitRecovery`, `setGlobalDigitRecovery`, `isInDigitRecovery` exports have been deleted
- `flash-card-3d.tsx` — no recovery UI; Quick Strike card shows normal trade info only
- `dashboard.tsx` — no recovery card, no recovery SSE listeners (`recovery_active`, `recovery_progress`, `recovery_complete`)
- `settings.tsx` — Recovery Mode card removed; DB field `recoveryMode` still exists but is not exposed in UI
- Cooldown and streak-limit settings remain in the UI and are still enforced by their existing code path

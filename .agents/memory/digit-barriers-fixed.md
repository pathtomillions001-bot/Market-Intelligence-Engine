---
name: Digit barriers fixed (OVER 2 / UNDER 7)
description: The engine now always uses OVER 2 and UNDER 7 barriers only; all tier-2 recovery barriers have been removed.
---

## Rule
The digit engine always uses OVER 2 / UNDER 7 as the only allowed barriers. No tier-2 (OVER 4 / UNDER 5) recovery barriers exist in the codebase.

**Why:** User requested removal of all recovery logic. Tier-1 safe barriers give ~70% win rates; tier-2 barriers existed only for post-loss recovery and have been eliminated.

**How to apply:**
- `digit-agent.ts` — `ALLOWED_OVER = Set([2])`, `ALLOWED_UNDER = Set([7])`; `scoreAllBarriers()` only iterates these sets
- `digit-probability.ts` — `ALLOWED_BARRIERS` also matches OVER 2 / UNDER 7
- `ev-calculator.ts` — `isDigitTier1Result` check uses `barrier === 2` or `barrier === 7` (not 8)
- Do NOT add OVER 4 / UNDER 5 back without also restoring the full recovery system

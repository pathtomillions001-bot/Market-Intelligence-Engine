---
name: Cross-contract recovery logic
description: How the AI engine switches contract types for loss recovery
---

Recovery state tracked in ai.ts module-level vars:
- lastLossContractType, lastLossBarrier, lastLossSymbol, lastLossAmount
- recoveryStep (incremented each consecutive loss when recoveryMode=true)

Recovery stake: `lossAmount / (payoutMultiplier - 1) * 1.1` — covers the loss + 10% margin, capped at maxTradeStake.

Alternative contract type selection (getAlternativeContractType):
- DIGITOVER → DIGITUNDER (barrier+2) or RISE if direction types are preferred
- DIGITUNDER → DIGITOVER (barrier-2) or RISE if direction types are preferred  
- RISE → FALL (or DIGITOVER if digit types preferred)
- FALL → RISE (or DIGITOVER if digit types preferred)
- CALL → PUT, PUT → CALL

Market selection in recovery mode: sorts by market win rate for the alternative contract type (weighted 30%) + quality score (70%).

Reset: on a win, all recovery state is cleared.

**Why:** User wanted agent to "switch to UNDER 5 or over 5" or "PUT/CALL" after a loss, rather than repeating the same contract that just lost.

**How to apply:** This logic is entirely in ai.ts autonomous loop. The recoveryMode setting must be enabled in DB/settings for it to activate.

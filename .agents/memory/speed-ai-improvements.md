---
name: SpeedAI engine improvements
description: FAB freeze fix, 1-tick execution latency overlap, recovery consecutive-loss gate
---

# SpeedAI Engine Improvements

## FAB freeze fix
**Rule:** Never call `setStatus` directly inside an SSE event handler — rapid server broadcasts during active trading cause back-to-back React re-renders inside `AnimatePresence` transitions, visually freezing the panel.

**How to apply:** Batch SSE status updates through `requestAnimationFrame` using a pending-ref pattern:
```ts
pendingStatusRef.current = data;
if (rafRef.current !== null) return;  // already queued
rafRef.current = requestAnimationFrame(() => {
  rafRef.current = null;
  setStatus(pendingStatusRef.current!);
});
```
Also: add `es.onerror = () => { es.close(); setTimeout(connect, 2000); }` for auto-reconnect. Poll at 3 s when panel is closed (badge), 1 s when open.

**Why:** Multiple SSE events per second + framer-motion layout animations = render storm.

## 1-tick execution: pre-analysis overlap
**Rule:** Market analysis (~50–200 ms) should run in parallel with the post-trade sleep, not sequentially before the next trade. Store the result in `preAnalyzedScored` and consume it at the top of the next iteration.

**How to apply:** After recording a trade outcome, kick off `analyzeMarketsForStrategy()` (or `scoreSingleMarket`) as a background promise, then `await sleep(500)`, then `await preAnalyzePromise` and store to `preAnalyzedScored`. Skip pre-analysis if the consecutive recovery gate will fire next iteration (it forces its own deep scan).

**Why:** Cuts scan latency from the critical path on every trade. The 500 ms pause gives Deriv WS breathing room while analysis completes in background.

## Recovery consecutive-loss gate
**Rule:** `SpeedRecoveryState` must track `consecutiveRecoveryLosses` (losses taken while ALREADY in recovery, not the initial entry loss). When this reaches ≥ 2, the next recovery trade requires a 3 s stabilisation pause + full deep rescan + score ≥ 65 before executing.

**How to apply:**
- `recordRecoveryOutcome`: on recovery loss increment `consecutiveRecoveryLosses`; on any recovery win or full recovery reset it to 0; on first loss entering recovery set it to 0 (normal trade, not a recovery trade).
- `runLoop` gate: `if (inRecovery && session.recovery.consecutiveRecoveryLosses >= 2)` → sleep 3000, rescan, require score ≥ 65 or skip iteration and sleep 4000 more.
- Log the event at `WARN` level for observability.

**Why:** Prevents 3 consecutive recovery losses. The gate forces the AI to wait for a genuinely high-confidence setup rather than trading into a losing market regime blindly.

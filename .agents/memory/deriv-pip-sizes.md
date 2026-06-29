---
name: Deriv market pipSizes
description: Correct pipSize values per symbol — wrong value causes extractLastDigit to always return 0
---

Verified from live prices:

| Symbol group | pipSize |
|---|---|
| R_10, R_100, 1HZ10V, 1HZ25V, 1HZ50V, 1HZ75V, 1HZ100V, all JD* | 2 |
| R_25 | **3** (price like 2592.726 — 3 decimal places) |
| R_50, R_75 | 4 |
| RDBULL, RDBEAR | 4 |

**Key distinction:** R_25 and 1HZ25V are NOT the same pip size!
- R_25: pipSize=3 (prices like 2592.726)
- 1HZ25V: pipSize=2 (prices like 830197.73 — only 2 significant decimal places despite being labeled 25-vol)

**Why:** extractLastDigit uses `Math.round(price * 10^pipSize) % 10`. Wrong pipSize causes the last digit to always be 0 (or wrong), skewing digit distribution to show 100% digit-0.

**How to apply:** When adding new symbols or fixing digit analysis bugs, verify pipSize from live Deriv WebSocket tick prices. The frontend market-detail.tsx pipSize calculation must match the backend DERIV_MARKETS definition in deriv.ts.

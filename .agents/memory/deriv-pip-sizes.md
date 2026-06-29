---
name: Deriv market pipSizes
description: Correct pipSize values per symbol — wrong value causes extractLastDigit to always return 0
---

Verified from live prices:

| Symbol group | pipSize |
|---|---|
| R_10, R_100, 1HZ10V, 1HZ100V, all JD* | 2 |
| R_25, 1HZ25V | **3** (corrected — previously documented as 2, was wrong) |
| R_50, R_75, 1HZ50V, 1HZ75V | 4 |
| RDBULL, RDBEAR | 4 |

**Why:** extractLastDigit uses `Math.round(price * 10^pipSize) % 10`. Wrong pipSize causes the last digit to always be 0 (or wrong), skewing digit distribution to show 100% digit-0.

**How to apply:** When adding new symbols or fixing digit analysis bugs, verify pipSize from live Deriv WebSocket tick prices. The frontend market-detail.tsx pipSize calculation must match the backend DERIV_MARKETS definition in deriv.ts.

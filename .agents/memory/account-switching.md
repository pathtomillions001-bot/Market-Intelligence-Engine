---
name: Account Switching
description: Multi-account support — how sub-accounts are stored, switched, and which account the engine uses.
---

## Rule
Exactly one row in the `accounts` table has `isActive = true` at any time. That row's `derivAccountId` (e.g. CR123456 or VRTC1234) is what gets loaded into the module-level `cachedAccountId` in `deriv.ts` on startup and after every switch.

## DB Schema change
Added `isActive boolean NOT NULL DEFAULT false` column to `lib/db/src/schema/accounts.ts`. Pushed via `pnpm --filter db push`.

## Backend routes (artifacts/api-server/src/routes/auth.ts)
- `GET /api/auth/accounts` — returns all linked accounts with live balances refreshed from Deriv
- `POST /api/auth/switch-account` body `{loginId}` — sets isActive=true for target, false for all others, calls `setDerivCredentials(bearerToken, derivAccountId)` which reconnects the JournalManager WS to the new account
- `GET /api/auth/account` — now filters `isActive=true` first, falls back to first row for backward compat
- OAuth callback (`POST /api/auth/oauth/callback`) — calls `getDerivAccounts()`, upserts EVERY sub-account as a separate row (all sharing the same bearerToken/refreshToken), marks only the preferred (real active) one as `isActive=true`

## API library changes
- `lib/api-client-react/src/generated/api.schemas.ts` — added `isActive?: boolean` to `DerivAccount`, new `SwitchAccountInput`
- `lib/api-client-react/src/generated/api.ts` — added `useGetAccounts`, `useSwitchAccount` hooks
- `lib/api-zod/src/generated/api.ts` — added `GetAccountsResponse`, `SwitchAccountBody`, `SwitchAccountResponse`

## Frontend
- `artifacts/trading-platform/src/components/account-switcher.tsx` — compact dropdown in sidebar footer; only renders when 2+ accounts exist; shows account type icon (Zap=real, FlaskConical=demo), loginId, type badge, balance; switches on click
- `artifacts/trading-platform/src/components/layout.tsx` — `<AccountSwitcher />` inserted above the Engine Mode switch in the bottom sidebar panel
- `artifacts/trading-platform/src/pages/connect.tsx` — "Active Account" card + "Switch Account" card listing all linked accounts; useGetAccounts + useSwitchAccount for the full-page switching flow

## getLiveBalance fix
Updated `artifacts/api-server/src/lib/deriv.ts` `getLiveBalance()` to match balance by `cachedAccountId` first, instead of always preferring the real account. This ensures balance shown after a switch reflects the newly active account.

**Why:** Deriv OAuth returns multiple sub-accounts (typically 1 real + 1 demo) in the same login. Storing only one meant the user was locked to whichever account the server picked at login time, with no way to switch without disconnecting and re-connecting.

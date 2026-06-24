# NeuroTrade — AI-Powered Trading Platform

AI-driven trading platform connected to Deriv's WebSocket API with 8-agent autonomous trading engine, real-time market scanning, and intelligent risk management.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080 → proxied at /api)
- `pnpm --filter @workspace/trading-platform run dev` — run the frontend (port 21210 → proxied at /)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite + TailwindCSS + Framer Motion + Recharts
- API: Express 5 (at `/api`)
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Deriv WebSocket API: `wss://ws.binaryws.com/websockets/v3?app_id=1089`

## Where things live

- `lib/api-spec/openapi.yaml` — Single source of truth for all API contracts
- `lib/db/src/schema/` — Drizzle ORM schema (accounts, trades, settings, ai_insights)
- `artifacts/api-server/src/routes/` — Express route handlers (auth, markets, trades, analytics, ai, settings)
- `artifacts/api-server/src/lib/ai-engine.ts` — 8-agent AI scoring system
- `artifacts/api-server/src/lib/deriv.ts` — Deriv WebSocket API client + market definitions
- `artifacts/trading-platform/src/` — React frontend (pages, components, hooks)

## Architecture decisions

- **Contract-first API**: OpenAPI spec → Orval codegen → typed React Query hooks + Zod server validators
- **AI engine in TypeScript**: 8-agent ML ensemble (Random Forest, Gradient Boosting, Logistic Regression for direction; Markov + Multinomial for digits). No EMA/RSI — avoids crowd indicators. Adaptive tick windows (30–200) for digit contracts.
- **Simulated trade outcomes**: When Deriv token is connected, prices come from real WebSocket ticks; without token, realistic price simulation is used; trade outcomes are probability-weighted by AI confidence score
- **Market rotation cache**: Market analyses cached for 30s per symbol, background refresh on demand
- **Self-learning**: Per-market win rates tracked in-memory using EMA (10% update weight), influencing future confidence scores

## Product

- **Dashboard**: Engine status (8 AI agents), top opportunity card, daily P&L, trades today
- **Markets**: All 33+ markets ranked by AI quality score — Synthetic, Forex, Commodities, Derived
- **Market Detail**: Individual market with price chart, full 8-agent score breakdown, AI recommendation
- **Trade Journal**: Complete trade history with win/loss, confidence, AI reasoning per trade
- **Analytics**: Performance curves, drawdown analysis, market breakdown, agent accuracy
- **Settings**: Risk profile (Conservative/Moderate/Aggressive), daily target, loss limits, drawdown protection, confidence thresholds, market rotation parameters
- **Connect**: Deriv API token connection screen

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Deriv WebSocket connection may timeout in 8s — code falls back to simulated prices automatically
- The `ws` package must be a `dependency` (not devDependency) since it's used at runtime in the bundled server
- Market analysis cache lives in-memory — restarts clear it; first requests will be slower as cache warms up
- Trade outcomes are simulated on the server (not real money movement without Deriv account integration)

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- Deriv API docs: https://api.deriv.com/
- To add real trade execution: implement the `buy` WebSocket command in `artifacts/api-server/src/lib/deriv.ts`

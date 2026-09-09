# FPL Signal Ethiopia 🇪🇹

**DATA • STRATEGY • SIGNAL**

Telegram-first Fantasy Premier League product for Ethiopian players: an Amharic Telegram bot, a Telegram Mini App, an Express API, and a PostgreSQL database scored from official FPL live data.

## Repository structure

```
artifacts/api-server           Express API + Telegram bot (long polling)
artifacts/fpl-signal-mini-app  Telegram Mini App (React + Vite, Amharic-first)
lib/db                         Drizzle ORM schema + migrations
lib/api-spec                   OpenAPI spec (source of truth for API)
lib/api-zod                    Generated Zod schemas (from OpenAPI)
lib/api-client-react           Generated React Query hooks (from OpenAPI)
scripts                        Workspace scripts
```

## Features

- 🏆 **Weekly Challenge** — one confirmed entry per account per gameweek
- 👥 **Squad Management** — 15-player squad, budget, position and club limits
- 🎯 **Starting XI** — formation validation, captain and vice-captain
- ✏️ **Team Editing** — re-submitting updates the same entry (no duplicates)
- ⚽ **Official FPL Points** — live scoring with captain boost, vice-captain fallback, automatic substitutions
- 📊 **Live Leaderboard** — ranked by official gameweek points
- 📡 **FPL Signal** — data-based observations (value, differentials, injury watch) with explicit disclaimers; no invented statistics, no guaranteed points
- 🔒 **Deadline Locking** — submissions blocked after the gameweek deadline

## Getting started

### Prerequisites

- Node.js 20+ and pnpm 10
- PostgreSQL database

### Installation

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
```

### Environment variables

Create `.env` (never commit it) with:

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot token from BotFather (server-side only) |
| `PORT` | ✅ | API server port |
| `MINI_APP_URL` | – | HTTPS Mini App URL (enables Telegram launch button) |
| `MINI_APP_ORIGIN` | – | Restricts CORS to the Mini App origin |
| `LOG_LEVEL` | – | Defaults to `info` |
| `GW_COMPETITION_PAID_ENABLED` | – | `true` enables the paid competition (needs legal review) |
| `GW_ENTRY_FEE_ETB` | – | Entry fee in ETB when paid mode is on |
| `GW_PRIZE_PERCENTAGES` | – | Prize split, e.g. `60,30,10` (must sum to 100) |
| `GW_ADMIN_API_TOKEN` | – | Bearer token for admin settlement endpoints |
| `CHAPA_*` | – | Chapa payment credentials (paid mode only) |
| `VITE_API_BASE_URL` | – | Mini App → API base URL when on different origins |
| `BASE_PATH` | – | Mini App base path (dev/preview) |

### Development

```bash
pnpm --filter @workspace/api-server run dev          # API server + bot
pnpm --filter @workspace/fpl-signal-mini-app run dev # Mini App (needs PORT + BASE_PATH)
pnpm --filter @workspace/db run push                 # apply schema changes (DEV ONLY)
pnpm --filter @workspace/api-spec run codegen        # regenerate API client + Zod schemas
```

## Tests

```bash
pnpm test
```

- `test:scoring` — captain double points, vice-captain fallback, bench-order automatic substitutions, formation rules, invalid squad/captain rejection, negative points
- `test:prizes` — prize distribution rounding, ties, remainder handling
- `test:signal` — signal engine honesty: no signals when data is unavailable, disclaimers always present
- `test:team-registration` — **integration test** against a real PostgreSQL (`TEST_DATABASE_URL`): first submission creates one entry, re-submission updates it in place, edits to captain/vice/starting XI persist. Skipped automatically when `TEST_DATABASE_URL` is not set.

CI runs the full suite with a PostgreSQL service (see `.github/workflows/validate.yml`).

## Database safety

- Never run `drizzle-kit push --force` against a shared/production database.
- Schema changes go through reviewed, additive migrations in `lib/db/migrations`.
- The test suite never touches production data: the integration test creates its own schema-scoped tables and drops them afterwards.

## Security

- Telegram Mini App requests are authenticated server-side by validating the
  signed `initData` HMAC (plus a 24-hour freshness window); the bot token never
  leaves the server.
- Admin endpoints require a `GW_ADMIN_API_TOKEN` bearer token compared in
  constant time.
- Chapa webhooks are verified with an HMAC signature over the raw body, and
  payment confirmation is idempotent (verified amounts, currency and reference).
- Secrets are read from environment variables only — never commit them.

## Language

User-facing text is Amharic-first (አማርኛ) with English brand and football terms where natural.

## License

MIT

# FPL Signal Ethiopia

An Amharic-first Telegram fantasy football bot where users register, build an FPL squad, choose a starting XI and captain, and lock their team.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required Secret: `TELEGRAM_BOT_TOKEN` — the bot token from BotFather

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/telegram/client.ts` — Telegram API client; provides `getUpdates` and `sendMessage`
- `artifacts/api-server/src/telegram/bot.ts` — Amharic bot flows, Weekly Challenge registration, leaderboard, and long-polling loop
- `artifacts/api-server/src/telegram/weekly-challenge.ts` — dynamic gameweek challenge identifiers and deadline locking
- `artifacts/api-server/src/telegram/scoring.ts` — official live FPL points, captain fallback, and automatic substitutions
- `lib/db/src/schema/index.ts` — Telegram users, selected squads, Starting XI IDs, captain/vice-captain persistence, and Weekly Challenge entries
- `artifacts/api-server/src/index.ts` — starts the HTTP API and Telegram polling

## Architecture decisions

- Telegram uses long polling, so no public webhook URL is required.
- The bot token is read only from the `TELEGRAM_BOT_TOKEN` Replit Secret.
- Existing FPL squad and validation logic remains server-side.

## Product

- Amharic Telegram registration and menu flows
- 15-player squad building with budget and position validation
- Starting XI formation validation, automatic substitutes, captain/vice-captain selection, and final team confirmation
- Weekly Challenge registration with one entry per account and a persistent leaderboard scored from official live FPL gameweek points
- Dynamic gameweek locking, manual leaderboard refresh, and periodic background score refresh

## User preferences

- Keep the Telegram interface beginner-friendly and in natural Amharic.
- Do not expose the Telegram bot token in source code.

## Gotchas

- Only one running API workflow should poll a given Telegram bot.
- The database must be provisioned before starting the API server.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

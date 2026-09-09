#!/bin/bash
# Post-merge convenience script: refresh dependencies and apply any new
# schema changes to the development database.
# NOTE: `drizzle-kit push` is a development-only command. It never runs in CI
# or production; schema changes in production go through reviewed migrations.
set -e
pnpm install --frozen-lockfile
pnpm --filter @workspace/db run push

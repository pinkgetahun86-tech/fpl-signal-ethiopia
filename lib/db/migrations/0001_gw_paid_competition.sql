CREATE TABLE IF NOT EXISTS "gw_competitions" (
  "id" text PRIMARY KEY NOT NULL,
  "gameweek" integer NOT NULL,
  "entry_fee_etb" integer DEFAULT 0 NOT NULL,
  "currency" varchar(3) DEFAULT 'ETB' NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "deadline_time" timestamp with time zone,
  "prize_pool_etb" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "gw_payments" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "competition_id" text NOT NULL REFERENCES "gw_competitions"("id"),
  "telegram_user_id" integer NOT NULL REFERENCES "telegram_users"("id"),
  "entry_id" integer NOT NULL REFERENCES "weekly_challenge_entries"("id"),
  "provider" text DEFAULT 'chapa' NOT NULL,
  "tx_ref" text NOT NULL UNIQUE,
  "provider_ref" text,
  "amount_etb" integer NOT NULL,
  "currency" varchar(3) DEFAULT 'ETB' NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "provider_status" text,
  "checkout_url" text,
  "verified_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "gw_payment_competition_user_unique" ON "gw_payments" ("competition_id", "telegram_user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "gw_payment_entry_unique" ON "gw_payments" ("entry_id");

CREATE TABLE IF NOT EXISTS "gw_prize_settlements" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "competition_id" text NOT NULL REFERENCES "gw_competitions"("id"),
  "telegram_user_id" integer NOT NULL REFERENCES "telegram_users"("id"),
  "entry_id" integer NOT NULL REFERENCES "weekly_challenge_entries"("id"),
  "rank" integer NOT NULL,
  "amount_etb" integer NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "payout_reference" text,
  "paid_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
DROP INDEX IF EXISTS "gw_prize_competition_rank_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "gw_prize_competition_entry_unique" ON "gw_prize_settlements" ("competition_id", "entry_id");

CREATE TABLE IF NOT EXISTS "gw_payment_events" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "tx_ref" text NOT NULL,
  "event_type" text NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "gw_payment_event_tx_type_unique" ON "gw_payment_events" ("tx_ref", "event_type");

CREATE INDEX IF NOT EXISTS "gw_payments_status_idx" ON "gw_payments" ("status");
CREATE INDEX IF NOT EXISTS "gw_entries_competition_status_idx" ON "weekly_challenge_entries" ("competition_id", "submission_status");

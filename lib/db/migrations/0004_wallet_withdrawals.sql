CREATE TABLE IF NOT EXISTS "wallet_withdrawals" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY NOT NULL,
  "wallet_account_id" integer NOT NULL,
  "telegram_user_id" integer NOT NULL,
  "method" text DEFAULT 'telebirr_manual' NOT NULL,
  "amount_etb" integer NOT NULL,
  "destination" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "payout_reference" text,
  "admin_note" text,
  "approved_at" timestamp with time zone,
  "rejected_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'wallet_withdrawals_wallet_account_id_wallet_accounts_id_fk'
  ) THEN
    ALTER TABLE "wallet_withdrawals"
      ADD CONSTRAINT "wallet_withdrawals_wallet_account_id_wallet_accounts_id_fk"
      FOREIGN KEY ("wallet_account_id")
      REFERENCES "wallet_accounts"("id")
      ON DELETE NO ACTION
      ON UPDATE NO ACTION;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'wallet_withdrawals_telegram_user_id_telegram_users_id_fk'
  ) THEN
    ALTER TABLE "wallet_withdrawals"
      ADD CONSTRAINT "wallet_withdrawals_telegram_user_id_telegram_users_id_fk"
      FOREIGN KEY ("telegram_user_id")
      REFERENCES "telegram_users"("id")
      ON DELETE NO ACTION
      ON UPDATE NO ACTION;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "wallet_withdrawals_user_created_idx"
  ON "wallet_withdrawals" ("telegram_user_id", "created_at");

CREATE INDEX IF NOT EXISTS "wallet_withdrawals_status_created_idx"
  ON "wallet_withdrawals" ("status", "created_at");

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_withdrawals_payout_reference_unique"
  ON "wallet_withdrawals" ("payout_reference")
  WHERE "payout_reference" IS NOT NULL;

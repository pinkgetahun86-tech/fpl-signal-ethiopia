CREATE TABLE IF NOT EXISTS "wallet_accounts" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "telegram_user_id" integer NOT NULL,
  "balance_etb" integer NOT NULL DEFAULT 0,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_accounts_telegram_user_id_fk"
    FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users" ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_account_user_unique"
  ON "wallet_accounts" ("telegram_user_id");

CREATE TABLE IF NOT EXISTS "wallet_transactions" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "wallet_account_id" integer NOT NULL,
  "telegram_user_id" integer NOT NULL,
  "type" text NOT NULL,
  "amount_etb" integer NOT NULL,
  "balance_after_etb" integer NOT NULL,
  "reference" text NOT NULL,
  "description" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_transactions_wallet_account_id_fk"
    FOREIGN KEY ("wallet_account_id") REFERENCES "wallet_accounts" ("id"),
  CONSTRAINT "wallet_transactions_telegram_user_id_fk"
    FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users" ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transactions_reference_unique"
  ON "wallet_transactions" ("reference");

CREATE TABLE IF NOT EXISTS "wallet_deposits" (
  "id" integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "wallet_account_id" integer NOT NULL,
  "telegram_user_id" integer NOT NULL,
  "method" text NOT NULL,
  "amount_etb" integer NOT NULL,
  "transaction_reference" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "admin_note" text,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "wallet_deposits_wallet_account_id_fk"
    FOREIGN KEY ("wallet_account_id") REFERENCES "wallet_accounts" ("id"),
  CONSTRAINT "wallet_deposits_telegram_user_id_fk"
    FOREIGN KEY ("telegram_user_id") REFERENCES "telegram_users" ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "wallet_deposits_transaction_reference_unique"
  ON "wallet_deposits" ("transaction_reference");

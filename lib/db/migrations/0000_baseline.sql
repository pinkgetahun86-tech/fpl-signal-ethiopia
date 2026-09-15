CREATE TABLE "gw_competitions" (
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
--> statement-breakpoint
CREATE TABLE "gw_payment_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gw_payment_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"tx_ref" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gw_payments" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gw_payments_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"competition_id" text NOT NULL,
	"telegram_user_id" integer NOT NULL,
	"entry_id" integer NOT NULL,
	"provider" text DEFAULT 'chapa' NOT NULL,
	"tx_ref" text NOT NULL,
	"provider_ref" text,
	"amount_etb" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'ETB' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_status" text,
	"checkout_url" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gw_payments_tx_ref_unique" UNIQUE("tx_ref")
);
--> statement-breakpoint
CREATE TABLE "gw_prize_settlements" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "gw_prize_settlements_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"competition_id" text NOT NULL,
	"telegram_user_id" integer NOT NULL,
	"entry_id" integer NOT NULL,
	"rank" integer NOT NULL,
	"amount_etb" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payout_reference" text,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_users" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "telegram_users_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"telegram_chat_id" varchar(64) NOT NULL,
	"first_name" text,
	"username" text,
	"flow_state" text DEFAULT 'new' NOT NULL,
	"selected_player_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starting_player_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"captain_player_id" integer,
	"vice_captain_player_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_users_telegram_chat_id_unique" UNIQUE("telegram_chat_id")
);
--> statement-breakpoint
CREATE TABLE "weekly_challenge_entries" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "weekly_challenge_entries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"telegram_user_id" integer NOT NULL,
	"competition_id" text NOT NULL,
	"gameweek" integer NOT NULL,
	"selected_player_ids" jsonb NOT NULL,
	"starting_player_ids" jsonb NOT NULL,
	"bench_player_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"captain_player_id" integer NOT NULL,
	"vice_captain_player_id" integer,
	"submission_status" text DEFAULT 'confirmed' NOT NULL,
	"points" integer DEFAULT 0 NOT NULL,
	"points_source" text DEFAULT 'placeholder' NOT NULL,
	"scored_player_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_points_updated_at" timestamp with time zone,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gw_payments" ADD CONSTRAINT "gw_payments_competition_id_gw_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."gw_competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gw_payments" ADD CONSTRAINT "gw_payments_telegram_user_id_telegram_users_id_fk" FOREIGN KEY ("telegram_user_id") REFERENCES "public"."telegram_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gw_payments" ADD CONSTRAINT "gw_payments_entry_id_weekly_challenge_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."weekly_challenge_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gw_prize_settlements" ADD CONSTRAINT "gw_prize_settlements_competition_id_gw_competitions_id_fk" FOREIGN KEY ("competition_id") REFERENCES "public"."gw_competitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gw_prize_settlements" ADD CONSTRAINT "gw_prize_settlements_telegram_user_id_telegram_users_id_fk" FOREIGN KEY ("telegram_user_id") REFERENCES "public"."telegram_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gw_prize_settlements" ADD CONSTRAINT "gw_prize_settlements_entry_id_weekly_challenge_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."weekly_challenge_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weekly_challenge_entries" ADD CONSTRAINT "weekly_challenge_entries_telegram_user_id_telegram_users_id_fk" FOREIGN KEY ("telegram_user_id") REFERENCES "public"."telegram_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gw_payment_event_tx_type_unique" ON "gw_payment_events" USING btree ("tx_ref","event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "gw_payment_competition_user_unique" ON "gw_payments" USING btree ("competition_id","telegram_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gw_payment_entry_unique" ON "gw_payments" USING btree ("entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gw_prize_competition_entry_unique" ON "gw_prize_settlements" USING btree ("competition_id","entry_id");--> statement-breakpoint
CREATE UNIQUE INDEX "weekly_challenge_user_competition_unique" ON "weekly_challenge_entries" USING btree ("telegram_user_id","competition_id");
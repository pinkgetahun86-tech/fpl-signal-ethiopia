import {
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

export const telegramUsers = pgTable("telegram_users", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  telegramChatId: varchar("telegram_chat_id", { length: 64 }).notNull().unique(),
  firstName: text("first_name"),
  username: text("username"),
  flowState: text("flow_state").notNull().default("new"),
  selectedPlayerIds: jsonb("selected_player_ids")
    .$type<number[]>()
    .notNull()
    .default([]),
  startingPlayerIds: jsonb("starting_player_ids")
    .$type<number[]>()
    .notNull()
    .default([]),
  captainPlayerId: integer("captain_player_id"),
  viceCaptainPlayerId: integer("vice_captain_player_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const weeklyChallengeEntries = pgTable(
  "weekly_challenge_entries",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    telegramUserId: integer("telegram_user_id")
      .notNull()
      .references(() => telegramUsers.id),
    competitionId: text("competition_id").notNull(),
    gameweek: integer("gameweek").notNull(),
    selectedPlayerIds: jsonb("selected_player_ids")
      .$type<number[]>()
      .notNull(),
    startingPlayerIds: jsonb("starting_player_ids")
      .$type<number[]>()
      .notNull(),
    benchPlayerIds: jsonb("bench_player_ids")
      .$type<number[]>()
      .notNull()
      .default([]),
    captainPlayerId: integer("captain_player_id").notNull(),
    viceCaptainPlayerId: integer("vice_captain_player_id"),
    submissionStatus: text("submission_status").notNull().default("confirmed"),
    points: integer("points").notNull().default(0),
    pointsSource: text("points_source").notNull().default("placeholder"),
    scoredPlayerIds: jsonb("scored_player_ids")
      .$type<number[]>()
      .notNull()
      .default([]),
    lastPointsUpdatedAt: timestamp("last_points_updated_at", { withTimezone: true }),
    registeredAt: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userCompetitionUnique: uniqueIndex("weekly_challenge_user_competition_unique").on(
      table.telegramUserId,
      table.competitionId,
    ),
  }),
);

export type TelegramUser = typeof telegramUsers.$inferSelect;
export type WeeklyChallengeEntry = typeof weeklyChallengeEntries.$inferSelect;

export const gwCompetitions = pgTable(
  "gw_competitions",
  {
    id: text("id").primaryKey(),
    gameweek: integer("gameweek").notNull(),
    entryFeeEtb: integer("entry_fee_etb").notNull().default(0),
    currency: varchar("currency", { length: 3 }).notNull().default("ETB"),
    status: text("status").notNull().default("open"),
    deadlineTime: timestamp("deadline_time", { withTimezone: true }),
    prizePoolEtb: integer("prize_pool_etb").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const gwPayments = pgTable(
  "gw_payments",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    competitionId: text("competition_id")
      .notNull()
      .references(() => gwCompetitions.id),
    telegramUserId: integer("telegram_user_id")
      .notNull()
      .references(() => telegramUsers.id),
    entryId: integer("entry_id")
      .notNull()
      .references(() => weeklyChallengeEntries.id),
    provider: text("provider").notNull().default("chapa"),
    txRef: text("tx_ref").notNull().unique(),
    providerRef: text("provider_ref"),
    amountEtb: integer("amount_etb").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("ETB"),
    status: text("status").notNull().default("pending"),
    providerStatus: text("provider_status"),
    checkoutUrl: text("checkout_url"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    competitionUserUnique: uniqueIndex("gw_payment_competition_user_unique").on(
      table.competitionId,
      table.telegramUserId,
    ),
    entryUnique: uniqueIndex("gw_payment_entry_unique").on(table.entryId),
  }),
);

export const gwPrizeSettlements = pgTable(
  "gw_prize_settlements",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    competitionId: text("competition_id")
      .notNull()
      .references(() => gwCompetitions.id),
    telegramUserId: integer("telegram_user_id")
      .notNull()
      .references(() => telegramUsers.id),
    entryId: integer("entry_id")
      .notNull()
      .references(() => weeklyChallengeEntries.id),
    rank: integer("rank").notNull(),
    amountEtb: integer("amount_etb").notNull(),
    status: text("status").notNull().default("pending"),
    payoutReference: text("payout_reference"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    competitionEntryUnique: uniqueIndex("gw_prize_competition_entry_unique").on(
      table.competitionId,
      table.entryId,
    ),
  }),
);

export const gwPaymentEvents = pgTable(
  "gw_payment_events",
  {
    id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
    txRef: text("tx_ref").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    txEventUnique: uniqueIndex("gw_payment_event_tx_type_unique").on(
      table.txRef,
      table.eventType,
    ),
  }),
);

export type GwCompetition = typeof gwCompetitions.$inferSelect;
export type GwPayment = typeof gwPayments.$inferSelect;
export type GwPrizeSettlement = typeof gwPrizeSettlements.$inferSelect;

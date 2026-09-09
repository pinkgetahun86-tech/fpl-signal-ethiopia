DROP INDEX IF EXISTS "gw_prize_competition_rank_unique";
CREATE UNIQUE INDEX IF NOT EXISTS "gw_prize_competition_entry_unique" ON "gw_prize_settlements" ("competition_id", "entry_id");

UPDATE "weekly_challenge_entries" AS e
SET
  "submission_status" = 'awaiting_payment',
  "updated_at" = now()
WHERE
  e."competition_id" = 'weekly-challenge-gw-6'
  AND e."telegram_user_id" IN (1, 4)
  AND e."submission_status" = 'confirmed'
  AND NOT EXISTS (
    SELECT 1
    FROM "wallet_transactions" AS wt
    WHERE
      wt."type" = 'entry_fee'
      AND wt."reference" =
        'gw-entry:' || e."competition_id" || ':' || e."telegram_user_id"
  );

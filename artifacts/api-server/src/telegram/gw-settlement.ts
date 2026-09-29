import { and, asc, desc, eq, sql } from "drizzle-orm";
import {
  db,
  gwCompetitions,
  gwPayments,
  gwPrizeSettlements,
  weeklyChallengeEntries,
  walletAccounts,
  walletTransactions,
} from "@workspace/db";
import {
  getCurrentGameweek,
  getGameweek,
} from "./fpl";
import { refreshChallengeScores } from "./bot";
import { type WeeklyChallenge } from "./weekly-challenge";
import { calculateTop20PrizeShares } from "./prize-distribution";

type DbTransaction =
  Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function syncCompetitionLifecycle(
  challenge: WeeklyChallenge,
): Promise<string> {
  const competition = await db
    .select()
    .from(gwCompetitions)
    .where(eq(gwCompetitions.id, challenge.competitionId))
    .limit(1)
    .then((r) => r[0]);

  if (!competition) return "missing";

  if (
    competition.status === "settled" ||
    competition.status === "cancelled"
  ) {
    return competition.status;
  }

  /*
   * Always inspect the competition's own FPL gameweek.
   *
   * Do not use getCurrentGameweek() here because FPL can
   * already have advanced to the next gameweek while this
   * competition still needs to be locked/settled.
   */
  const fpl = await getGameweek(
    competition.gameweek,
  );

  const shouldBeLocked =
    fpl.finished ||
    (
      fpl.deadlineTime !== null &&
      Date.now() >=
        fpl.deadlineTime.getTime()
    );

  if (
    shouldBeLocked &&
    competition.status === "open"
  ) {
    await db
      .update(gwCompetitions)
      .set({
        status: "locked",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(
            gwCompetitions.id,
            competition.id,
          ),
          eq(
            gwCompetitions.status,
            "open",
          ),
        ),
      );

    return "locked";
  }

  if (!shouldBeLocked) {
    return competition.status;
  }

  return competition.status;
}

  return challenge.locked ? "locked" : "open";
}

/**
 * Credits one prize settlement to the winner wallet
 * using an existing database transaction.
 *
 * Safety guarantees:
 * - same settlement cannot be paid twice
 * - wallet balance increment is atomic
 * - concurrent payout attempts are serialized
 * - wallet ledger and settlement status are one transaction
 * - deterministic ledger reference prevents duplicate credit
 */
async function creditPrizeSettlementTx(
  tx: DbTransaction,
  settlement: typeof gwPrizeSettlements.$inferSelect,
  payoutReference: string,
) {
  const cleanPayoutReference =
    payoutReference.trim();

  if (!cleanPayoutReference) {
    throw new Error("Payout reference is required");
  }

  await tx.execute(
  sql`select pg_advisory_xact_lock(
    hashtext(${`fpl-prize-settlement:${settlement.id}`})
  )`,
);

await tx.execute(
  sql`select pg_advisory_xact_lock(
    hashtext(${`fpl-prize-payout-reference:${cleanPayoutReference}`})
  )`,
);

const existingPayoutReference = await tx
  .select({ id: gwPrizeSettlements.id })
  .from(gwPrizeSettlements)
  .where(
    eq(
      gwPrizeSettlements.payoutReference,
      cleanPayoutReference,
    ),
  )
  .limit(1)
  .then((rows) => rows[0]);

if (
  existingPayoutReference &&
  existingPayoutReference.id !== settlement.id
) {
  throw new Error(
    "Payout reference has already been used",
  );
}

  const currentSettlement = await tx
    .select()
    .from(gwPrizeSettlements)
    .where(
      eq(
        gwPrizeSettlements.id,
        settlement.id,
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);

  if (!currentSettlement) {
    throw new Error(
      "Prize settlement not found",
    );
  }

  if (currentSettlement.status === "paid") {
    return currentSettlement;
  }

  if (currentSettlement.status !== "pending") {
    throw new Error(
      "Prize settlement is not pending",
    );
  }

  if (
    !Number.isSafeInteger(
      currentSettlement.amountEtb,
    ) ||
    currentSettlement.amountEtb <= 0
  ) {
    throw new Error("Invalid prize amount");
  }

  await tx
    .insert(walletAccounts)
    .values({
      telegramUserId:
        currentSettlement.telegramUserId,
      balanceEtb: 0,
    })
    .onConflictDoNothing({
      target:
        walletAccounts.telegramUserId,
    });

  const wallet = await tx
    .select()
    .from(walletAccounts)
    .where(
      eq(
        walletAccounts.telegramUserId,
        currentSettlement.telegramUserId,
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);

  if (!wallet) {
    throw new Error(
      "Winner wallet could not be created",
    );
  }

  /*
   * The settlement ID is the permanent idempotency key.
   *
   * Never create a different wallet ledger reference
   * for the same settlement.
   */
  const ledgerReference =
    `gw-prize:${currentSettlement.id}`;

  const existingLedger = await tx
    .select()
    .from(walletTransactions)
    .where(
      eq(
        walletTransactions.reference,
        ledgerReference,
      ),
    )
    .limit(1)
    .then((rows) => rows[0]);

  /*
   * If the ledger already exists, the wallet was already
   * credited successfully.
   *
   * Do NOT increase the wallet balance again.
   */
  if (existingLedger) {
    const paid = await tx
      .update(gwPrizeSettlements)
      .set({
        status: "paid",
        payoutReference:
          currentSettlement.payoutReference ??
          cleanPayoutReference,
        paidAt:
          currentSettlement.paidAt ??
          new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(
            gwPrizeSettlements.id,
            currentSettlement.id,
          ),
          eq(
            gwPrizeSettlements.status,
            "pending",
          ),
        ),
      )
      .returning();

    return paid[0] ?? currentSettlement;
  }

  /*
   * IMPORTANT:
   *
   * Never calculate:
   *
   *   newBalance = wallet.balanceEtb + amount
   *
   * in application code.
   *
   * PostgreSQL performs:
   *
   *   balance = balance + prize
   *
   * atomically.
   */
  const updatedWallet = await tx
    .update(walletAccounts)
    .set({
      balanceEtb:
        sql`${walletAccounts.balanceEtb} + ${currentSettlement.amountEtb}`,
      updatedAt: new Date(),
    })
    .where(
      eq(
        walletAccounts.id,
        wallet.id,
      ),
    )
    .returning({
      id: walletAccounts.id,
      balanceEtb:
        walletAccounts.balanceEtb,
    });

  if (!updatedWallet[0]) {
    throw new Error(
      "Winner wallet balance could not be updated",
    );
  }

  const balanceAfterEtb =
    updatedWallet[0].balanceEtb;

  await tx
    .insert(walletTransactions)
    .values({
      walletAccountId:
        wallet.id,
      telegramUserId:
        currentSettlement.telegramUserId,
      type: "prize",
      amountEtb:
        currentSettlement.amountEtb,
      balanceAfterEtb,
      reference:
        ledgerReference,
      description:
        "የFPL Signal Ethiopia ውድድር ሽልማት",
    })
    .onConflictDoNothing({
      target:
        walletTransactions.reference,
    });

  const paid = await tx
    .update(gwPrizeSettlements)
    .set({
      status: "paid",
      payoutReference:
        cleanPayoutReference,
      paidAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(
          gwPrizeSettlements.id,
          currentSettlement.id,
        ),
        eq(
          gwPrizeSettlements.status,
          "pending",
        ),
      ),
    )
    .returning();

  if (!paid[0]) {
    throw new Error(
      "Prize settlement could not be marked paid",
    );
  }

  return paid[0];
}

export async function finalizeCompetition(
  competitionId: string,
): Promise<{
  status: string;
  winners: number;
}> {
  const competition = await db
    .select()
    .from(gwCompetitions)
    .where(eq(gwCompetitions.id, competitionId))
    .limit(1)
    .then((r) => r[0]);

  if (!competition) {
    throw new Error("Competition not found");
  }

  if (competition.status === "settled") {
    return {
      status: "settled",
      winners: await db
        .select({
          count: sql<number>`count(*)`,
        })
        .from(gwPrizeSettlements)
        .where(
          eq(
            gwPrizeSettlements.competitionId,
            competitionId,
          ),
        )
        .then((r) =>
          Number(r[0]?.count ?? 0),
        ),
    };
  }

    const fpl = await getGameweek(
    competition.gameweek,
  );

  if (!fpl.finished) {
    throw new Error(
      "የዚህ የጨዋታ ሳምንት ውጤት ገና አልተጠናቀቀም።",
    );
  }
  if (competition.status === "open") {
    throw new Error(
      "ውድድሩ ገና አልተዘጋም።",
    );
  }

  /*
   * Refresh the final FPL scores BEFORE opening the
   * settlement transaction.
   *
   * refreshChallengeScores() uses the application-level
   * database connection, so it must not run from inside
   * the settlement transaction.
   *
   * The settlement transaction below re-reads the entries
   * after this refresh has completed.
   */
  await refreshChallengeScores(
  {
    competitionId: competition.id,
    gameweek: competition.gameweek,
    deadlineTime: competition.deadlineTime,
    locked: true,
  },
  true,
);

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(${`fpl-gw-finalize:${competitionId}`})
      )`,
    );

    const lockedCompetition = await tx
      .select()
      .from(gwCompetitions)
      .where(
        eq(
          gwCompetitions.id,
          competitionId,
        ),
      )
      .limit(1)
      .then((r) => r[0]);

    if (!lockedCompetition) {
      throw new Error(
        "Competition not found",
      );
    }

    if (
      lockedCompetition.status ===
      "settled"
    ) {
      return;
    }

    if (
      lockedCompetition.status ===
      "open"
    ) {
      throw new Error(
        "ውድድሩ ገና አልተዘጋም።",
      );
    }

    const pendingPayments =
      await tx
        .select({
          count: sql<number>`count(*)`,
        })
        .from(gwPayments)
        .where(
          and(
            eq(
              gwPayments.competitionId,
              competitionId,
            ),
            eq(
              gwPayments.status,
              "pending",
            ),
          ),
        )
        .then((r) =>
          Number(r[0]?.count ?? 0),
        );

    if (pendingPayments > 0) {
      throw new Error(
        `ከ${pendingPayments} ተሳታፊ(ዎች) የሚመጣ ክፍያ ገና አልተረጋገጠም። ከመጨረሻ ውሳኔ በፊት ክፍያዎቹን ያረጋግጡ።`,
      );
    }

    const entries = await tx
      .select()
      .from(weeklyChallengeEntries)
      .where(
        and(
          eq(
            weeklyChallengeEntries.competitionId,
            competitionId,
          ),
          eq(
            weeklyChallengeEntries.submissionStatus,
            "confirmed",
          ),
        ),
      )
      .orderBy(
        desc(
          weeklyChallengeEntries.points,
        ),
        asc(
          weeklyChallengeEntries.registeredAt,
        ),
        asc(
          weeklyChallengeEntries.id,
        ),
      );

    if (entries.length === 0) {
      await tx
        .update(gwCompetitions)
        .set({
          status: "settled",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(
              gwCompetitions.id,
              competitionId,
            ),
            eq(
              gwCompetitions.status,
              "locked",
            ),
          ),
        );

      return;
    }

    const shares =
      calculateTop20PrizeShares(
        lockedCompetition.prizePoolEtb,
        entries.map((entry) => ({
          entryId: entry.id,
          telegramUserId:
            entry.telegramUserId,
          points: entry.points,
        })),
      );

    const rows: Array<
      typeof gwPrizeSettlements.$inferInsert
    > = shares
      .filter(
        (share) =>
          share.amountEtb > 0,
      )
      .map((share) => ({
        competitionId,
        telegramUserId:
          share.telegramUserId,
        entryId: share.entryId,
        rank: share.rank,
        amountEtb:
          share.amountEtb,
        status: "pending",
      }));

    /*
     * Every winner is processed inside this SAME
     * database transaction:
     *
     * 1. Create settlement
     * 2. Create/get winner wallet
     * 3. Credit wallet atomically
     * 4. Create wallet ledger
     * 5. Mark settlement paid
     * 6. Only then mark competition settled
     *
     * If any winner fails, the whole transaction rolls back.
     */
    for (const row of rows) {
      const inserted =
        await tx
          .insert(gwPrizeSettlements)
          .values(row)
          .onConflictDoNothing({
            target: [
              gwPrizeSettlements.competitionId,
              gwPrizeSettlements.entryId,
            ],
          })
          .returning();

      let settlement =
        inserted[0];

      /*
       * If the settlement already exists,
       * retrieve it rather than creating a duplicate.
       */
      if (!settlement) {
        settlement =
          await tx
            .select()
            .from(
              gwPrizeSettlements,
            )
            .where(
              and(
                eq(
                  gwPrizeSettlements.competitionId,
                  competitionId,
                ),
                eq(
                  gwPrizeSettlements.entryId,
                  row.entryId,
                ),
              ),
            )
            .limit(1)
            .then(
              (result) =>
                result[0],
            );
      }

      if (!settlement) {
        throw new Error(
          "Prize settlement could not be created",
        );
      }

      /*
       * Deterministic automatic payout reference.
       *
       * The actual wallet ledger idempotency key remains:
       * gw-prize:<settlementId>
       */
      await creditPrizeSettlementTx(
        tx,
        settlement,
        `auto:gw-prize:${settlement.id}`,
      );
    }

    await tx
      .update(gwCompetitions)
      .set({
        status: "settled",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(
            gwCompetitions.id,
            competitionId,
          ),
          eq(
            gwCompetitions.status,
            "locked",
          ),
        ),
      );
  });

  return {
    status: "settled",
    winners: await db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(gwPrizeSettlements)
      .where(
        eq(
          gwPrizeSettlements.competitionId,
          competitionId,
        ),
      )
      .then((r) =>
        Number(r[0]?.count ?? 0),
      ),
  };
}

/**
 * Manually/admin credits one prize settlement.
 *
 * This remains available for:
 * - previously-created pending settlements
 * - administrative recovery
 * - manual payout workflows
 *
 * Automatic finalization uses the same underlying
 * creditPrizeSettlementTx helper.
 */
export async function markPrizePaid(
  settlementId: number,
  payoutReference: string,
) {
  const cleanPayoutReference =
    payoutReference.trim();

  if (!cleanPayoutReference) {
    throw new Error(
      "Payout reference is required",
    );
  }

  return db.transaction(
    async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(
          hashtext(${`fpl-prize-settlement:${settlementId}`})
        )`,
      );

      const settlement =
        await tx
          .select()
          .from(
            gwPrizeSettlements,
          )
          .where(
            eq(
              gwPrizeSettlements.id,
              settlementId,
            ),
          )
          .limit(1)
          .then(
            (rows) =>
              rows[0],
          );

      if (!settlement) {
        throw new Error(
          "Prize settlement not found",
        );
      }

      if (
        settlement.status ===
        "paid"
      ) {
        return settlement;
      }

      if (
        settlement.status !==
        "pending"
      ) {
        throw new Error(
          "Prize settlement is not pending",
        );
      }

      return creditPrizeSettlementTx(
        tx,
        settlement,
        cleanPayoutReference,
      );
    },
  );
}

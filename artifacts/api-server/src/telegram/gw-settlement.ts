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
import { getCurrentGameweek } from "./fpl";
import { refreshChallengeScores } from "./bot";
import { type WeeklyChallenge } from "./weekly-challenge";
import { calculateTop20PrizeShares } from "./prize-distribution";

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

  const fpl = await getCurrentGameweek();

  if (fpl.id !== competition.gameweek) {
    return competition.status;
  }

  if (!challenge.locked && competition.status !== "open") {
    await db
      .update(gwCompetitions)
      .set({
        status: "open",
        updatedAt: new Date(),
      })
      .where(eq(gwCompetitions.id, competition.id));

    return "open";
  }

  if (challenge.locked && competition.status === "open") {
    await db
      .update(gwCompetitions)
      .set({
        status: "locked",
        updatedAt: new Date(),
      })
      .where(eq(gwCompetitions.id, competition.id));
  }

  return challenge.locked ? "locked" : "open";
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
        .where(eq(gwPrizeSettlements.competitionId, competitionId))
        .then((r) => Number(r[0]?.count ?? 0)),
    };
  }

  const fpl = await getCurrentGameweek();

  if (fpl.id === competition.gameweek && !fpl.finished) {
    throw new Error(
      "የዚህ የጨዋታ ሳምንት ውጤት ገና አልተጠናቀቀም።",
    );
  }

  if (competition.status === "open") {
    throw new Error("ውድድሩ ገና አልተዘጋም።");
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(${`fpl-gw-finalize:${competitionId}`})
      )`,
    );

    const lockedCompetition = await tx
      .select()
      .from(gwCompetitions)
      .where(eq(gwCompetitions.id, competitionId))
      .limit(1)
      .then((r) => r[0]);

    if (!lockedCompetition) {
      throw new Error("Competition not found");
    }

    if (lockedCompetition.status === "settled") {
      return;
    }

    if (lockedCompetition.status === "open") {
      throw new Error("ውድድሩ ገና አልተዘጋም።");
    }

    const pendingPayments = await tx
      .select({
        count: sql<number>`count(*)`,
      })
      .from(gwPayments)
      .where(
        and(
          eq(gwPayments.competitionId, competitionId),
          eq(gwPayments.status, "pending"),
        ),
      )
      .then((r) => Number(r[0]?.count ?? 0));

    if (pendingPayments > 0) {
      throw new Error(
        `ከ${pendingPayments} ተሳታፊ(ዎች) የሚመጣ ክፍያ ገና አልተረጋገጠም። ከመጨረሻ ውሳኔ በፊት ክፍያዎቹን ያረጋግጡ።`,
      );
    }

    const challenge: WeeklyChallenge = {
      competitionId,
      gameweek: lockedCompetition.gameweek,
      deadlineTime: lockedCompetition.deadlineTime,
      locked: true,
    };

    await refreshChallengeScores(challenge);

    const entries = await tx
      .select()
      .from(weeklyChallengeEntries)
      .where(
        and(
          eq(weeklyChallengeEntries.competitionId, competitionId),
          eq(
            weeklyChallengeEntries.submissionStatus,
            "confirmed",
          ),
        ),
      )
      .orderBy(
        desc(weeklyChallengeEntries.points),
        asc(weeklyChallengeEntries.registeredAt),
        asc(weeklyChallengeEntries.id),
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
            eq(gwCompetitions.id, competitionId),
            eq(gwCompetitions.status, "locked"),
          ),
        );

      return;
    }

    const shares = calculateTop20PrizeShares(
      lockedCompetition.prizePoolEtb,
      entries.map((entry) => ({
        entryId: entry.id,
        telegramUserId: entry.telegramUserId,
        points: entry.points,
      })),
    );

    const rows: Array<
      typeof gwPrizeSettlements.$inferInsert
    > = shares
      .filter((share) => share.amountEtb > 0)
      .map((share) => ({
        competitionId,
        telegramUserId: share.telegramUserId,
        entryId: share.entryId,
        rank: share.rank,
        amountEtb: share.amountEtb,
        status: "pending",
      }));

    for (const row of rows) {
      await tx
        .insert(gwPrizeSettlements)
        .values(row)
        .onConflictDoNothing({
          target: [
            gwPrizeSettlements.competitionId,
            gwPrizeSettlements.entryId,
          ],
        });
    }

    await tx
      .update(gwCompetitions)
      .set({
        status: "settled",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gwCompetitions.id, competitionId),
          eq(gwCompetitions.status, "locked"),
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
      .where(eq(gwPrizeSettlements.competitionId, competitionId))
      .then((r) => Number(r[0]?.count ?? 0)),
  };
}

/**
 * Credits one prize settlement to the winner wallet.
 *
 * Safety guarantees:
 * - same settlement cannot be paid twice
 * - wallet balance increment is atomic
 * - different prizes for the same wallet cannot overwrite
 *   each other's balance
 * - wallet ledger and settlement status are one transaction
 */
export async function markPrizePaid(
  settlementId: number,
  payoutReference: string,
) {
  const cleanPayoutReference = payoutReference.trim();

  if (!cleanPayoutReference) {
    throw new Error("Payout reference is required");
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(${`fpl-prize-settlement:${settlementId}`})
      )`,
    );

    const settlement = await tx
      .select()
      .from(gwPrizeSettlements)
      .where(eq(gwPrizeSettlements.id, settlementId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!settlement) {
      throw new Error("Prize settlement not found");
    }

    if (settlement.status === "paid") {
      return settlement;
    }

    if (settlement.status !== "pending") {
      throw new Error("Prize settlement is not pending");
    }

    if (
      !Number.isSafeInteger(settlement.amountEtb) ||
      settlement.amountEtb <= 0
    ) {
      throw new Error("Invalid prize amount");
    }

    await tx
      .insert(walletAccounts)
      .values({
        telegramUserId: settlement.telegramUserId,
        balanceEtb: 0,
      })
      .onConflictDoNothing({
        target: walletAccounts.telegramUserId,
      });

    const wallet = await tx
      .select()
      .from(walletAccounts)
      .where(
        eq(
          walletAccounts.telegramUserId,
          settlement.telegramUserId,
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!wallet) {
      throw new Error("Winner wallet could not be created");
    }

    const ledgerReference = `gw-prize:${settlementId}`;

    const existingLedger = await tx
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.reference, ledgerReference))
      .limit(1)
      .then((rows) => rows[0]);

    if (existingLedger) {
      const paid = await tx
        .update(gwPrizeSettlements)
        .set({
          status: "paid",
          payoutReference: cleanPayoutReference,
          paidAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(gwPrizeSettlements.id, settlementId),
            eq(gwPrizeSettlements.status, "pending"),
          ),
        )
        .returning();

      return paid[0] ?? settlement;
    }

    /*
     * IMPORTANT:
     *
     * Do NOT calculate:
     *   newBalance = wallet.balanceEtb + amount
     *   then write that value.
     *
     * Two different prizes could otherwise read the same
     * balance and overwrite one another.
     *
     * Instead PostgreSQL performs:
     *   balance = balance + prize
     *
     * atomically.
     */
    const updatedWallet = await tx
      .update(walletAccounts)
      .set({
        balanceEtb: sql`${walletAccounts.balanceEtb} + ${settlement.amountEtb}`,
        updatedAt: new Date(),
      })
      .where(eq(walletAccounts.id, wallet.id))
      .returning({
        id: walletAccounts.id,
        balanceEtb: walletAccounts.balanceEtb,
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
        walletAccountId: wallet.id,
        telegramUserId: settlement.telegramUserId,
        type: "prize",
        amountEtb: settlement.amountEtb,
        balanceAfterEtb,
        reference: ledgerReference,
        description:
          `GW${settlement.competitionId} የውድድር ሽልማት`,
      })
      .onConflictDoNothing({
        target: walletTransactions.reference,
      });

    const paid = await tx
      .update(gwPrizeSettlements)
      .set({
        status: "paid",
        payoutReference: cleanPayoutReference,
        paidAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(gwPrizeSettlements.id, settlementId),
          eq(gwPrizeSettlements.status, "pending"),
        ),
      )
      .returning();

    if (!paid[0]) {
      throw new Error(
        "Prize settlement could not be marked paid",
      );
    }

    return paid[0];
  });
}

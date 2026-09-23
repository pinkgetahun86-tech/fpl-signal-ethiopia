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
import { logger } from "../lib/logger";
import { calculateTop20PrizeShares } from "./prize-distribution";

export async function syncCompetitionLifecycle(
  challenge: WeeklyChallenge,
): Promise<string> {
  const competition = await db
    .select()
    .from(gwCompetitions)
    .where(
      eq(
        gwCompetitions.id,
        challenge.competitionId,
      ),
    )
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

  if (
    !challenge.locked &&
    competition.status !== "open"
  ) {
    await db
      .update(gwCompetitions)
      .set({
        status: "open",
        updatedAt: new Date(),
      })
      .where(
        eq(
          gwCompetitions.id,
          competition.id,
        ),
      );

    return "open";
  }

  if (
    challenge.locked &&
    competition.status === "open"
  ) {
    await db
      .update(gwCompetitions)
      .set({
        status: "locked",
        updatedAt: new Date(),
      })
      .where(
        eq(
          gwCompetitions.id,
          competition.id,
        ),
      );
  }

  return challenge.locked
    ? "locked"
    : "open";
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
    .where(
      eq(
        gwCompetitions.id,
        competitionId,
      ),
    )
    .limit(1)
    .then((r) => r[0]);

  if (!competition) {
    throw new Error(
      "Competition not found",
    );
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

  const fpl = await getCurrentGameweek();

  if (
    fpl.id === competition.gameweek &&
    !fpl.finished
  ) {
    throw new Error(
      "የዚህ የጨዋታ ሳምንት ውጤት ገና አልተጠናቀቀም።",
    );
  }

  if (competition.status === "open") {
    throw new Error(
      "ውድድሩ ገና አልተዘጋም።",
    );
  }

  await db.transaction(async (tx) => {
    /*
     * Payment confirmation and settlement use the same
     * competition lock. This prevents a successful payment
     * from racing with finalization.
     */
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(
          ${`fpl-gw-finalize:${competitionId}`}
        )
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
      lockedCompetition.status === "settled"
    ) {
      return;
    }

    if (
      lockedCompetition.status === "open"
    ) {
      throw new Error(
        "ውድድሩ ገና አልተዘጋም።",
      );
    }

    /*
     * A pending Chapa payment must never be ignored.
     * We wait until all payment decisions are final.
     */
    const pendingPayments = await tx
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

    const challenge: WeeklyChallenge = {
      competitionId,
      gameweek:
        lockedCompetition.gameweek,
      deadlineTime:
        lockedCompetition.deadlineTime,
      locked: true,
    };

    /*
     * Make sure the final FPL scores are current before
     * calculating the winners.
     */
    await refreshChallengeScores(
      challenge,
    );

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

    /*
     * No confirmed players.
     */
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

    /*
     * Calculate the fixed Top-20 prize distribution.
     *
     * The prize-distribution module handles:
     * - Top 20
     * - fewer than 20 participants
     * - ties
     * - integer ETB rounding
     * - deterministic remainder allocation
     */
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
        amountEtb: share.amountEtb,
        status: "pending",
      }));

    /*
     * Settlement creation is idempotent because each entry
     * can only have one prize settlement.
     *
     * If finalization is retried after a partial database
     * operation, the existing unique constraint protects
     * the same entry from getting another settlement.
     */
    if (rows.length > 0) {
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
    }

    /*
     * Mark competition settled only after prize settlements
     * have been created successfully.
     */
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
 * Pays one prize settlement into the winner's wallet.
 *
 * Important:
 * The wallet balance update, wallet ledger entry and
 * settlement status change happen in ONE database transaction.
 *
 * Therefore:
 * - prize cannot be credited twice
 * - a paid settlement cannot lose its wallet credit
 * - retrying the same settlement is safe
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

  return db.transaction(async (tx) => {
    /*
     * Serialize all attempts to pay this exact settlement.
     */
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(
          ${`fpl-prize-settlement:${settlementId}`}
        )
      )`,
    );

    /*
     * Lock the settlement row so another request cannot
     * change it while we are crediting the wallet.
     */
    const settlement = await tx
      .select()
      .from(gwPrizeSettlements)
      .where(
        eq(
          gwPrizeSettlements.id,
          settlementId,
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!settlement) {
      throw new Error(
        "Prize settlement not found",
      );
    }

    /*
     * Already paid = idempotent success.
     */
    if (settlement.status === "paid") {
      return settlement;
    }

    if (settlement.status !== "pending") {
      throw new Error(
        "Prize settlement is not pending",
      );
    }

    if (
      !Number.isSafeInteger(
        settlement.amountEtb,
      ) ||
      settlement.amountEtb <= 0
    ) {
      throw new Error(
        "Invalid prize amount",
      );
    }

    /*
     * Get or create the winner's wallet account.
     */
    await tx
      .insert(walletAccounts)
      .values({
        telegramUserId:
          settlement.telegramUserId,
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
      throw new Error(
        "Winner wallet could not be created",
      );
    }

    /*
     * This reference is deterministic.
     *
     * If the exact same prize payout is retried,
     * this reference identifies the existing ledger entry.
     */
    const ledgerReference =
      `gw-prize:${settlementId}`;

    const existingLedger =
      await tx
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
     * If the ledger entry already exists, the wallet was
     * already credited in a previous attempt.
     *
     * We only need to finish the settlement transition.
     */
    if (existingLedger) {
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
              settlementId,
            ),
            eq(
              gwPrizeSettlements.status,
              "pending",
            ),
          ),
        )
        .returning();

      return paid[0] ?? settlement;
    }

    /*
     * Calculate the new wallet balance atomically.
     */
    const newBalance =
      wallet.balanceEtb +
      settlement.amountEtb;

    /*
     * Update wallet balance.
     */
    const updatedWallet = await tx
      .update(walletAccounts)
      .set({
        balanceEtb: newBalance,
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

    /*
     * Create the immutable prize ledger entry.
     */
    await tx
      .insert(walletTransactions)
      .values({
        walletAccountId: wallet.id,
        telegramUserId:
          settlement.telegramUserId,
        type: "prize",
        amountEtb:
          settlement.amountEtb,
        balanceAfterEtb:
          newBalance,
        reference:
          ledgerReference,
        description:
          `GW${settlement.competitionId} የውድድር ሽልማት`,
      })
      .onConflictDoNothing({
        target: walletTransactions.reference,
      });

    /*
     * Only after the wallet credit has succeeded do we
     * mark the settlement as paid.
     */
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
            settlementId,
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
  });
}

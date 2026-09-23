import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  gwCompetitions,
  gwPayments,
  walletAccounts,
  walletDeposits,
  walletTransactions,
  weeklyChallengeEntries,
  type TelegramUser as DbTelegramUser,
  type WalletAccount,
} from "@workspace/db";

export const MANUAL_TELEBIRR_METHOD = "telebirr_manual";

/**
 * Only this percentage of each entry fee goes into the prize pool.
 * The remaining 30% is project revenue.
 */
export const PRIZE_POOL_SHARE_PERCENT = 70;

function assertPositiveEtb(amountEtb: number): number {
  if (!Number.isSafeInteger(amountEtb) || amountEtb <= 0) {
    throw new Error("የገንዘብ መጠኑ ትክክል አይደለም።");
  }
  return amountEtb;
}

function cleanReference(reference: string): string {
  const value = reference.trim();

  if (!value || value.length > 120) {
    throw new Error("የTransaction reference ትክክል አይደለም።");
  }

  return value;
}

export function calculatePrizePoolContribution(entryFeeEtb: number): number {
  const amount = assertPositiveEtb(entryFeeEtb);

  return Math.floor(
    (amount * PRIZE_POOL_SHARE_PERCENT) / 100,
  );
}

async function ensureWallet(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: number,
): Promise<WalletAccount> {
  await tx
    .insert(walletAccounts)
    .values({ telegramUserId: userId })
    .onConflictDoNothing({
      target: walletAccounts.telegramUserId,
    });

  const rows = await tx
    .select()
    .from(walletAccounts)
    .where(eq(walletAccounts.telegramUserId, userId))
    .limit(1);

  if (!rows[0]) {
    throw new Error("Wallet መፍጠር አልተቻለም።");
  }

  return rows[0];
}

export async function getWallet(userId: number): Promise<WalletAccount> {
  return db.transaction(async (tx) => ensureWallet(tx, userId));
}

export async function getWalletTransactions(
  userId: number,
  limit = 30,
) {
  const safeLimit = Math.min(
    Math.max(Math.trunc(limit), 1),
    100,
  );

  const wallet = await getWallet(userId);

  return db
    .select()
    .from(walletTransactions)
    .where(eq(walletTransactions.walletAccountId, wallet.id))
    .orderBy(desc(walletTransactions.id))
    .limit(safeLimit);
}

export async function listUserDeposits(
  userId: number,
  limit = 20,
) {
  const safeLimit = Math.min(
    Math.max(Math.trunc(limit), 1),
    50,
  );

  return db
    .select()
    .from(walletDeposits)
    .where(eq(walletDeposits.telegramUserId, userId))
    .orderBy(desc(walletDeposits.id))
    .limit(safeLimit);
}

export async function createManualTelebirrDeposit(
  user: DbTelegramUser,
  amountEtb: number,
  transactionReference: string,
) {
  const amount = assertPositiveEtb(amountEtb);
  const reference = cleanReference(transactionReference);

  return db.transaction(async (tx) => {
    const wallet = await ensureWallet(tx, user.id);

    const duplicate = await tx
      .select({ id: walletDeposits.id })
      .from(walletDeposits)
      .where(
        eq(
          walletDeposits.transactionReference,
          reference,
        ),
      )
      .limit(1);

    if (duplicate[0]) {
      throw new Error(
        "ይህ የTelebirr ግብይት መለያ አስቀድሞ ተጠቅመዋል።",
      );
    }

    const rows = await tx
      .insert(walletDeposits)
      .values({
        walletAccountId: wallet.id,
        telegramUserId: user.id,
        method: MANUAL_TELEBIRR_METHOD,
        amountEtb: amount,
        transactionReference: reference,
        status: "pending",
      })
      .returning();

    if (!rows[0]) {
      throw new Error(
        "የDeposit ጥያቄውን ማስቀመጥ አልተቻለም።",
      );
    }

    return rows[0];
  });
}

export async function approveWalletDeposit(
  depositId: number,
  adminNote?: string,
) {
  if (!Number.isSafeInteger(depositId) || depositId <= 0) {
    throw new Error("የDeposit መለያ ትክክል አይደለም።");
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(${`fpl-wallet-deposit:${depositId}`})
      )`,
    );

    const deposit = await tx
      .select()
      .from(walletDeposits)
      .where(eq(walletDeposits.id, depositId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!deposit) {
      throw new Error("Deposit አልተገኘም።");
    }

    if (deposit.status === "approved") {
      return deposit;
    }

    if (deposit.status !== "pending") {
      throw new Error(
        "ይህ Deposit ከዚህ በኋላ ሊፀድቅ አይችልም።",
      );
    }

    const wallet = await ensureWallet(
      tx,
      deposit.telegramUserId,
    );

    const walletRows = await tx
      .update(walletAccounts)
      .set({
        balanceEtb: sql`${walletAccounts.balanceEtb} + ${deposit.amountEtb}`,
        updatedAt: new Date(),
      })
      .where(eq(walletAccounts.id, wallet.id))
      .returning();

    const balanceAfter = walletRows[0]?.balanceEtb;

    if (balanceAfter === undefined) {
      throw new Error("Wallet ማዘመን አልተቻለም።");
    }

    await tx
      .insert(walletTransactions)
      .values({
        walletAccountId: wallet.id,
        telegramUserId: deposit.telegramUserId,
        type: "deposit",
        amountEtb: deposit.amountEtb,
        balanceAfterEtb: balanceAfter,
        reference: `wallet-deposit:${deposit.id}`,
        description:
          `Manual Telebirr deposit ${deposit.transactionReference}`,
      })
      .onConflictDoNothing({
        target: walletTransactions.reference,
      });

    const updated = await tx
      .update(walletDeposits)
      .set({
        status: "approved",
        adminNote: adminNote?.trim() || null,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(walletDeposits.id, deposit.id),
          eq(walletDeposits.status, "pending"),
        ),
      )
      .returning();

    if (!updated[0]) {
      throw new Error(
        "Deposit ማፅደቅ አልተቻለም።",
      );
    }

    return updated[0];
  });
}

export async function rejectWalletDeposit(
  depositId: number,
  adminNote?: string,
) {
  if (!Number.isSafeInteger(depositId) || depositId <= 0) {
    throw new Error("የDeposit መለያ ትክክል አይደለም።");
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(${`fpl-wallet-deposit:${depositId}`})
      )`,
    );

    const deposit = await tx
      .select()
      .from(walletDeposits)
      .where(eq(walletDeposits.id, depositId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!deposit) {
      throw new Error("Deposit አልተገኘም።");
    }

    if (deposit.status === "rejected") {
      return deposit;
    }

    if (deposit.status !== "pending") {
      throw new Error(
        "ይህ Deposit ከዚህ በኋላ ሊከለከል አይችልም።",
      );
    }

    const updated = await tx
      .update(walletDeposits)
      .set({
        status: "rejected",
        adminNote: adminNote?.trim() || null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(walletDeposits.id, deposit.id),
          eq(walletDeposits.status, "pending"),
        ),
      )
      .returning();

    if (!updated[0]) {
      throw new Error(
        "Deposit መከልከል አልተቻለም።",
      );
    }

    return updated[0];
  });
}

export async function debitWallet(
  userId: number,
  amountEtb: number,
  reference: string,
  description: string,
) {
  const amount = assertPositiveEtb(amountEtb);
  const clean = cleanReference(reference);

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.reference, clean))
      .limit(1);

    if (existing[0]) {
      return existing[0];
    }

    const wallet = await ensureWallet(tx, userId);

    const updated = await tx
      .update(walletAccounts)
      .set({
        balanceEtb: sql`${walletAccounts.balanceEtb} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(walletAccounts.id, wallet.id),
          sql`${walletAccounts.balanceEtb} >= ${amount}`,
        ),
      )
      .returning();

    if (!updated[0]) {
      throw new Error(
        "የWallet ቀሪ ሂሳብ በቂ አይደለም።",
      );
    }

    const ledger = await tx
      .insert(walletTransactions)
      .values({
        walletAccountId: wallet.id,
        telegramUserId: userId,
        type: "debit",
        amountEtb: -amount,
        balanceAfterEtb: updated[0].balanceEtb,
        reference: clean,
        description,
      })
      .returning();

    if (!ledger[0]) {
      throw new Error(
        "የWallet transaction ማስቀመጥ አልተቻለም።",
      );
    }

    return ledger[0];
  });
}

export async function creditWallet(
  userId: number,
  amountEtb: number,
  reference: string,
  description: string,
) {
  const amount = assertPositiveEtb(amountEtb);
  const clean = cleanReference(reference);

  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.reference, clean))
      .limit(1);

    if (existing[0]) {
      return existing[0];
    }

    const wallet = await ensureWallet(tx, userId);

    const updated = await tx
      .update(walletAccounts)
      .set({
        balanceEtb: sql`${walletAccounts.balanceEtb} + ${amount}`,
        updatedAt: new Date(),
      })
      .where(eq(walletAccounts.id, wallet.id))
      .returning();

    if (!updated[0]) {
      throw new Error("Wallet ማዘመን አልተቻለም።");
    }

    const ledger = await tx
      .insert(walletTransactions)
      .values({
        walletAccountId: wallet.id,
        telegramUserId: userId,
        type: "credit",
        amountEtb: amount,
        balanceAfterEtb: updated[0].balanceEtb,
        reference: clean,
        description,
      })
      .returning();

    if (!ledger[0]) {
      throw new Error(
        "የWallet transaction ማስቀመጥ አልተቻለም።",
      );
    }

    return ledger[0];
  });
}

export async function joinWeeklyChallengeWithWallet(
  competitionId: string,
  userId: number,
  entryId: number,
) {
  return db.transaction(async (tx) => {
    /**
     * Same lock used by Chapa initialization.
     * This makes Wallet and Chapa mutually exclusive.
     */
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(${`fpl-payment:${competitionId}:${userId}`})
      )`,
    );

    const competition = await tx
      .select()
      .from(gwCompetitions)
      .where(eq(gwCompetitions.id, competitionId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!competition) {
      throw new Error("ውድድሩ አልተገኘም።");
    }

    if (competition.status !== "open") {
      throw new Error("የዚህ ሳምንት ውድድር ተዘግቷል።");
    }

    if (
      !Number.isSafeInteger(competition.entryFeeEtb) ||
      competition.entryFeeEtb <= 0
    ) {
      throw new Error("የመግቢያ ክፍያ አልተዘጋጀም።");
    }

    const entry = await tx
      .select()
      .from(weeklyChallengeEntries)
      .where(
        and(
          eq(weeklyChallengeEntries.id, entryId),
          eq(weeklyChallengeEntries.telegramUserId, userId),
          eq(
            weeklyChallengeEntries.competitionId,
            competitionId,
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (!entry) {
      throw new Error(
        "የቡድን ምዝገባው አልተገኘም።",
      );
    }

    if (entry.submissionStatus === "confirmed") {
      return {
        alreadyConfirmed: true,
        walletTransaction: null,
      };
    }

    /**
     * A Chapa payment already pending/success means the same
     * competition cannot also be paid from Wallet.
     */
    const providerPayment = await tx
      .select()
      .from(gwPayments)
      .where(
        and(
          eq(gwPayments.competitionId, competitionId),
          eq(gwPayments.telegramUserId, userId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0]);

    if (
      providerPayment?.status === "success" ||
      providerPayment?.status === "pending"
    ) {
      throw new Error(
        "ለዚህ ውድድር የተጀመረ ወይም የተረጋገጠ የChapa ክፍያ አለ። እባክዎ ያንን ክፍያ ይጠብቁ።",
      );
    }

    const reference = `gw-entry:${competitionId}:${userId}`;

    const existingTransaction = await tx
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.reference, reference))
      .limit(1);

    if (existingTransaction[0]) {
      await tx
        .update(weeklyChallengeEntries)
        .set({
          submissionStatus: "confirmed",
          updatedAt: new Date(),
        })
        .where(eq(weeklyChallengeEntries.id, entryId));

      return {
        alreadyConfirmed: true,
        walletTransaction: existingTransaction[0],
      };
    }

    const wallet = await ensureWallet(tx, userId);

    const updatedWallet = await tx
      .update(walletAccounts)
      .set({
        balanceEtb:
          sql`${walletAccounts.balanceEtb} - ${competition.entryFeeEtb}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(walletAccounts.id, wallet.id),
          sql`${walletAccounts.balanceEtb} >= ${competition.entryFeeEtb}`,
        ),
      )
      .returning();

    if (!updatedWallet[0]) {
      throw new Error(
        "የWallet ቀሪ ሂሳብ በቂ አይደለም።",
      );
    }

    const ledger = await tx
      .insert(walletTransactions)
      .values({
        walletAccountId: wallet.id,
        telegramUserId: userId,
        type: "entry_fee",
        amountEtb: -competition.entryFeeEtb,
        balanceAfterEtb: updatedWallet[0].balanceEtb,
        reference,
        description:
          `GW${competition.gameweek} Weekly Challenge መግቢያ`,
      })
      .returning();

    if (!ledger[0]) {
      throw new Error(
        "የWallet ክፍያ ማስቀመጥ አልተቻለም።",
      );
    }

    /**
     * Only 70% goes to the prize pool.
     * 30% remains project revenue.
     */
    const prizeContribution = calculatePrizePoolContribution(
      competition.entryFeeEtb,
    );

    await tx
      .update(gwCompetitions)
      .set({
        prizePoolEtb:
          sql`${gwCompetitions.prizePoolEtb} + ${prizeContribution}`,
        updatedAt: new Date(),
      })
      .where(eq(gwCompetitions.id, competition.id));

    await tx
      .update(weeklyChallengeEntries)
      .set({
        submissionStatus: "confirmed",
        updatedAt: new Date(),
      })
      .where(eq(weeklyChallengeEntries.id, entryId));

    return {
      alreadyConfirmed: false,
      walletTransaction: ledger[0],
    };
  });
}

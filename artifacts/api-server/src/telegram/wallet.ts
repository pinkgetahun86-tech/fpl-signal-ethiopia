import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  gwCompetitions,
  gwPayments,
  walletAccounts,
  walletDeposits,
  walletTransactions,
  walletWithdrawals,
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

function cleanWithdrawalDestination(destination: string): string {
  const value = destination.trim();

  if (!value || value.length > 64) {
    throw new Error("የTelebirr ቁጥሩ ትክክል አይደለም።");
  }

  return value;
}

function cleanAdminNote(adminNote?: string): string | null {
  const value = adminNote?.trim() ?? "";

  if (!value) {
    return null;
  }

  if (value.length > 500) {
    throw new Error("የAdmin note በጣም ረጅም ነው።");
  }

  return value;
}

function cleanPayoutReference(payoutReference: string): string {
  const value = payoutReference.trim();

  if (!value || value.length > 120) {
    throw new Error("የPayout reference ትክክል አይደለም።");
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

/**
 * List the user's withdrawal requests.
 */
export async function listUserWithdrawals(
  userId: number,
  limit = 20,
) {
  const safeLimit = Math.min(
    Math.max(Math.trunc(limit), 1),
    50,
  );

  return db
    .select()
    .from(walletWithdrawals)
    .where(eq(walletWithdrawals.telegramUserId, userId))
    .orderBy(desc(walletWithdrawals.id))
    .limit(safeLimit);
}

/**
 * Create a manual Telebirr deposit request.
 *
 * The money is NOT added to the wallet until an admin approves
 * the deposit.
 */
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

  const note = cleanAdminNote(adminNote);

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
        adminNote: note,
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

  const note = cleanAdminNote(adminNote);

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
        adminNote: note,
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

/**
 * Create a withdrawal request.
 *
 * Important:
 * The requested amount is reserved immediately by deducting it
 * from the wallet in the SAME transaction that creates the
 * withdrawal ledger entry.
 *
 * Therefore two simultaneous withdrawal requests cannot spend
 * the same balance.
 */
export async function createWalletWithdrawal(
  userId: number,
  amountEtb: number,
  destination: string,
) {
  const amount = assertPositiveEtb(amountEtb);
  const cleanDestination =
    cleanWithdrawalDestination(destination);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(${`fpl-wallet-withdrawal-user:${userId}`})
      )`,
    );

    const wallet = await ensureWallet(tx, userId);

    /**
     * Create the withdrawal row first so that we have its
     * database id for the unique ledger reference.
     *
     * If any following operation fails, the entire transaction
     * rolls back, including this row.
     */
    const withdrawalRows = await tx
      .insert(walletWithdrawals)
      .values({
        walletAccountId: wallet.id,
        telegramUserId: userId,
        method: MANUAL_TELEBIRR_METHOD,
        amountEtb: amount,
        destination: cleanDestination,
        status: "pending",
      })
      .returning();

    const withdrawal = withdrawalRows[0];

    if (!withdrawal) {
      throw new Error(
        "የWithdrawal ጥያቄውን ማስቀመጥ አልተቻለም።",
      );
    }

    /**
     * Atomic balance reservation.
     *
     * The WHERE condition guarantees that the balance can never
     * become negative.
     */
    const walletRows = await tx
      .update(walletAccounts)
      .set({
        balanceEtb:
          sql`${walletAccounts.balanceEtb} - ${amount}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(walletAccounts.id, wallet.id),
          sql`${walletAccounts.balanceEtb} >= ${amount}`,
        ),
      )
      .returning();

    const balanceAfter = walletRows[0]?.balanceEtb;

    if (balanceAfter === undefined) {
      throw new Error(
        "የWallet ቀሪ ሂሳብ በቂ አይደለም።",
      );
    }

    const ledger = await tx
      .insert(walletTransactions)
      .values({
        walletAccountId: wallet.id,
        telegramUserId: userId,
        type: "withdrawal",
        amountEtb: -amount,
        balanceAfterEtb: balanceAfter,
        reference: `wallet-withdrawal:${withdrawal.id}`,
        description:
          `Telebirr withdrawal ${withdrawal.id}`,
      })
      .returning();

    if (!ledger[0]) {
      throw new Error(
        "የWithdrawal Wallet transaction ማስቀመጥ አልተቻለም።",
      );
    }

    return {
      withdrawal,
      walletTransaction: ledger[0],
      balanceEtb: balanceAfter,
    };
  });
}

/**
 * Approve a pending withdrawal.
 *
 * Approval does NOT change the wallet balance because the amount
 * was already reserved when the request was created.
 */
export async function approveWalletWithdrawal(
  withdrawalId: number,
  adminNote?: string,
) {
  if (
    !Number.isSafeInteger(withdrawalId) ||
    withdrawalId <= 0
  ) {
    throw new Error(
      "የWithdrawal መለያ ትክክል አይደለም።",
    );
  }

  const note = cleanAdminNote(adminNote);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(${`fpl-wallet-withdrawal:${withdrawalId}`})
      )`,
    );

    const withdrawal = await tx
      .select()
      .from(walletWithdrawals)
      .where(eq(walletWithdrawals.id, withdrawalId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!withdrawal) {
      throw new Error("Withdrawal አልተገኘም።");
    }

    if (withdrawal.status === "approved") {
      return withdrawal;
    }

    if (withdrawal.status === "paid") {
      return withdrawal;
    }

    if (withdrawal.status === "rejected") {
      throw new Error(
        "የተከለከለ Withdrawal ማፅደቅ አይቻልም።",
      );
    }

    if (withdrawal.status !== "pending") {
      throw new Error(
        "ይህ Withdrawal ሊፀድቅ አይችልም።",
      );
    }

    const updated = await tx
      .update(walletWithdrawals)
      .set({
        status: "approved",
        adminNote: note,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(walletWithdrawals.id, withdrawal.id),
          eq(walletWithdrawals.status, "pending"),
        ),
      )
      .returning();

    if (!updated[0]) {
      throw new Error(
        "Withdrawal ማፅደቅ አልተቻለም።",
      );
    }

    return updated[0];
  });
}

/**
 * Reject a pending withdrawal.
 *
 * Because the amount was reserved at request time, rejection
 * releases the reservation by crediting the exact amount back.
 *
 * The refund has its own unique ledger reference, so it can
 * never be credited twice.
 */
export async function rejectWalletWithdrawal(
  withdrawalId: number,
  adminNote?: string,
) {
  if (
    !Number.isSafeInteger(withdrawalId) ||
    withdrawalId <= 0
  ) {
    throw new Error(
      "የWithdrawal መለያ ትክክል አይደለም።",
    );
  }

  const note = cleanAdminNote(adminNote);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(${`fpl-wallet-withdrawal:${withdrawalId}`})
      )`,
    );

    const withdrawal = await tx
      .select()
      .from(walletWithdrawals)
      .where(eq(walletWithdrawals.id, withdrawalId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!withdrawal) {
      throw new Error("Withdrawal አልተገኘም።");
    }

    if (withdrawal.status === "rejected") {
      return withdrawal;
    }

    if (withdrawal.status === "approved") {
      throw new Error(
        "የተፀደቀ Withdrawal መከልከል አይቻልም።",
      );
    }

    if (withdrawal.status === "paid") {
      throw new Error(
        "የተከፈለ Withdrawal መከልከል አይቻልም።",
      );
    }

    if (withdrawal.status !== "pending") {
      throw new Error(
        "ይህ Withdrawal መከልከል አይቻልም።",
      );
    }

    const wallet = await ensureWallet(
      tx,
      withdrawal.telegramUserId,
    );

    const refundReference =
      `wallet-withdrawal-refund:${withdrawal.id}`;

    const existingRefund = await tx
      .select()
      .from(walletTransactions)
      .where(
        eq(
          walletTransactions.reference,
          refundReference,
        ),
      )
      .limit(1);

    if (existingRefund[0]) {
      const updated = await tx
        .update(walletWithdrawals)
        .set({
          status: "rejected",
          adminNote: note,
          rejectedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(
              walletWithdrawals.id,
              withdrawal.id,
            ),
            eq(
              walletWithdrawals.status,
              "pending",
            ),
          ),
        )
        .returning();

      if (updated[0]) {
        return updated[0];
      }

      return withdrawal;
    }

    const walletRows = await tx
      .update(walletAccounts)
      .set({
        balanceEtb:
          sql`${walletAccounts.balanceEtb} + ${withdrawal.amountEtb}`,
        updatedAt: new Date(),
      })
      .where(eq(walletAccounts.id, wallet.id))
      .returning();

    const balanceAfter = walletRows[0]?.balanceEtb;

    if (balanceAfter === undefined) {
      throw new Error(
        "Withdrawal refund ሲደረግ Wallet ማዘመን አልተቻለም።",
      );
    }

    const refundLedger = await tx
      .insert(walletTransactions)
      .values({
        walletAccountId: wallet.id,
        telegramUserId: withdrawal.telegramUserId,
        type: "withdrawal_refund",
        amountEtb: withdrawal.amountEtb,
        balanceAfterEtb: balanceAfter,
        reference: refundReference,
        description:
          `Refund for rejected withdrawal ${withdrawal.id}`,
      })
      .returning();

    if (!refundLedger[0]) {
      throw new Error(
        "የWithdrawal refund transaction ማስቀመጥ አልተቻለም።",
      );
    }

    const updated = await tx
      .update(walletWithdrawals)
      .set({
        status: "rejected",
        adminNote: note,
        rejectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(walletWithdrawals.id, withdrawal.id),
          eq(walletWithdrawals.status, "pending"),
        ),
      )
      .returning();

    if (!updated[0]) {
      throw new Error(
        "Withdrawal መከልከል አልተቻለም።",
      );
    }

    return updated[0];
  });
}

/**
 * Mark an approved withdrawal as paid.
 *
 * This does NOT change wallet balance. The wallet was already
 * debited when the request was created.
 */
export async function markWalletWithdrawalPaid(
  withdrawalId: number,
  payoutReference: string,
  adminNote?: string,
) {
  if (
    !Number.isSafeInteger(withdrawalId) ||
    withdrawalId <= 0
  ) {
    throw new Error(
      "የWithdrawal መለያ ትክክል አይደለም።",
    );
  }

  const reference =
    cleanPayoutReference(payoutReference);

  const note = cleanAdminNote(adminNote);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtext(${`fpl-wallet-withdrawal:${withdrawalId}`})
      )`,
    );

    const withdrawal = await tx
      .select()
      .from(walletWithdrawals)
      .where(eq(walletWithdrawals.id, withdrawalId))
      .limit(1)
      .then((rows) => rows[0]);

    if (!withdrawal) {
      throw new Error("Withdrawal አልተገኘም።");
    }

    if (withdrawal.status === "paid") {
      return withdrawal;
    }

    if (withdrawal.status === "pending") {
      throw new Error(
        "መጀመሪያ Withdrawal ማፅደቅ አለበት።",
      );
    }

    if (withdrawal.status === "rejected") {
      throw new Error(
        "የተከለከለ Withdrawal እንደተከፈለ ማስመዝገብ አይቻልም።",
      );
    }

    if (withdrawal.status !== "approved") {
      throw new Error(
        "ይህ Withdrawal እንደተከፈለ ማስመዝገብ አይቻልም።",
      );
    }

    const existingPayout = await tx
      .select({ id: walletWithdrawals.id })
      .from(walletWithdrawals)
      .where(
        eq(
          walletWithdrawals.payoutReference,
          reference,
        ),
      )
      .limit(1);

    if (
      existingPayout[0] &&
      existingPayout[0].id !== withdrawal.id
    ) {
      throw new Error(
        "ይህ Payout reference አስቀድሞ ተጠቅመዋል።",
      );
    }

    const updated = await tx
      .update(walletWithdrawals)
      .set({
        status: "paid",
        payoutReference: reference,
        adminNote: note ?? withdrawal.adminNote,
        paidAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(walletWithdrawals.id, withdrawal.id),
          eq(walletWithdrawals.status, "approved"),
        ),
      )
      .returning();

    if (!updated[0]) {
      throw new Error(
        "Withdrawal እንደተከፈለ ማስመዝገብ አልተቻለም።",
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
        "ለዚህ ውድድር የተጀመረ ወይም የተረጋገጠ የChapa ክፍያ አለ። እባክዎ ያንን ክ

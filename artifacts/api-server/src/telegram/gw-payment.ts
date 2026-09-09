import crypto from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  gwCompetitions,
  gwPaymentEvents,
  gwPayments,
  telegramUsers,
  weeklyChallengeEntries,
  type GwCompetition,
} from "@workspace/db";
import type { TelegramUser as DbTelegramUser } from "@workspace/db";
import type { WeeklyChallenge } from "./weekly-challenge";
import { logger } from "../lib/logger";

export const PAID_COMPETITION_ENABLED = process.env.GW_COMPETITION_PAID_ENABLED === "true";
const ENTRY_FEE_ETB = Number(process.env.GW_ENTRY_FEE_ETB ?? "0");
const CHAPA_SECRET_KEY = process.env.CHAPA_SECRET_KEY?.trim();
const CHAPA_WEBHOOK_SECRET = process.env.CHAPA_WEBHOOK_SECRET?.trim();
const CHAPA_CALLBACK_URL = process.env.CHAPA_CALLBACK_URL?.trim();
const CHAPA_RETURN_URL = process.env.CHAPA_RETURN_URL?.trim();

export function getConfiguredEntryFeeEtb(): number {
  if (!Number.isSafeInteger(ENTRY_FEE_ETB) || ENTRY_FEE_ETB < 0) return 0;
  return ENTRY_FEE_ETB;
}

export function isPaidCompetitionReady(): boolean {
  return Boolean(
    PAID_COMPETITION_ENABLED &&
      getConfiguredEntryFeeEtb() > 0 &&
      CHAPA_SECRET_KEY &&
      CHAPA_WEBHOOK_SECRET &&
      CHAPA_CALLBACK_URL &&
      CHAPA_RETURN_URL,
  );
}

export async function ensureGwCompetition(challenge: WeeklyChallenge): Promise<GwCompetition> {
  const fee = PAID_COMPETITION_ENABLED ? getConfiguredEntryFeeEtb() : 0;
  const existing = await db.select().from(gwCompetitions).where(eq(gwCompetitions.id, challenge.competitionId)).limit(1);
  if (existing[0]) {
    if (challenge.locked && existing[0].status === "open") {
      const updated = await db
        .update(gwCompetitions)
        .set({ status: "locked", updatedAt: new Date() })
        .where(and(eq(gwCompetitions.id, existing[0].id), eq(gwCompetitions.status, "open")))
        .returning();
      return updated[0] ?? existing[0];
    }
    return existing[0];
  }
  const inserted = await db.insert(gwCompetitions).values({
    id: challenge.competitionId,
    gameweek: challenge.gameweek,
    entryFeeEtb: fee,
    currency: "ETB",
    status: challenge.locked ? "locked" : "open",
    deadlineTime: challenge.deadlineTime,
  }).returning();
  if (!inserted[0]) throw new Error("Could not create GW competition");
  return inserted[0];
}

export async function getUserPayment(competitionId: string, userId: number) {
  return db.select().from(gwPayments).where(
    and(eq(gwPayments.competitionId, competitionId), eq(gwPayments.telegramUserId, userId)),
  ).limit(1).then((rows) => rows[0]);
}

function makeTxRef(competitionId: string, userId: number): string {
  return `fpl-${competitionId.replace(/[^a-z0-9-]/gi, "-")}-${userId}-${crypto.randomBytes(5).toString("hex")}`.slice(0, 100);
}

export async function initializeChapaPayment(
  competition: GwCompetition,
  user: DbTelegramUser,
  entryId: number,
): Promise<{ txRef: string; checkoutUrl: string }> {
  if (!isPaidCompetitionReady()) {
    throw new Error("የክፍያ ስርዓቱ ገና አልተነቃም።");
  }
  if (competition.status !== "open") throw new Error("የዚህ ሳምንት ውድድር ተዘግቷል።");
  if (competition.entryFeeEtb <= 0) throw new Error("የመግቢያ ክፍያ አልተዘጋጀም።");

  // Serialize payment initialization per competition/user. Without this lock,
  // two fast Mini App taps could both create a Chapa checkout before either
  // request inserts its payment row.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fpl-payment:${competition.id}:${user.id}`}))`);

    const existing = await tx
      .select()
      .from(gwPayments)
      .where(and(eq(gwPayments.competitionId, competition.id), eq(gwPayments.telegramUserId, user.id)))
      .limit(1)
      .then((rows) => rows[0]);
    if (existing?.status === "success") {
      if (existing.checkoutUrl) return { txRef: existing.txRef, checkoutUrl: existing.checkoutUrl };
      throw new Error("ክፍያው ተረጋግጧል፤ አዲስ ክፍያ መጀመር አያስፈልግም።");
    }
    // Reuse an outstanding checkout instead of replacing its tx_ref.
    // Otherwise a late callback/webhook for the old transaction could no longer
    // be matched to the payment row and a successful payment could be lost.
    if (existing?.status === "pending" && existing.checkoutUrl) {
      return { txRef: existing.txRef, checkoutUrl: existing.checkoutUrl };
    }

    const txRef = makeTxRef(competition.id, user.id);
  const response = await fetch("https://api.chapa.co/v1/transaction/initialize", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CHAPA_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      amount: String(competition.entryFeeEtb),
      currency: "ETB",
      first_name: user.firstName ?? "FPL",
      tx_ref: txRef,
      callback_url: CHAPA_CALLBACK_URL,
      return_url: CHAPA_RETURN_URL,
      customization: {
        title: "FPL Signal Ethiopia",
        description: `GW${competition.gameweek} የFPL ውድድር መግቢያ`,
      },
      meta: { competition_id: competition.id, entry_id: String(entryId), telegram_user_id: String(user.id) },
    }),
  });
  const payload = await response.json() as { status?: string; message?: string; data?: { checkout_url?: string } };
  const checkoutUrl = payload.data?.checkout_url;
  if (!response.ok || !checkoutUrl) {
    logger.error({ status: response.status, payload }, "Chapa initialization failed");
    throw new Error("የክፍያ ገጹን ማስጀመር አልተቻለም።");
  }

    await tx.insert(gwPayments).values({
      competitionId: competition.id,
      telegramUserId: user.id,
      entryId,
      provider: "chapa",
      txRef,
      amountEtb: competition.entryFeeEtb,
      currency: "ETB",
      status: "pending",
      providerStatus: payload.status ?? null,
      checkoutUrl,
    }).onConflictDoNothing({
      target: [gwPayments.competitionId, gwPayments.telegramUserId],
    });

    const saved = await tx
      .select({ txRef: gwPayments.txRef, checkoutUrl: gwPayments.checkoutUrl })
      .from(gwPayments)
      .where(and(eq(gwPayments.competitionId, competition.id), eq(gwPayments.telegramUserId, user.id)))
      .limit(1)
      .then((rows) => rows[0]);
    if (!saved?.checkoutUrl || saved.txRef !== txRef) {
      throw new Error("የክፍያ መረጃውን ማስቀመጥ አልተቻለም።");
    }
    return { txRef: saved.txRef, checkoutUrl: saved.checkoutUrl };
  });
}

export async function verifyChapaPayment(txRef: string) {
  if (!CHAPA_SECRET_KEY) throw new Error("CHAPA_SECRET_KEY is not configured");
  const response = await fetch(`https://api.chapa.co/v1/transaction/verify/${encodeURIComponent(txRef)}`, {
    headers: { Authorization: `Bearer ${CHAPA_SECRET_KEY}` },
  });
  const payload = await response.json() as {
    status?: string;
    message?: string;
    data?: { status?: string; amount?: string | number; currency?: string; tx_ref?: string; ref_id?: string; mode?: string };
  };
  if (!response.ok) throw new Error(`Chapa verification failed: ${response.status}`);
  return payload;
}

export async function confirmPaymentFromProvider(txRef: string): Promise<boolean> {
  const payment = await db.select().from(gwPayments).where(eq(gwPayments.txRef, txRef)).limit(1).then((rows) => rows[0]);
  if (!payment) return false;
  const verified = await verifyChapaPayment(txRef);
  const data = verified.data;
  const success = verified.status === "success" && data?.status === "success";
  const amountMatches = Number(data?.amount) === payment.amountEtb;
  const currencyMatches = data?.currency === payment.currency;
  const refMatches = !data?.tx_ref || data.tx_ref === payment.txRef;
  const providerStatus = data?.status ?? verified.status ?? "";

  // A provider response that is not yet successful is not automatically a failed
  // payment. Chapa can return a pending/processing state while the customer
  // finishes the payment. Keep it pending so the callback/webhook/status poll
  // can confirm it later. Only a definitive failure is marked failed.
  const definitiveFailure = ["failed", "cancelled", "canceled", "reversed", "expired"].includes(
    providerStatus.toLowerCase(),
  );

  if (success && amountMatches && currencyMatches && refMatches) {
    await db.transaction(async (tx) => {
      // Finalization and payment confirmation share this competition lock.
      // This prevents a successful payment from racing with prize settlement.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fpl-gw-finalize:${payment.competitionId}`}))`);

      // Only the transition into success is allowed to add money to the prize pool.
      // This keeps callback + webhook retries idempotent.
      const transitioned = await tx
        .update(gwPayments)
        .set({
          status: "success",
          providerStatus: data?.status ?? verified.status ?? null,
          providerRef: data?.ref_id ?? null,
          verifiedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(gwPayments.id, payment.id), eq(gwPayments.status, "pending")))
        .returning({ id: gwPayments.id });

      if (transitioned.length > 0) {
        await tx
          .update(gwCompetitions)
          .set({
            prizePoolEtb: sql`${gwCompetitions.prizePoolEtb} + ${payment.amountEtb}`,
            updatedAt: new Date(),
          })
          .where(eq(gwCompetitions.id, payment.competitionId));

        await tx
          .update(weeklyChallengeEntries)
          .set({ submissionStatus: "confirmed", updatedAt: new Date() })
          .where(eq(weeklyChallengeEntries.id, payment.entryId));
      }
    });
    return true;
  }

  if (definitiveFailure) {
    await db.update(gwPayments).set({
      status: "failed",
      providerStatus: data?.status ?? verified.status ?? null,
      providerRef: data?.ref_id ?? null,
      verifiedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(eq(gwPayments.id, payment.id), eq(gwPayments.status, "pending")));
  } else {
    await db.update(gwPayments).set({
      providerStatus: data?.status ?? verified.status ?? null,
      providerRef: data?.ref_id ?? null,
      updatedAt: new Date(),
    }).where(and(eq(gwPayments.id, payment.id), eq(gwPayments.status, "pending")));
  }
  return false;
}

export function verifyChapaWebhookSignature(rawBody: Buffer, headers: Record<string, unknown>): boolean {
  if (!CHAPA_WEBHOOK_SECRET) return false;
  const provided = String(headers["x-chapa-signature"] ?? headers["chapa-signature"] ?? "").trim();
  if (!provided) return false;
  const expected = crypto.createHmac("sha256", CHAPA_WEBHOOK_SECRET).update(rawBody).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function recordChapaWebhookEvent(txRef: string, eventType: string, payload: Record<string, unknown>) {
  const inserted = await db.insert(gwPaymentEvents).values({ txRef, eventType, payload }).onConflictDoNothing().returning({ id: gwPaymentEvents.id });
  return inserted.length > 0;
}

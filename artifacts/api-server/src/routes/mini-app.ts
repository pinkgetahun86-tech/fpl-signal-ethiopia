import { timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { and, eq } from "drizzle-orm";
import { db, gwPrizeSettlements, weeklyChallengeEntries } from "@workspace/db";
import { GetMiniAppBootstrapResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  buildMiniAppState,
  getMiniAppUser,
  MiniAppRequestError,
  saveMiniAppTeam,
} from "../telegram/mini-app";
import { authenticateMiniAppRequest, MiniAppAuthError } from "../telegram/mini-app-auth";
import { getCurrentChallenge, refreshChallengeScores } from "../telegram/bot";
import {
  ensureGwCompetition,
  getUserPayment,
  initializeChapaPayment,
  confirmPaymentFromProvider,
  isPaidCompetitionReady,
  recordChapaWebhookEvent,
  verifyChapaWebhookSignature,
} from "../telegram/gw-payment";
import { finalizeCompetition, markPrizePaid } from "../telegram/gw-settlement";

const router: IRouter = Router();

function errorMessage(error: unknown): string {
  return error instanceof MiniAppRequestError
    ? error.message
    : "ያልታወቀ የአገልግሎት ስህተት።";
}

async function authenticatedUser(req: Request) {
  const profile = authenticateMiniAppRequest(req);
  return getMiniAppUser(profile);
}

router.get("/mini-app/bootstrap", async (req, res) => {
  try {
    const user = await authenticatedUser(req);
    const state = await buildMiniAppState(user);
    res.json(GetMiniAppBootstrapResponse.parse(state));
  } catch (error) {
    const status =
      error instanceof MiniAppAuthError
        ? error.status
        : error instanceof MiniAppRequestError
          ? error.status
          : 503;
    if (status >= 500) logger.error({ error }, "Could not load Mini App bootstrap");
    res.status(status).json({ error: errorMessage(error) });
  }
});

router.post("/mini-app/team", async (req, res) => {
  try {
    const user = await authenticatedUser(req);
    await saveMiniAppTeam(user, req.body);
    const state = await buildMiniAppState(user);
    res.json(GetMiniAppBootstrapResponse.parse(state));
  } catch (error) {
    const status =
      error instanceof MiniAppAuthError
        ? error.status
        : error instanceof MiniAppRequestError
          ? error.status
          : 503;
    if (status >= 500) logger.error({ error }, "Could not save Mini App team");
    res.status(status).json({ error: errorMessage(error) });
  }
});


router.post("/mini-app/payment/initialize", async (req, res) => {
  try {
    if (!isPaidCompetitionReady()) throw new MiniAppRequestError("የክፍያ ስርዓቱ ገና ለሙከራ እየተዘጋጀ ነው።", 503);
    const user = await authenticatedUser(req);
    const challenge = await getCurrentChallenge();
    if (challenge.locked) throw new MiniAppRequestError("🔒 የዚህ ሳምንት ምዝገባ ተዘግቷል።");
    const competition = await ensureGwCompetition(challenge);
    const entry = await db.select({ id: weeklyChallengeEntries.id })
      .from(weeklyChallengeEntries)
      .where(and(
        eq(weeklyChallengeEntries.telegramUserId, user.id),
        eq(weeklyChallengeEntries.competitionId, challenge.competitionId),
      )).limit(1);
    if (!entry[0]) throw new MiniAppRequestError("መጀመሪያ የውድድሩን ቡድን ያስቀምጡ።");
    const payment = await initializeChapaPayment(competition, user, entry[0].id);
    res.json({ txRef: payment.txRef, checkoutUrl: payment.checkoutUrl, amountEtb: competition.entryFeeEtb, currency: competition.currency });
  } catch (error) {
    const status = error instanceof MiniAppAuthError ? error.status : error instanceof MiniAppRequestError ? error.status : 503;
    if (status >= 500) logger.error({ error }, "Could not initialize Mini App payment");
    res.status(status).json({ error: errorMessage(error) });
  }
});

router.get("/mini-app/payment/status", async (req, res) => {
  try {
    const user = await authenticatedUser(req);
    const challenge = await getCurrentChallenge();
    let payment = await getUserPayment(challenge.competitionId, user.id);
    if (payment?.status === "pending") {
      try {
        await confirmPaymentFromProvider(payment.txRef);
        payment = await getUserPayment(challenge.competitionId, user.id);
      } catch (error) {
        logger.warn({ error, txRef: payment.txRef }, "Payment status verification skipped");
      }
    }
    res.json({ status: payment?.status ?? "not_started", amountEtb: payment?.amountEtb ?? 0, currency: payment?.currency ?? "ETB" });
  } catch (error) {
    const status = error instanceof MiniAppAuthError ? error.status : 503;
    res.status(status).json({ error: errorMessage(error) });
  }
});

router.get("/payments/chapa/callback", async (req, res) => {
  const txRef = typeof req.query.trx_ref === "string" ? req.query.trx_ref : typeof req.query.tx_ref === "string" ? req.query.tx_ref : "";
  if (!txRef) return res.status(400).send("የክፍያ መለያ አልተገኘም።");
  try {
    const success = await confirmPaymentFromProvider(txRef);
    const returnUrl = process.env.MINI_APP_URL?.trim();
    if (returnUrl) return res.redirect(returnUrl);
    return res.status(success ? 200 : 400).send(success ? "ክፍያው ተረጋግጧል።" : "ክፍያው አልተረጋገጠም።");
  } catch (error) {
    logger.error({ error, txRef }, "Chapa callback verification failed");
    return res.status(503).send("ክፍያውን ማረጋገጥ አልተቻለም።");
  }
});

router.post("/payments/chapa/webhook", async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body));
  if (!verifyChapaWebhookSignature(rawBody, req.headers)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const payload = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
    const data = typeof payload.data === "object" && payload.data !== null ? payload.data as Record<string, unknown> : payload;
    const txRef = typeof data.tx_ref === "string" ? data.tx_ref : typeof data.trx_ref === "string" ? data.trx_ref : "";
    const eventType = typeof payload.type === "string" ? payload.type : typeof payload.event === "string" ? payload.event : "transaction";
    if (!txRef) return res.status(400).json({ error: "Missing transaction reference" });
    const fresh = await recordChapaWebhookEvent(txRef, eventType, payload);
    // Always attempt verification, including duplicate webhook deliveries.
    // If the first delivery was recorded but processing failed, a retry must
    // still be able to complete the payment transition.
    await confirmPaymentFromProvider(txRef);
    if (!fresh) logger.info({ txRef, eventType }, "Duplicate Chapa webhook reprocessed safely");
    return res.status(200).json({ ok: true });
  } catch (error) {
    logger.error({ error }, "Chapa webhook processing failed");
    return res.status(500).json({ error: "Webhook processing failed" });
  }
});

router.post("/mini-app/leaderboard/refresh", async (req, res) => {
  try {
    const user = await authenticatedUser(req);
    const challenge = await getCurrentChallenge();
    await refreshChallengeScores(challenge);
    const state = await buildMiniAppState(user, challenge);
    res.json(GetMiniAppBootstrapResponse.parse(state));
  } catch (error) {
    const status = error instanceof MiniAppAuthError ? error.status : 503;
    if (status >= 500) logger.error({ error }, "Could not refresh Mini App leaderboard");
    res.status(status).json({ error: errorMessage(error) });
  }
});

export default router;

function requireAdmin(req: Request): boolean {
  const configured = process.env.GW_ADMIN_API_TOKEN?.trim();
  const provided = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : "";
  if (!configured || !provided || provided.length !== configured.length) return false;
  // Constant-time comparison prevents leaking the token length/bytes through
  // response timing differences.
  return timingSafeEqual(Buffer.from(provided), Buffer.from(configured));
}

router.post("/admin/gw/:competitionId/finalize", async (req, res) => {
  if (!requireAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const result = await finalizeCompetition(req.params.competitionId);
    return res.json(result);
  } catch (error) {
    logger.error({ error, competitionId: req.params.competitionId }, "GW competition finalization failed");
    return res.status(400).json({ error: error instanceof Error ? error.message : "Could not finalize competition" });
  }
});

router.get("/admin/gw/:competitionId/settlements", async (req, res) => {
  if (!requireAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
  try {
    const settlements = await db
      .select()
      .from(gwPrizeSettlements)
      .where(eq(gwPrizeSettlements.competitionId, req.params.competitionId))
      .orderBy(gwPrizeSettlements.rank, gwPrizeSettlements.id);
    return res.json({ competitionId: req.params.competitionId, settlements });
  } catch (error) {
    logger.error({ error, competitionId: req.params.competitionId }, "Could not list GW settlements");
    return res.status(500).json({ error: "Could not load settlements" });
  }
});

router.post("/admin/gw/settlements/:settlementId/paid", async (req, res) => {
  if (!requireAdmin(req)) return res.status(401).json({ error: "Unauthorized" });
  const settlementId = Number(req.params.settlementId);
  const payoutReference = typeof req.body?.payoutReference === "string" ? req.body.payoutReference.trim() : "";
  if (!Number.isSafeInteger(settlementId) || settlementId <= 0 || !payoutReference || payoutReference.length > 120) {
    return res.status(400).json({ error: "Invalid payout data" });
  }
  const settlement = await markPrizePaid(settlementId, payoutReference);
  return settlement ? res.json({ ok: true, settlement }) : res.status(409).json({ error: "Settlement is not pending or does not exist" });
});

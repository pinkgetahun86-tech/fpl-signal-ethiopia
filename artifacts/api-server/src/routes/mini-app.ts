import { timingSafeEqual } from "node:crypto";
import { Router, type IRouter, type Request } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  gwPrizeSettlements,
  weeklyChallengeEntries,
  walletDeposits,
  walletWithdrawals,
} from "@workspace/db";
import { GetMiniAppBootstrapResponse } from "@workspace/api-zod";
import { logger } from "../lib/logger";
import {
  buildMiniAppState,
  getMiniAppUser,
  MiniAppRequestError,
  saveMiniAppTeam,
} from "../telegram/mini-app";
import {
  authenticateMiniAppRequest,
  MiniAppAuthError,
} from "../telegram/mini-app-auth";
import {
  getCurrentChallenge,
  refreshChallengeScores,
} from "../telegram/bot";
import {
  ensureGwCompetition,
  getUserPayment,
  initializeChapaPayment,
  confirmPaymentFromProvider,
  isPaidCompetitionReady,
  recordChapaWebhookEvent,
  verifyChapaWebhookSignature,
} from "../telegram/gw-payment";
import {
  finalizeCompetition,
  markPrizePaid,
} from "../telegram/gw-settlement";
import {
  approveWalletDeposit,
  approveWalletWithdrawal,
  createManualTelebirrDeposit,
  createWalletWithdrawal,
  getWallet,
  getWalletTransactions,
  joinWeeklyChallengeWithWallet,
  listUserDeposits,
  listUserWithdrawals,
  markWalletWithdrawalPaid,
  rejectWalletDeposit,
  rejectWalletWithdrawal,
} from "../telegram/wallet";

const router: IRouter = Router();

function errorMessage(error: unknown): string {
  return error instanceof MiniAppRequestError
    ? error.message
    : error instanceof Error
      ? error.message
      : "ያልታወቀ የአገልግሎት ስህተት።";
}

async function authenticatedUser(req: Request) {
  const profile = authenticateMiniAppRequest(req);
  return getMiniAppUser(profile);
}

/* -------------------------------------------------------------------------- */
/* Mini App                                                                    */
/* -------------------------------------------------------------------------- */

router.get("/mini-app/bootstrap", async (req, res) => {
  try {
    const user = await authenticatedUser(req);
    const state = await buildMiniAppState(user);

    res.json(
      GetMiniAppBootstrapResponse.parse(state),
    );
  } catch (error) {
    const status =
      error instanceof MiniAppAuthError
        ? error.status
        : error instanceof MiniAppRequestError
          ? error.status
          : 503;

    if (status >= 500) {
      logger.error(
        { error },
        "Could not load Mini App bootstrap",
      );
    }

    res.status(status).json({
      error: errorMessage(error),
    });
  }
});

router.post("/mini-app/team", async (req, res) => {
  try {
    const user = await authenticatedUser(req);

    await saveMiniAppTeam(
      user,
      req.body,
    );

    const state = await buildMiniAppState(user);

    res.json(
      GetMiniAppBootstrapResponse.parse(state),
    );
  } catch (error) {
    const status =
      error instanceof MiniAppAuthError
        ? error.status
        : error instanceof MiniAppRequestError
          ? error.status
          : 503;

    if (status >= 500) {
      logger.error(
        { error },
        "Could not save Mini App team",
      );
    }

    res.status(status).json({
      error: errorMessage(error),
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Chapa payment                                                               */
/* -------------------------------------------------------------------------- */

router.post(
  "/mini-app/payment/initialize",
  async (req, res) => {
    try {
      if (!isPaidCompetitionReady()) {
        throw new MiniAppRequestError(
          "የክፍያ ስርዓቱ ገና ለሙከራ እየተዘጋጀ ነው።",
          503,
        );
      }

      const user = await authenticatedUser(req);
      const challenge =
        await getCurrentChallenge();

      if (challenge.locked) {
        throw new MiniAppRequestError(
          "🔒 የዚህ ሳምንት ምዝገባ ተዘግቷል።",
        );
      }

      const competition =
        await ensureGwCompetition(
          challenge,
        );

      const entry = await db
        .select({
          id: weeklyChallengeEntries.id,
        })
        .from(weeklyChallengeEntries)
        .where(
          and(
            eq(
              weeklyChallengeEntries.telegramUserId,
              user.id,
            ),
            eq(
              weeklyChallengeEntries.competitionId,
              challenge.competitionId,
            ),
          ),
        )
        .limit(1);

      if (!entry[0]) {
        throw new MiniAppRequestError(
          "መጀመሪያ የውድድሩን ቡድን ያስቀምጡ።",
        );
      }

      const payment =
        await initializeChapaPayment(
          competition,
          user,
          entry[0].id,
        );

      res.json({
        txRef: payment.txRef,
        checkoutUrl:
          payment.checkoutUrl,
        amountEtb:
          competition.entryFeeEtb,
        currency:
          competition.currency,
      });
    } catch (error) {
      const status =
        error instanceof MiniAppAuthError
          ? error.status
          : error instanceof MiniAppRequestError
            ? error.status
            : 503;

      if (status >= 500) {
        logger.error(
          { error },
          "Could not initialize Mini App payment",
        );
      }

      res.status(status).json({
        error: errorMessage(error),
      });
    }
  },
);

router.get(
  "/mini-app/payment/status",
  async (req, res) => {
    try {
      const user =
        await authenticatedUser(req);

      const challenge =
        await getCurrentChallenge();

      let payment =
        await getUserPayment(
          challenge.competitionId,
          user.id,
        );

      if (payment?.status === "pending") {
        try {
          await confirmPaymentFromProvider(
            payment.txRef,
          );

          payment =
            await getUserPayment(
              challenge.competitionId,
              user.id,
            );
        } catch (error) {
          logger.warn(
            {
              error,
              txRef: payment.txRef,
            },
            "Payment status verification skipped",
          );
        }
      }

      res.json({
        status:
          payment?.status ??
          "not_started",
        amountEtb:
          payment?.amountEtb ?? 0,
        currency:
          payment?.currency ?? "ETB",
      });
    } catch (error) {
      const status =
        error instanceof MiniAppAuthError
          ? error.status
          : 503;

      res.status(status).json({
        error: errorMessage(error),
      });
    }
  },
);

/* -------------------------------------------------------------------------- */
/* Wallet                                                                      */
/* -------------------------------------------------------------------------- */

router.get(
  "/mini-app/wallet",
  async (req, res) => {
    try {
      const user =
        await authenticatedUser(req);

      const wallet =
        await getWallet(user.id);

      return res.json({
        balanceEtb:
          wallet.balanceEtb,
        currency: "ETB",
      });
    } catch (error) {
      const status =
        error instanceof MiniAppAuthError
          ? error.status
          : 503;

      return res.status(status).json({
        error: errorMessage(error),
      });
    }
  },
);

router.get(
  "/mini-app/wallet/transactions",
  async (req, res) => {
    try {
      const user =
        await authenticatedUser(req);

      const transactions =
        await getWalletTransactions(
          user.id,
        );

      return res.json({
        transactions:
          transactions.map((item) => ({
            id: item.id,
            type: item.type,
            amountEtb:
              item.amountEtb,
            balanceAfterEtb:
              item.balanceAfterEtb,
            reference:
              item.reference,
            description:
              item.description,
            createdAt:
              item.createdAt.toISOString(),
          })),
      });
    } catch (error) {
      const status =
        error instanceof MiniAppAuthError
          ? error.status
          : 503;

      return res.status(status).json({
        error: errorMessage(error),
      });
    }
  },
);

router.get(
  "/mini-app/wallet/deposits",
  async (req, res) => {
    try {
      const user =
        await authenticatedUser(req);

      const deposits =
        await listUserDeposits(
          user.id,
        );

      return res.json({
        deposits:
          deposits.map((item) => ({
            id: item.id,
            method: item.method,
            amountEtb:
              item.amountEtb,
            transactionReference:
              item.transactionReference,
            status:
              item.status,
            adminNote:
              item.adminNote,
            approvedAt:
              item.approvedAt
                ?.toISOString() ??
              null,
            createdAt:
              item.createdAt.toISOString(),
          })),
      });
    } catch (error) {
      const status =
        error instanceof MiniAppAuthError
          ? error.status
          : 503;

      return res.status(status).json({
        error: errorMessage(error),
      });
    }
  },
);

router.post(
  "/mini-app/wallet/deposit/telebirr",
  async (req, res) => {
    try {
      const user =
        await authenticatedUser(req);

      const amountEtb =
        Number(
          req.body?.amountEtb,
        );

      const transactionReference =
        typeof req.body
          ?.transactionReference ===
        "string"
          ? req.body.transactionReference.trim()
          : "";

      if (
        !Number.isSafeInteger(
          amountEtb,
        ) ||
        amountEtb <= 0 ||
        !transactionReference
      ) {
        throw new MiniAppRequestError(
          "የገንዘብ መጠን እና የTelebirr Transaction Reference ትክክል ያስገቡ።",
        );
      }

      const deposit =
        await createManualTelebirrDeposit(
          user,
          amountEtb,
          transactionReference,
        );

      return res.status(201).json({
        id: deposit.id,
        status:
          deposit.status,
        amountEtb:
          deposit.amountEtb,
        transactionReference:
          deposit.transactionReference,
        method:
          deposit.method,
      });
    } catch (error) {
      const status =
        error instanceof MiniAppAuthError
          ? error.status
          : error instanceof MiniAppRequestError
            ? error.status
            : 503;

      return res.status(status).json({
        error: errorMessage(error),
      });
    }
  },
);

/* -------------------------------------------------------------------------- */
/* Wallet withdrawals                                                          */
/* -------------------------------------------------------------------------- */

router.get(
  "/mini-app/wallet/withdrawals",
  async (req, res) => {
    try {
      const user =
        await authenticatedUser(req);

      const withdrawals =
        await listUserWithdrawals(
          user.id,
        );

      return res.json({
        withdrawals:
          withdrawals.map((item) => ({
            id: item.id,
            method: item.method,
            amountEtb:
              item.amountEtb,
            destination:
              item.destination,
            status:
              item.status,
            payoutReference:
              item.payoutReference,
            adminNote:
              item.adminNote,
            approvedAt:
              item.approvedAt
                ?.toISOString() ??
              null,
            rejectedAt:
              item.rejectedAt
                ?.toISOString() ??
              null,
            paidAt:
              item.paidAt
                ?.toISOString() ??
              null,
            createdAt:
              item.createdAt.toISOString(),
          })),
      });
    } catch (error) {
      const status =
        error instanceof MiniAppAuthError
          ? error.status
          : 503;

      return res.status(status).json({
        error: errorMessage(error),
      });
    }
  },
);

router.post(
  "/mini-app/wallet/withdraw",
  async (req, res) => {
    try {
      const user =
        await authenticatedUser(req);

      const amountEtb =
        Number(
          req.body?.amountEtb,
        );

      const destination =
        typeof req.body?.destination ===
        "string"
          ? req.body.destination.trim()
          : "";

      if (
        !Number.isSafeInteger(
          amountEtb,
        ) ||
        amountEtb <= 0 ||
        !destination
      ) {
        throw new MiniAppRequestError(
          "የሚወጣውን የገንዘብ መጠን እና የTelebirr ቁጥር ትክክል ያስገቡ።",
        );
      }

      const withdrawal =
        await createWalletWithdrawal(
          user.id,
          amountEtb,
          destination,
        );

      const wallet =
        await getWallet(user.id);

      return res.status(201).json({
        withdrawal: {
  id:
    withdrawal.withdrawal.id,
  method:
    withdrawal.withdrawal.method,
  amountEtb:
    withdrawal.withdrawal.amountEtb,
  destination:
    withdrawal.withdrawal.destination,
  status:
    withdrawal.withdrawal.status,
  createdAt:
    withdrawal.withdrawal.createdAt.toISOString(),
},
        },
        wallet: {
          balanceEtb:
            wallet.balanceEtb,
          currency: "ETB",
        },
      });
    } catch (error) {
      const status =
        error instanceof MiniAppAuthError
          ? error.status
          : error instanceof MiniAppRequestError
            ? error.status
            : 400;

      return res.status(status).json({
        error: errorMessage(error),
      });
    }
  },
);

router.post(
  "/mini-app/wallet/entry",
  async (req, res) => {
    try {
      const user =
        await authenticatedUser(req);

      const challenge =
        await getCurrentChallenge();

      if (challenge.locked) {
        throw new MiniAppRequestError(
          "🔒 የዚህ ሳምንት ምዝገባ ተዘግቷል።",
        );
      }

      const competition =
        await ensureGwCompetition(
          challenge,
        );

      const entry = await db
        .select({
          id: weeklyChallengeEntries.id,
        })
        .from(weeklyChallengeEntries)
        .where(
          and(
            eq(
              weeklyChallengeEntries.telegramUserId,
              user.id,
            ),
            eq(
              weeklyChallengeEntries.competitionId,
              challenge.competitionId,
            ),
          ),
        )
        .limit(1);

      if (!entry[0]) {
        throw new MiniAppRequestError(
          "መጀመሪያ የውድድሩን ቡድን ያስቀምጡ።",
        );
      }

      const result =
        await joinWeeklyChallengeWithWallet(
          competition.id,
          user.id,
          entry[0].id,
        );

      const state =
        await buildMiniAppState(
          user,
          challenge,
        );

      const wallet =
        await getWallet(user.id);

      return res.json({
        ...state,
        wallet: {
          balanceEtb:
            wallet.balanceEtb,
          currency: "ETB",
        },
        payment: {
          method: "wallet",
          status: "success",
          amountEtb:
            competition.entryFeeEtb,
          alreadyConfirmed:
            result.alreadyConfirmed,
        },
      });
    } catch (error) {
      const status =
        error instanceof MiniAppAuthError
          ? error.status
          : error instanceof MiniAppRequestError
            ? error.status
            : 503;

      return res.status(status).json({
        error: errorMessage(error),
      });
    }
  },
);

/* -------------------------------------------------------------------------- */
/* Chapa callback + webhook                                                    */
/* -------------------------------------------------------------------------- */

router.get(
  "/payments/chapa/callback",
  async (req, res) => {
    const txRef =
      typeof req.query.trx_ref ===
      "string"
        ? req.query.trx_ref
        : typeof req.query.tx_ref ===
            "string"
          ? req.query.tx_ref
          : "";

    if (!txRef) {
      return res
        .status(400)
        .send(
          "የክፍያ መለያ አልተገኘም።",
        );
    }

    try {
      const success =
        await confirmPaymentFromProvider(
          txRef,
        );

      const returnUrl =
        process.env.MINI_APP_URL?.trim();

      if (returnUrl) {
        return res.redirect(
          returnUrl,
        );
      }

      return res
        .status(success ? 200 : 400)
        .send(
          success
            ? "ክፍያው ተረጋግጧል።"
            : "ክፍያው አልተረጋገጠም።",
        );
    } catch (error) {
      logger.error(
        { error, txRef },
        "Chapa callback verification failed",
      );

      return res
        .status(503)
        .send(
          "ክፍያውን ማረጋገጥ አልተቻለም።",
        );
    }
  },
);

router.post(
  "/payments/chapa/webhook",
  async (req, res) => {
    const rawBody = Buffer.isBuffer(
      req.body,
    )
      ? req.body
      : Buffer.from(
          JSON.stringify(req.body),
        );

    if (
      !verifyChapaWebhookSignature(
        rawBody,
        req.headers,
      )
    ) {
      return res
        .status(401)
        .json({
          error: "Unauthorized",
        });
    }

    try {
      const payload =
        JSON.parse(
          rawBody.toString("utf8"),
        ) as Record<
          string,
          unknown
        >;

      const data =
        typeof payload.data ===
          "object" &&
        payload.data !== null
          ? (payload.data as Record<
              string,
              unknown
            >)
          : payload;

      const txRef =
        typeof data.tx_ref ===
        "string"
          ? data.tx_ref
          : typeof data.trx_ref ===
              "string"
            ? data.trx_ref
            : "";

      const eventType =
        typeof payload.type ===
        "string"
          ? payload.type
          : typeof payload.event ===
              "string"
            ? payload.event
            : "transaction";

      if (!txRef) {
        return res.status(400).json({
          error:
            "Missing transaction reference",
        });
      }

      const fresh =
        await recordChapaWebhookEvent(
          txRef,
          eventType,
          payload,
        );

      await confirmPaymentFromProvider(
        txRef,
      );

      if (!fresh) {
        logger.info(
          {
            txRef,
            eventType,
          },
          "Duplicate Chapa webhook reprocessed safely",
        );
      }

      return res.status(200).json({
        ok: true,
      });
    } catch (error) {
      logger.error(
        { error },
        "Chapa webhook processing failed",
      );

      return res.status(500).json({
        error:
          "Webhook processing failed",
      });
    }
  },
);

/* -------------------------------------------------------------------------- */
/* Leaderboard                                                                 */
/* -------------------------------------------------------------------------- */

router.post(
  "/mini-app/leaderboard/refresh",
  async (req, res) => {
    try {
      const user =
        await authenticatedUser(req);

      const challenge =
        await getCurrentChallenge();

      await refreshChallengeScores(
        challenge,
      );

      const state =
        await buildMiniAppState(
          user,
          challenge,
        );

      res.json(
        GetMiniAppBootstrapResponse.parse(
          state,
        ),
      );
    } catch (error) {
      const status =
        error instanceof MiniAppAuthError
          ? error.status
          : 503;

      if (status >= 500) {
        logger.error(
          { error },
          "Could not refresh Mini App leaderboard",
        );
      }

      res.status(status).json({
        error: errorMessage(error),
      });
    }
  },
);

/* -------------------------------------------------------------------------- */
/* Admin                                                                       */
/* -------------------------------------------------------------------------- */

function requireAdmin(
  req: Request,
): boolean {
  const configured =
    process.env.GW_ADMIN_API_TOKEN?.trim();

  const provided =
    req.headers.authorization?.startsWith(
      "Bearer ",
    )
      ? req.headers.authorization
          .slice(7)
          .trim()
      : "";

  if (
    !configured ||
    !provided ||
    provided.length !==
      configured.length
  ) {
    return false;
  }

  return timingSafeEqual(
    Buffer.from(provided),
    Buffer.from(configured),
  );
}

/* ------------------------------ Deposits --------------------------------- */

router.get(
  "/admin/wallet/deposits",
  async (req, res) => {
    if (!requireAdmin(req)) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    try {
      const limitRaw =
        Number(
          req.query.limit ?? 100,
        );

      const limit =
        Number.isSafeInteger(
          limitRaw,
        )
          ? Math.min(
              Math.max(
                limitRaw,
                1,
              ),
              200,
            )
          : 100;

      const deposits = await db
        .select()
        .from(walletDeposits)
        .orderBy(
          desc(walletDeposits.id),
        )
        .limit(limit);

      return res.json({
        deposits,
      });
    } catch (error) {
      logger.error(
        { error },
        "Could not load wallet deposits",
      );

      return res.status(500).json({
        error:
          "Could not load wallet deposits",
      });
    }
  },
);

router.post(
  "/admin/wallet/deposits/:depositId/approve",
  async (req, res) => {
    if (!requireAdmin(req)) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    try {
      const depositId =
        Number(
          req.params.depositId,
        );

      const adminNote =
        typeof req.body?.adminNote ===
        "string"
          ? req.body.adminNote.trim()
          : undefined;

      const deposit =
        await approveWalletDeposit(
          depositId,
          adminNote,
        );

      return res.json({
        ok: true,
        deposit,
      });
    } catch (error) {
      return res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Could not approve deposit",
      });
    }
  },
);

router.post(
  "/admin/wallet/deposits/:depositId/reject",
  async (req, res) => {
    if (!requireAdmin(req)) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    try {
      const depositId =
        Number(
          req.params.depositId,
        );

      const adminNote =
        typeof req.body?.adminNote ===
        "string"
          ? req.body.adminNote.trim()
          : undefined;

      const deposit =
        await rejectWalletDeposit(
          depositId,
          adminNote,
        );

      return res.json({
        ok: true,
        deposit,
      });
    } catch (error) {
      return res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Could not reject deposit",
      });
    }
  },
);

/* ---------------------------- Withdrawals -------------------------------- */

router.get(
  "/admin/wallet/withdrawals",
  async (req, res) => {
    if (!requireAdmin(req)) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    try {
      const limitRaw =
        Number(
          req.query.limit ?? 100,
        );

      const limit =
        Number.isSafeInteger(
          limitRaw,
        )
          ? Math.min(
              Math.max(
                limitRaw,
                1,
              ),
              200,
            )
          : 100;

      const withdrawals =
        await db
          .select()
          .from(walletWithdrawals)
          .orderBy(
            desc(
              walletWithdrawals.createdAt,
            ),
          )
          .limit(limit);

      return res.json({
        withdrawals,
      });
    } catch (error) {
      logger.error(
        { error },
        "Could not load wallet withdrawals",
      );

      return res.status(500).json({
        error:
          "Could not load wallet withdrawals",
      });
    }
  },
);

router.post(
  "/admin/wallet/withdrawals/:withdrawalId/approve",
  async (req, res) => {
    if (!requireAdmin(req)) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    try {
      const withdrawalId =
        Number(
          req.params.withdrawalId,
        );

      const adminNote =
        typeof req.body?.adminNote ===
        "string"
          ? req.body.adminNote.trim()
          : undefined;

      const withdrawal =
        await approveWalletWithdrawal(
          withdrawalId,
          adminNote,
        );

      return res.json({
        ok: true,
        withdrawal,
      });
    } catch (error) {
      logger.error(
        {
          error,
          withdrawalId:
            req.params.withdrawalId,
        },
        "Could not approve wallet withdrawal",
      );

      return res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Could not approve withdrawal",
      });
    }
  },
);

router.post(
  "/admin/wallet/withdrawals/:withdrawalId/reject",
  async (req, res) => {
    if (!requireAdmin(req)) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    try {
      const withdrawalId =
        Number(
          req.params.withdrawalId,
        );

      const adminNote =
        typeof req.body?.adminNote ===
        "string"
          ? req.body.adminNote.trim()
          : undefined;

      const withdrawal =
        await rejectWalletWithdrawal(
          withdrawalId,
          adminNote,
        );

      return res.json({
        ok: true,
        withdrawal,
      });
    } catch (error) {
      logger.error(
        {
          error,
          withdrawalId:
            req.params.withdrawalId,
        },
        "Could not reject wallet withdrawal",
      );

      return res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Could not reject withdrawal",
      });
    }
  },
);

router.post(
  "/admin/wallet/withdrawals/:withdrawalId/paid",
  async (req, res) => {
    if (!requireAdmin(req)) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    try {
      const withdrawalId =
        Number(
          req.params.withdrawalId,
        );

      const payoutReference =
        typeof req.body
          ?.payoutReference ===
        "string"
          ? req.body.payoutReference.trim()
          : "";

      const adminNote =
        typeof req.body?.adminNote ===
        "string"
          ? req.body.adminNote.trim()
          : undefined;

      if (
        !Number.isSafeInteger(
          withdrawalId,
        ) ||
        withdrawalId <= 0 ||
        !payoutReference ||
        payoutReference.length > 120
      ) {
        return res.status(400).json({
          error:
            "Invalid payout data",
        });
      }

      const withdrawal =
        await markWalletWithdrawalPaid(
          withdrawalId,
          payoutReference,
          adminNote,
        );

      return res.json({
        ok: true,
        withdrawal,
      });
    } catch (error) {
      logger.error(
        {
          error,
          withdrawalId:
            req.params.withdrawalId,
        },
        "Could not mark wallet withdrawal paid",
      );

      return res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Could not mark withdrawal paid",
      });
    }
  },
);

/* ---------------------------- Competition -------------------------------- */

router.post(
  "/admin/gw/:competitionId/finalize",
  async (req, res) => {
    if (!requireAdmin(req)) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    try {
      const result =
        await finalizeCompetition(
          req.params.competitionId,
        );

      return res.json(result);
    } catch (error) {
      logger.error(
        {
          error,
          competitionId:
            req.params.competitionId,
        },
        "GW competition finalization failed",
      );

      return res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Could not finalize competition",
      });
    }
  },
);

router.get(
  "/admin/gw/:competitionId/settlements",
  async (req, res) => {
    if (!requireAdmin(req)) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    try {
      const settlements =
        await db
          .select()
          .from(gwPrizeSettlements)
          .where(
            eq(
              gwPrizeSettlements.competitionId,
              req.params
                .competitionId,
            ),
          )
          .orderBy(
            gwPrizeSettlements.rank,
            gwPrizeSettlements.id,
          );

      return res.json({
        competitionId:
          req.params.competitionId,
        settlements,
      });
    } catch (error) {
      logger.error(
        {
          error,
          competitionId:
            req.params.competitionId,
        },
        "Could not list GW settlements",
      );

      return res.status(500).json({
        error:
          "Could not load settlements",
      });
    }
  },
);

router.post(
  "/admin/gw/settlements/:settlementId/paid",
  async (req, res) => {
    if (!requireAdmin(req)) {
      return res.status(401).json({
        error: "Unauthorized",
      });
    }

    const settlementId =
      Number(
        req.params.settlementId,
      );

    const payoutReference =
      typeof req.body
        ?.payoutReference ===
      "string"
        ? req.body.payoutReference.trim()
        : "";

    if (
      !Number.isSafeInteger(
        settlementId,
      ) ||
      settlementId <= 0 ||
      !payoutReference ||
      payoutReference.length > 120
    ) {
      return res.status(400).json({
        error: "Invalid payout data",
      });
    }

    try {
      const settlement =
        await markPrizePaid(
          settlementId,
          payoutReference,
        );

      return settlement
        ? res.json({
            ok: true,
            settlement,
          })
        : res.status(409).json({
            error:
              "Settlement is not pending or does not exist",
          });
    } catch (error) {
      logger.error(
        {
          error,
          settlementId,
        },
        "Could not pay prize settlement",
      );

      return res.status(400).json({
        error:
          error instanceof Error
            ? error.message
            : "Could not pay prize settlement",
      });
    }
  },
);

export default router;

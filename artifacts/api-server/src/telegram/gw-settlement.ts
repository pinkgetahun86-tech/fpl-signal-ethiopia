import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db, gwCompetitions, gwPayments, gwPrizeSettlements, weeklyChallengeEntries } from "@workspace/db";
import { getCurrentGameweek } from "./fpl";
import { refreshChallengeScores } from "./bot";
import { createWeeklyChallenge, type WeeklyChallenge } from "./weekly-challenge";
import { logger } from "../lib/logger";
import { calculatePrizeShares } from "./prize-distribution";

const DEFAULT_PRIZE_PERCENTAGES = [60, 30, 10];

function prizePercentages(): number[] {
  const raw = process.env.GW_PRIZE_PERCENTAGES?.trim();
  if (!raw) return DEFAULT_PRIZE_PERCENTAGES;
  const values = raw.split(",").map(Number);
  if (values.length === 0 || values.length > 10 || values.some((v) => !Number.isInteger(v) || v < 0) || values.reduce((a, b) => a + b, 0) !== 100) {
    logger.warn({ raw }, "Invalid GW_PRIZE_PERCENTAGES; using 60/30/10");
    return DEFAULT_PRIZE_PERCENTAGES;
  }
  return values;
}

export async function syncCompetitionLifecycle(challenge: WeeklyChallenge): Promise<string> {
  const competition = await db.select().from(gwCompetitions).where(eq(gwCompetitions.id, challenge.competitionId)).limit(1).then((r) => r[0]);
  if (!competition) return "missing";
  if (competition.status === "settled" || competition.status === "cancelled") return competition.status;
  const fpl = await getCurrentGameweek();
  if (fpl.id !== competition.gameweek) return competition.status;
  if (!challenge.locked && competition.status !== "open") {
    await db.update(gwCompetitions).set({ status: "open", updatedAt: new Date() }).where(eq(gwCompetitions.id, competition.id));
    return "open";
  }
  if (challenge.locked && competition.status === "open") {
    await db.update(gwCompetitions).set({ status: "locked", updatedAt: new Date() }).where(eq(gwCompetitions.id, competition.id));
  }
  return challenge.locked ? "locked" : "open";
}

export async function finalizeCompetition(competitionId: string): Promise<{ status: string; winners: number }> {
  const competition = await db.select().from(gwCompetitions).where(eq(gwCompetitions.id, competitionId)).limit(1).then((r) => r[0]);
  if (!competition) throw new Error("Competition not found");
  if (competition.status === "settled") {
    return {
      status: "settled",
      winners: await db
        .select({ count: sql<number>`count(*)` })
        .from(gwPrizeSettlements)
        .where(eq(gwPrizeSettlements.competitionId, competitionId))
        .then((r) => Number(r[0]?.count ?? 0)),
    };
  }

  const fpl = await getCurrentGameweek();
  if (fpl.id === competition.gameweek && !fpl.finished) {
    throw new Error("የዚህ የጨዋታ ሳምንት ውጤት ገና አልተጠናቀቀም።");
  }
  if (competition.status === "open") throw new Error("ውድድሩ ገና አልተዘጋም።");

  // Hold the same competition lock used by successful payment confirmation for
  // the whole finalization transaction. This makes the pending-payment check,
  // prize-pool read and settlement write one serialized operation.
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fpl-gw-finalize:${competitionId}`}))`);

    const lockedCompetition = await tx
      .select()
      .from(gwCompetitions)
      .where(eq(gwCompetitions.id, competitionId))
      .limit(1)
      .then((r) => r[0]);
    if (!lockedCompetition) throw new Error("Competition not found");
    if (lockedCompetition.status === "settled") return;
    if (lockedCompetition.status === "open") throw new Error("ውድድሩ ገና አልተዘጋም።");

    const pendingPayments = await tx
      .select({ count: sql<number>`count(*)` })
      .from(gwPayments)
      .where(and(eq(gwPayments.competitionId, competitionId), eq(gwPayments.status, "pending")))
      .then((r) => Number(r[0]?.count ?? 0));
    if (pendingPayments > 0) {
      throw new Error(`ከ${pendingPayments} ተሳታፊ(ዎች) የሚመጣ ክፍያ ገና አልተረጋገጠም። ከመጨረሻ ውሳኔ በፊት ክፍያዎቹን ያረጋግጡ።`);
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
      .where(and(eq(weeklyChallengeEntries.competitionId, competitionId), eq(weeklyChallengeEntries.submissionStatus, "confirmed")))
      .orderBy(desc(weeklyChallengeEntries.points), asc(weeklyChallengeEntries.registeredAt), asc(weeklyChallengeEntries.id));

    if (entries.length === 0) {
      await tx
        .update(gwCompetitions)
        .set({ status: "settled", updatedAt: new Date() })
        .where(and(eq(gwCompetitions.id, competitionId), eq(gwCompetitions.status, "locked")));
      return;
    }

    const percentages = prizePercentages();
    const winnerGroups: { rank: number; ids: number[] }[] = [];
    let rank = 1;
    let i = 0;
    while (i < entries.length && rank <= percentages.length) {
      const points = entries[i].points;
      const ids: number[] = [];
      let j = i;
      while (j < entries.length && entries[j].points === points) {
        ids.push(entries[j].id);
        j++;
      }
      winnerGroups.push({ rank, ids });
      rank += ids.length;
      i = j;
    }

    const prizeInputs = winnerGroups.flatMap((group) => {
      const slots = Math.min(group.ids.length, percentages.length - group.rank + 1);
      if (slots <= 0) return [];
      const slotTotal = percentages
        .slice(group.rank - 1, group.rank - 1 + slots)
        .reduce((a, b) => a + b, 0);
      return group.ids.map((entryId) => {
        const entry = entries.find((e) => e.id === entryId)!;
        return {
          entryId,
          telegramUserId: entry.telegramUserId,
          rank: group.rank,
          percentage: slotTotal / group.ids.length,
        };
      });
    });

    const shares = calculatePrizeShares(lockedCompetition.prizePoolEtb, prizeInputs);
    const rows: Array<typeof gwPrizeSettlements.$inferInsert> = shares
      .filter((share) => share.amountEtb > 0)
      .map((share) => ({
        competitionId,
        telegramUserId: share.telegramUserId,
        entryId: share.entryId,
        rank: share.rank,
        amountEtb: share.amountEtb,
        status: "pending",
      }));

    if (rows.length > 0) await tx.insert(gwPrizeSettlements).values(rows);
    await tx
      .update(gwCompetitions)
      .set({ status: "settled", updatedAt: new Date() })
      .where(and(eq(gwCompetitions.id, competitionId), eq(gwCompetitions.status, "locked")));
  });

  return {
    status: "settled",
    winners: await db
      .select({ count: sql<number>`count(*)` })
      .from(gwPrizeSettlements)
      .where(eq(gwPrizeSettlements.competitionId, competitionId))
      .then((r) => Number(r[0]?.count ?? 0)),
  };
}

export async function markPrizePaid(settlementId: number, payoutReference: string) {
  const rows = await db.update(gwPrizeSettlements).set({ status: "paid", payoutReference, paidAt: new Date(), updatedAt: new Date() }).where(and(eq(gwPrizeSettlements.id, settlementId), eq(gwPrizeSettlements.status, "pending"))).returning();
  return rows[0] ?? null;
}

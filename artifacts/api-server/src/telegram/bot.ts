import { and, asc, desc, eq, sql } from "drizzle-orm";
import { pool } from "@workspace/db";
import {
  db,
  telegramUsers,
  type TelegramUser as DbTelegramUser,
  weeklyChallengeEntries,
} from "@workspace/db";
import { logger } from "../lib/logger";
import {
  answerCallbackQuery,
  getUpdates,
  sendMessage,
  setChatMenuButton,
} from "./client";
import {
  getCurrentGameweek,
  getFplPlayers,
  getLiveGameweekStats,
  type FplPlayer,
  type FplPosition,
} from "./fpl";
import { calculateWeeklyScore } from "./scoring";
import {
  BUDGET,
  getBudgetUsed,
  isCompleteSquad,
  STARTING_XI_LIMIT,
  POSITION_LIMITS,
  SQUAD_LIMIT,
  validateCaptainPair,
  validateStartingXI,
  validatePlayerAddition,
} from "./squad-rules";
import { createWeeklyChallenge, type WeeklyChallenge } from "./weekly-challenge";
import { ensureGwCompetition, PAID_COMPETITION_ENABLED } from "./gw-payment";
import type {
  TelegramCallbackQuery,
  TelegramInlineKeyboardButton,
  TelegramInlineKeyboardMarkup,
  TelegramMessage,
  TelegramUser as TelegramProfile,
  TelegramUpdate,
} from "./types";

let botStarted = false;
let botLeader = false;

// ReturnType<typeof pool.connect> resolves to the callback overload's `void`,
// so infer the client type through a call instead.
function acquirePoolClient() {
  return pool.connect();
}

type BotLockClient = Awaited<ReturnType<typeof acquirePoolClient>>;
let botLockClient: BotLockClient | undefined;
let botLockRetryTimer: ReturnType<typeof setInterval> | undefined;
let scoreRefreshTimer: ReturnType<typeof setInterval> | undefined;
let activeScoreRefresh: Promise<number> | undefined;
const SCORE_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const positionOrder: FplPosition[] = ["goalkeeper", "defender", "midfielder", "forward"];
const positionLabels: Record<FplPosition, string> = {
  goalkeeper: "ግብ ጠባቂዎች",
  defender: "ተከላካዮች",
  midfielder: "አማካዮች",
  forward: "አጥቂዎች",
};

function miniAppUrl(): string | undefined {
  const value = process.env["MINI_APP_URL"]?.trim();
  return value && /^https:\/\//i.test(value) ? value : undefined;
}

async function configureMiniAppLaunch(): Promise<void> {
  const url = miniAppUrl();
  if (!url) {
    logger.warn("MINI_APP_URL is not configured; Telegram Mini App launch button is disabled");
    return;
  }
  try {
    await setChatMenuButton({
      type: "web_app",
      text: "FPL ኤፕ",
      web_app: { url },
    });
    logger.info({ url }, "Configured Telegram Mini App menu button");
  } catch (error) {
    logger.warn({ error }, "Could not configure Telegram Mini App menu button");
  }
}

function chatIdOf(message: TelegramMessage | undefined): string | undefined {
  if (!message) return undefined;
  return String(message.chat.id);
}

export async function findOrCreateUser(
  chatId: string,
  profile?: TelegramProfile,
): Promise<DbTelegramUser> {
  const existing = await db
    .select()
    .from(telegramUsers)
    .where(eq(telegramUsers.telegramChatId, chatId))
    .limit(1);
  if (existing[0]) {
    const firstName = profile?.first_name ?? existing[0].firstName;
    const username = profile?.username ?? existing[0].username;
    if (firstName !== existing[0].firstName || username !== existing[0].username) {
      const updated = await db
        .update(telegramUsers)
        .set({ firstName, username, updatedAt: new Date() })
        .where(eq(telegramUsers.telegramChatId, chatId))
        .returning();
      return updated[0] ?? existing[0];
    }
    return existing[0];
  }

  const inserted = await db
    .insert(telegramUsers)
    .values({
      telegramChatId: chatId,
      firstName: profile?.first_name,
      username: profile?.username,
      flowState: "new",
      selectedPlayerIds: [],
    })
    .returning();
  if (!inserted[0]) throw new Error("Could not create Telegram user");
  return inserted[0];
}

export async function updateUser(
  chatId: string,
  values: Partial<
    Pick<
      DbTelegramUser,
      | "firstName"
       | "username"
      | "flowState"
      | "selectedPlayerIds"
      | "startingPlayerIds"
      | "captainPlayerId"
       | "viceCaptainPlayerId"
    >
  >,
): Promise<DbTelegramUser> {
  const updated = await db
    .update(telegramUsers)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(telegramUsers.telegramChatId, chatId))
    .returning();
  if (!updated[0]) throw new Error("Could not update Telegram user");
  return updated[0];
}

export async function registerTeamForCurrentChallenge(
  user: DbTelegramUser,
  challenge: WeeklyChallenge,
  selected: FplPlayer[],
  starting: FplPlayer[],
  bench: FplPlayer[],
  captain: FplPlayer,
  viceCaptain: FplPlayer,
): Promise<boolean> {
  await ensureGwCompetition(challenge);
  const targetStatus = PAID_COMPETITION_ENABLED ? "awaiting_payment" : "confirmed";
  const teamValues = {
    gameweek: challenge.gameweek,
    selectedPlayerIds: selected.map((player) => player.id),
    startingPlayerIds: starting.map((player) => player.id),
    benchPlayerIds: bench.map((player) => player.id),
    captainPlayerId: captain.id,
    viceCaptainPlayerId: viceCaptain.id,
    updatedAt: new Date(),
  };

  // Insert on first submission, update the existing entry on re-submission.
  // A unique index covers (telegram_user_id, competition_id); without this
  // upsert path a second confirmation would silently do nothing and the
  // user's team edits would never be saved.
  const inserted = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`fpl-entry:${user.id}:${challenge.competitionId}`}))`,
    );

    const existing = await tx
      .select({
        id: weeklyChallengeEntries.id,
        submissionStatus: weeklyChallengeEntries.submissionStatus,
      })
      .from(weeklyChallengeEntries)
      .where(
        and(
          eq(weeklyChallengeEntries.telegramUserId, user.id),
          eq(weeklyChallengeEntries.competitionId, challenge.competitionId),
        ),
      )
      .limit(1);

    if (existing[0]) {
      // A confirmed entry (e.g. already paid) must not lose its status; a
      // not-yet-confirmed entry follows the current competition flow.
      await tx
        .update(weeklyChallengeEntries)
        .set({
          ...teamValues,
          submissionStatus:
            existing[0].submissionStatus === "confirmed"
              ? "confirmed"
              : targetStatus,
        })
        .where(eq(weeklyChallengeEntries.id, existing[0].id));
      return false;
    }

    const rows = await tx
      .insert(weeklyChallengeEntries)
      .values({
        telegramUserId: user.id,
        competitionId: challenge.competitionId,
        ...teamValues,
        submissionStatus: targetStatus,
        points: 0,
        pointsSource: "pending",
      })
      .onConflictDoNothing({
        target: [
          weeklyChallengeEntries.telegramUserId,
          weeklyChallengeEntries.competitionId,
        ],
      })
      .returning({ id: weeklyChallengeEntries.id });
    return rows.length > 0;
  });

  // Rescore for both new entries and edits so the leaderboard reflects the
  // submitted team immediately.
  try {
    await refreshChallengeScores(challenge);
  } catch (error) {
    logger.warn(
      { error, gameweek: challenge.gameweek },
      "Weekly Challenge score refresh after team save skipped",
    );
  }
  return inserted;
}

export async function getCurrentChallenge(): Promise<WeeklyChallenge> {
  return createWeeklyChallenge(await getCurrentGameweek());
}

export async function loadChallengeLeaderboard(challenge: WeeklyChallenge) {
  return db
    .select({
      id: weeklyChallengeEntries.id,
      telegramUserId: weeklyChallengeEntries.telegramUserId,
      displayName: telegramUsers.firstName,
      username: telegramUsers.username,
      points: weeklyChallengeEntries.points,
      registeredAt: weeklyChallengeEntries.registeredAt,
      lastUpdatedAt: weeklyChallengeEntries.lastPointsUpdatedAt,
    })
    .from(weeklyChallengeEntries)
    .innerJoin(telegramUsers, eq(weeklyChallengeEntries.telegramUserId, telegramUsers.id))
    .where(
      and(
        eq(weeklyChallengeEntries.competitionId, challenge.competitionId),
        eq(weeklyChallengeEntries.submissionStatus, "confirmed"),
      ),
    )
    .orderBy(
      desc(weeklyChallengeEntries.points),
      asc(weeklyChallengeEntries.registeredAt),
      asc(weeklyChallengeEntries.id),
    )
    .limit(100);
}

async function loadLatestChallengeForUser(userId: number): Promise<WeeklyChallenge | undefined> {
  const entry = await db
    .select({
      competitionId: weeklyChallengeEntries.competitionId,
      gameweek: weeklyChallengeEntries.gameweek,
    })
    .from(weeklyChallengeEntries)
    .where(eq(weeklyChallengeEntries.telegramUserId, userId))
    .orderBy(desc(weeklyChallengeEntries.gameweek), desc(weeklyChallengeEntries.id))
    .limit(1);
  if (!entry[0]) return undefined;
  return {
    competitionId: entry[0].competitionId,
    gameweek: entry[0].gameweek,
    deadlineTime: null,
    locked: true,
  };
}

function sameIds(first: number[], second: number[]): boolean {
  return first.length === second.length && first.every((id, index) => id === second[index]);
}

async function refreshChallengeScoresInternal(challenge: WeeklyChallenge): Promise<number> {
  const entries = await db
    .select()
    .from(weeklyChallengeEntries)
    .where(eq(weeklyChallengeEntries.competitionId, challenge.competitionId));
  if (entries.length === 0) return 0;

  const [players, liveStats] = await Promise.all([
    getFplPlayers(),
    getLiveGameweekStats(challenge.gameweek),
  ]);
  let updatedCount = 0;
  for (const entry of entries) {
    const benchPlayerIds =
      entry.benchPlayerIds.length > 0
        ? entry.benchPlayerIds
        : entry.selectedPlayerIds.filter((id) => !entry.startingPlayerIds.includes(id));
    let score;
    try {
      score = calculateWeeklyScore(
        {
          selectedPlayerIds: entry.selectedPlayerIds,
          startingPlayerIds: entry.startingPlayerIds,
          benchPlayerIds,
          captainPlayerId: entry.captainPlayerId,
          viceCaptainPlayerId: entry.viceCaptainPlayerId,
        },
        players,
        liveStats,
      );
    } catch (error) {
      logger.error(
        { error, entryId: entry.id },
        "Skipping invalid Weekly Challenge entry during score refresh",
      );
      continue;
    }
    if (
      entry.points !== score.totalPoints ||
      entry.pointsSource !== "fpl-live" ||
      !sameIds(entry.scoredPlayerIds ?? [], score.scoredPlayerIds)
    ) {
      await db
        .update(weeklyChallengeEntries)
        .set({
          points: score.totalPoints,
          pointsSource: "fpl-live",
          scoredPlayerIds: score.scoredPlayerIds,
          lastPointsUpdatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(weeklyChallengeEntries.id, entry.id));
      updatedCount += 1;
      if (score.substitutions.length > 0) {
        logger.info(
          { entryId: entry.id, substitutions: score.substitutions },
          "Applied automatic Weekly Challenge substitutions",
        );
      }
      if (
        liveStats.get(entry.captainPlayerId)?.minutes === 0 &&
        entry.viceCaptainPlayerId !== null &&
        (liveStats.get(entry.viceCaptainPlayerId)?.minutes ?? 0) > 0
      ) {
        logger.info(
          { entryId: entry.id, captainPlayerId: entry.captainPlayerId, viceCaptainPlayerId: entry.viceCaptainPlayerId },
          "Applied Weekly Challenge vice-captain fallback",
        );
      }
      logger.info(
        { entryId: entry.id, gameweek: challenge.gameweek, points: score.totalPoints },
        "Updated Weekly Challenge score",
      );
    }
  }
  return updatedCount;
}

export async function refreshChallengeScores(challenge: WeeklyChallenge): Promise<number> {
  if (activeScoreRefresh) return activeScoreRefresh;
  const refresh = refreshChallengeScoresInternal(challenge);
  activeScoreRefresh = refresh;
  try {
    return await refresh;
  } finally {
    if (activeScoreRefresh === refresh) activeScoreRefresh = undefined;
  }
}

async function sendLeaderboardScreen(
  chatId: string,
  user: DbTelegramUser,
  refresh = false,
): Promise<void> {
  let challenge: WeeklyChallenge | undefined;
  let notice: string | undefined;
  try {
    challenge = await getCurrentChallenge();
  } catch (error) {
    logger.error({ error, chatId }, "Could not load current FPL gameweek for leaderboard");
    challenge = await loadLatestChallengeForUser(user.id);
    if (!challenge) {
      await sendMessage(chatId, "⚠️ የFPL ቀጥታ መረጃ ለጊዜው አልተገኘም። እባክዎ እንደገና ይሞክሩ።");
      return;
    }
    notice = "⚠️ የFPL መረጃ ስላልተገኘ የመጨረሻው የተቀመጠ ውጤት ታይቷል።";
  }

  if (refresh) {
    try {
      await refreshChallengeScores(challenge);
      notice = "✅ የደረጃ ሰንጠረዥ በቅርብ የFPL መረጃ ታድሷል።";
    } catch (error) {
      logger.error(
        { error, gameweek: challenge.gameweek },
        "Could not refresh Weekly Challenge scores",
      );
      notice = "⚠️ የFPL ቀጥታ መረጃ ለጊዜው አልተገኘም። የቀድሞ ውጤቶች አልተሰረዙም።";
    }
  }

  const entries = await loadChallengeLeaderboard(challenge);
  const lines = entries.length
    ? [
        "ደረጃ | ስም | ነጥብ",
        ...entries.map(
          (entry, index) =>
            `${index + 1}. ${entry.displayName?.trim() || (entry.username ? `@${entry.username}` : "ስም ያልተጠቀሰ")} — ${entry.points} ነጥብ`,
        ),
      ]
    : ["በዚህ ሳምንታዊ ፈተና እስካሁን የተመዘገበ ቡድን የለም።"];

  await sendMessage(
    chatId,
    [
      "📊 የደረጃ ሰንጠረዥ",
      "",
      `🏆 የሳምንታዊ ፈተና — የጨዋታ ሳምንት ${challenge.gameweek}`,
      "",
      ...lines,
      "",
      notice ?? "ℹ️ ነጥቦች ከኦፊሴላዊ የFPL የጨዋታ ሳምንት ውጤት ይሰላሉ።",
    ].join("\n"),
    {
      inline_keyboard: [
        [{ text: "🔄 ደረጃ ሰንጠረዥ አድስ", callback_data: "refresh_leaderboard" }],
      ],
    },
  );
}

function positionShortLabel(position: FplPosition): string {
  return {
    goalkeeper: "ግጠ",
    defender: "ተከ",
    midfielder: "አማ",
    forward: "አጥ",
  }[position];
}

function formatPrice(price: number): string {
  return `£${price.toFixed(1)}m`;
}

function summaryText(selected: FplPlayer[]): string {
  const used = getBudgetUsed(selected);
  const counts = Object.fromEntries(
    positionOrder.map((position) => [
      position,
      selected.filter((player) => player.position === position).length,
    ]),
  ) as Record<FplPosition, number>;

  return [
    `📋 የቡድንዎ ማጠቃለያ`,
    ``,
    `የተመረጡ: ${selected.length}/${SQUAD_LIMIT}`,
    `የቀረ በጀት: £${(BUDGET - used).toFixed(1)}m`,
    `ግብ ጠባቂዎች: ${counts.goalkeeper}/${POSITION_LIMITS.goalkeeper}`,
    `ተከላካዮች: ${counts.defender}/${POSITION_LIMITS.defender}`,
    `አማካዮች: ${counts.midfielder}/${POSITION_LIMITS.midfielder}`,
    `አጥቂዎች: ${counts.forward}/${POSITION_LIMITS.forward}`,
  ].join("\n");
}

function playerButton(player: FplPlayer): TelegramInlineKeyboardButton {
  return {
    text: `➕ ${player.name} · ${player.club} · ${formatPrice(player.price)}`,
    callback_data: `pick:${player.id}`,
  };
}

function squadScreen(
  players: FplPlayer[],
  selected: FplPlayer[],
  position: FplPosition = "goalkeeper",
  page = 0,
): { text: string; markup: TelegramInlineKeyboardMarkup } {
  const complete = isCompleteSquad(selected);
  const available = players.filter((player) => player.position === position);
  const pageSize = 8;
  const totalPages = Math.max(1, Math.ceil(available.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), totalPages - 1);
  const pagePlayers = available.slice(safePage * pageSize, (safePage + 1) * pageSize);
  const keyboard: TelegramInlineKeyboardButton[][] = [];

  for (const player of pagePlayers) {
    keyboard.push([playerButton(player)]);
  }

  const pager: TelegramInlineKeyboardButton[] = [];
  if (safePage > 0) {
    pager.push({
      text: "◀️ ቀዳሚ",
      callback_data: `page:${position}:${safePage - 1}`,
    });
  }
  if (safePage < totalPages - 1) {
    pager.push({
      text: "ቀጣይ ▶️",
      callback_data: `page:${position}:${safePage + 1}`,
    });
  }
  if (pager.length) keyboard.push(pager);

  keyboard.push(
    positionOrder.map((item) => ({
      text: `${positionShortLabel(item)} ${selected.filter((player) => player.position === item).length}/${POSITION_LIMITS[item]}`,
      callback_data: `position:${item}`,
    })),
  );

  if (selected.length > 0) {
    keyboard.push([
      {
        text: "🧾 የተመረጡትን አሳይ",
        callback_data: "selected",
      },
    ]);
  }
  if (complete) {
    keyboard.push([
      {
        text: "🎯 የመጀመሪያ 11 ምረጥ",
        callback_data: "starting_xi",
      },
    ]);
  }

  const heading = complete
    ? "🎉 15 ተጫዋቾችዎ ተሟልተዋል!\n\n🎯 የመጀመሪያ 11 ምረጥ"
    : `⚽ ተጫዋቾችዎን ይምረጡ\n\n${positionLabels[position]} — ገጽ ${safePage + 1}/${totalPages}`;
  return {
    text: `${heading}\n\n${summaryText(selected)}`,
    markup: { inline_keyboard: keyboard },
  };
}

function selectedScreen(selected: FplPlayer[]): {
  text: string;
  markup: TelegramInlineKeyboardMarkup;
} {
  const rows = selected.map((player) => [
    {
      text: `❌ ${player.name} · ${formatPrice(player.price)}`,
      callback_data: `remove:${player.id}`,
    },
  ]);
  rows.push([{ text: "⚽ ወደ ተጫዋቾች ተመለስ", callback_data: "position:goalkeeper" }]);
  return {
    text: `${summaryText(selected)}\n\nየተመረጡት ተጫዋቾች፦`,
    markup: { inline_keyboard: rows },
  };
}

function playersForIds(ids: number[], players: FplPlayer[]): FplPlayer[] {
  const playersById = new Map(players.map((player) => [player.id, player]));
  return ids
    .map((id) => playersById.get(id))
    .filter((player): player is FplPlayer => player !== undefined);
}

async function loadSelection(user: DbTelegramUser, players: FplPlayer[]): Promise<FplPlayer[]> {
  return playersForIds(user.selectedPlayerIds, players);
}

function playerList(players: FplPlayer[]): string {
  return players.length
    ? players
        .map((player, index) => `${index + 1}. ${player.name} · ${formatPrice(player.price)}`)
        .join("\n")
    : "—";
}

function startingXIForUser(user: DbTelegramUser, selected: FplPlayer[]): FplPlayer[] {
  return playersForIds(user.startingPlayerIds, selected);
}

function startingXIScreen(
  selected: FplPlayer[],
  starting: FplPlayer[],
): { text: string; markup: TelegramInlineKeyboardMarkup } {
  const startingIds = new Set(starting.map((player) => player.id));
  const keyboard: TelegramInlineKeyboardButton[][] = selected.map((player) => [
    {
      text: `${startingIds.has(player.id) ? "✅" : "⬜"} ${player.name} · ${positionShortLabel(player.position)}`,
      callback_data: `xi_toggle:${player.id}`,
    },
  ]);

  const validation = starting.length === STARTING_XI_LIMIT
    ? validateStartingXI(starting)
    : undefined;
  const nextButton =
    validation?.ok === true
      ? [{ text: "👑 ካፒቴን ምረጥ", callback_data: "captain_select" }]
      : [];
  if (nextButton.length) keyboard.push(nextButton);
  keyboard.push([{ text: "⚽ ወደ ቡድን ምርጫ ተመለስ", callback_data: "back_to_squad" }]);

  const status = validation
    ? validation.ok
      ? "✅ የመጀመሪያ 11 ትክክለኛ ነው። ካፒቴን ለመምረጥ ከታች ያለውን ቁልፍ ይጫኑ።"
      : `⚠️ ${validation.message}`
    : `እስካሁን ${starting.length}/${STARTING_XI_LIMIT} ተጫዋቾች መርጠዋል።`;

  return {
    text: [
      "🎯 የመጀመሪያ 11 ምርጫ",
      "",
      "ከ15 ተጫዋቾችዎ 11 ይምረጡ። ቀሪዎቹ 4 በራስ-ሰር ተቀያሪ ይሆናሉ።",
      "ህጉ: 1 ግብ ጠባቂ፣ ቢያንስ 3 ተከላካይ፣ 2 አማካይ እና 1 አጥቂ።",
      "",
      status,
      "",
      ...selected.map(
        (player) =>
          `${startingIds.has(player.id) ? "✅" : "⬜"} ${player.name} · ${positionLabels[player.position]} · ${formatPrice(player.price)}`,
      ),
    ].join("\n"),
    markup: { inline_keyboard: keyboard },
  };
}

function captainScreen(
  starting: FplPlayer[],
): { text: string; markup: TelegramInlineKeyboardMarkup } {
  return {
    text: [
      "👑 ካፒቴንዎን ይምረጡ",
      "",
      "ካፒቴንዎ በየጨዋታው 2x ነጥብ ያገኛል። ከመጀመሪያ 11 ውስጥ አንድ ተጫዋች ብቻ ይምረጡ።",
      "",
      ...starting.map((player) => `• ${player.name} · ${positionLabels[player.position]} · ${formatPrice(player.price)}`),
    ].join("\n"),
    markup: {
      inline_keyboard: starting.map((player) => [
        {
          text: `👑 ${player.name}`,
          callback_data: `captain:${player.id}`,
        },
      ]).concat([[{ text: "🎯 ወደ መጀመሪያ 11 ተመለስ", callback_data: "back_to_xi" }]]),
    },
  };
}

function viceCaptainScreen(
  starting: FplPlayer[],
  captain: FplPlayer,
): { text: string; markup: TelegramInlineKeyboardMarkup } {
  const candidates = starting.filter((player) => player.id !== captain.id);
  return {
    text: [
      "🛡️ ምትክ ካፒቴንዎን ይምረጡ",
      "",
      "ካፒቴንዎ ካልተጫወተ ምትክ ካፒቴንዎ 2x ነጥብ ያገኛል። ካፒቴን ከተጫወተ ምትክ ካፒቴን መደበኛ ነጥብ ያገኛል።",
      "",
      `👑 ካፒቴን: ${captain.name}`,
      "",
      ...candidates.map(
        (player) =>
          `• ${player.name} · ${positionLabels[player.position]} · ${formatPrice(player.price)}`,
      ),
    ].join("\n"),
    markup: {
      inline_keyboard: candidates
        .map((player) => [
          {
            text: `🛡️ ${player.name}`,
            callback_data: `vice_captain:${player.id}`,
          },
        ])
        .concat([[{ text: "👑 ወደ ካፒቴን ምርጫ ተመለስ", callback_data: "back_to_captain" }]]),
    },
  };
}

function confirmationScreen(
  selected: FplPlayer[],
  starting: FplPlayer[],
  captain: FplPlayer,
  viceCaptain: FplPlayer | undefined,
  confirmed = false,
  registrationMessage?: string,
): { text: string; markup?: TelegramInlineKeyboardMarkup } {
  const startingIds = new Set(starting.map((player) => player.id));
  const substitutes = selected.filter((player) => !startingIds.has(player.id));
  const text = [
    confirmed ? "✅ ቡድንዎ ተረጋግጧል!" : "📝 የቡድንዎ የመጨረሻ ማረጋገጫ",
    "",
    "🏟️ የመጀመሪያ 11:",
    playerList(starting),
    "",
    "🪑 ተቀያሪዎች (4):",
    playerList(substitutes),
    "",
    `👑 ካፒቴን: ${captain.name} — 2x ነጥብ`,
    `🛡️ ምትክ ካፒቴን: ${viceCaptain?.name ?? "አልተመረጠም"}`,
    `💰 ጠቅላላ የቡድን ዋጋ: ${formatPrice(getBudgetUsed(selected))}`,
    "",
    confirmed
      ? registrationMessage ??
        "✅ ቡድንዎ በዚህ ሳምንታዊ ፈተና በተሳካ ሁኔታ ተመዝግቧል።"
      : "ሁሉም መረጃ ትክክል ከሆነ ከታች ያለውን ይጫኑ።",
  ].join("\n");

  return {
    text,
    ...(confirmed
      ? {}
      : {
          markup: {
            inline_keyboard: [
              [{ text: "✅ ቡድኔን አረጋግጥ", callback_data: "confirm_team" }],
              [{ text: "👑 ካፒቴን ቀይር", callback_data: "back_to_captain" }],
            ],
          },
        }),
    ...(confirmed
      ? {
          markup: {
            inline_keyboard: [
              [{ text: "📊 የደረጃ ሰንጠረዥ", callback_data: "leaderboard" }],
              [{ text: "🔄 ደረጃ ሰንጠረዥ አድስ", callback_data: "refresh_leaderboard" }],
            ],
          },
        }
      : {}),
  };
}

async function sendSquadScreen(chatId: string, user: DbTelegramUser, position?: FplPosition) {
  const players = await getFplPlayers();
  const selected = await loadSelection(user, players);
  const screen = squadScreen(players, selected, position, 0);
  await sendMessage(chatId, screen.text, screen.markup);
}

async function sendStartingXIScreen(chatId: string, user: DbTelegramUser, players?: FplPlayer[]) {
  const availablePlayers = players ?? (await getFplPlayers());
  const selected = await loadSelection(user, availablePlayers);
  const starting = startingXIForUser(user, selected);
  const screen = startingXIScreen(selected, starting);
  await sendMessage(chatId, screen.text, screen.markup);
}

async function sendCaptainScreen(chatId: string, user: DbTelegramUser, players?: FplPlayer[]) {
  const availablePlayers = players ?? (await getFplPlayers());
  const selected = await loadSelection(user, availablePlayers);
  const starting = startingXIForUser(user, selected);
  const screen = captainScreen(starting);
  await sendMessage(chatId, screen.text, screen.markup);
}

async function sendViceCaptainScreen(
  chatId: string,
  user: DbTelegramUser,
  players?: FplPlayer[],
) {
  const availablePlayers = players ?? (await getFplPlayers());
  const selected = await loadSelection(user, availablePlayers);
  const starting = startingXIForUser(user, selected);
  const captain = starting.find((player) => player.id === user.captainPlayerId);
  if (!captain) throw new Error("Captain is not part of the persisted starting XI");
  const screen = viceCaptainScreen(starting, captain);
  await sendMessage(chatId, screen.text, screen.markup);
}

async function sendConfirmationScreen(
  chatId: string,
  user: DbTelegramUser,
  confirmed = false,
  players?: FplPlayer[],
  registrationMessage?: string,
) {
  const availablePlayers = players ?? (await getFplPlayers());
  const selected = await loadSelection(user, availablePlayers);
  const starting = startingXIForUser(user, selected);
  const captain = starting.find((player) => player.id === user.captainPlayerId);
  if (!captain) {
    throw new Error("Captain is not part of the persisted starting XI");
  }
  const screen = confirmationScreen(
    selected,
    starting,
    captain,
    starting.find((player) => player.id === user.viceCaptainPlayerId),
    confirmed,
    registrationMessage,
  );
  await sendMessage(chatId, screen.text, screen.markup);
}

async function acknowledgeCallback(callbackQueryId: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackQueryId);
  } catch (error) {
    // An expired callback query must not prevent the selection from being saved.
    logger.warn({ err: error }, "Could not acknowledge Telegram callback query");
  }
}

async function sendSafeMessage(chatId: string, text: string): Promise<void> {
  try {
    await sendMessage(chatId, text);
  } catch (error) {
    logger.error({ err: error, chatId }, "Could not send Telegram user-facing error");
  }
}

async function ensureChallengeOpen(chatId: string): Promise<WeeklyChallenge | undefined> {
  try {
    const challenge = await getCurrentChallenge();
    if (challenge.locked) {
      await sendMessage(
        chatId,
        `🔒 የጨዋታ ሳምንት ${challenge.gameweek} ተቆልፏል። ለሚቀጥለው ሳምንት ይጠብቁ።`,
      );
      return undefined;
    }
    return challenge;
  } catch (error) {
    logger.error({ error, chatId }, "Could not verify Weekly Challenge deadline");
    await sendMessage(chatId, "⚠️ የFPL የጨዋታ ሳምንት መረጃ ለጊዜው አልተገኘም። እባክዎ ቆይተው ይሞክሩ።");
    return undefined;
  }
}

async function handleRegistration(
  chatId: string,
  message: TelegramMessage,
  profile?: TelegramProfile,
): Promise<void> {
  const user = await findOrCreateUser(chatId, profile);
  if (user.flowState === "awaiting_name") {
    const name = message.text?.trim();
    if (!name || name.length < 2 || name.length > 80) {
      await sendMessage(chatId, "እባክዎ ትክክለኛ ስም ያስገቡ።");
      return;
    }

    const registered = await updateUser(chatId, {
      firstName: name,
      flowState: "building_squad",
      selectedPlayerIds: [],
      startingPlayerIds: [],
      captainPlayerId: null,
      viceCaptainPlayerId: null,
    });
    await sendMessage(chatId, `እንኳን ደህና መጡ ${name}! ምዝገባዎ ተሳክቷል።`);
    try {
      await sendSquadScreen(chatId, registered);
    } catch (error) {
      logger.error({ error, chatId }, "Could not load FPL players after registration");
      await sendMessage(
        chatId,
        "የ2026/27 FPL ተጫዋቾች መረጃ አሁን ሊጫን አልቻለም። እባክዎ በትንሹ ቆይተው /start ይላኩ።",
      );
    }
    return;
  }

  if (user.flowState === "new") {
    await updateUser(chatId, { flowState: "awaiting_name" });
    await sendMessage(chatId, "ለመመዝገብ ሙሉ ስምዎን ይጻፉ።");
    return;
  }

  if (user.flowState === "building_squad") {
    try {
      await sendSquadScreen(chatId, user);
    } catch (error) {
      logger.error({ error, chatId }, "Could not reload FPL players");
      await sendMessage(chatId, "የተጫዋቾች መረጃ አሁን አልተገኘም። እባክዎ ቆይተው እንደገና ይሞክሩ።");
    }
    return;
  }

  if (user.flowState === "selecting_xi") {
    try {
      await sendStartingXIScreen(chatId, user);
    } catch (error) {
      logger.error({ error, chatId }, "Could not reload starting XI selection");
      await sendMessage(chatId, "የቡድን መረጃዎ አሁን ሊጫን አልቻለም። እባክዎ ቆይተው እንደገና ይሞክሩ።");
    }
    return;
  }

  if (user.flowState === "selecting_captain") {
    try {
      await sendCaptainScreen(chatId, user);
    } catch (error) {
      logger.error({ error, chatId }, "Could not reload captain selection");
      await sendMessage(chatId, "የካፒቴን ምርጫዎ አሁን ሊጫን አልቻለም። እባክዎ ቆይተው ይሞክሩ።");
    }
    return;
  }

  if (user.flowState === "selecting_vice_captain") {
    try {
      await sendViceCaptainScreen(chatId, user);
    } catch (error) {
      logger.error({ error, chatId }, "Could not reload vice-captain selection");
      await sendMessage(chatId, "የምትክ ካፒቴን ምርጫዎ አሁን ሊጫን አልቻለም። እባክዎ ቆይተው ይሞክሩ።");
    }
    return;
  }

  if (user.flowState === "confirming_team" || user.flowState === "team_confirmed") {
    try {
      await sendConfirmationScreen(chatId, user, user.flowState === "team_confirmed");
    } catch (error) {
      logger.error({ error, chatId }, "Could not reload team confirmation");
      await sendMessage(chatId, "የመጨረሻ የቡድን መረጃዎ አሁን ሊጫን አልቻለም። እባክዎ ቆይተው ይሞክሩ።");
    }
    return;
  }

  await sendMessage(chatId, "ቡድንዎ ተሟልቷል። የመጀመሪያ 11 ተጫዋቾችን ለመምረጥ ከታች ያለውን ቁልፍ ይጫኑ።");
}

async function handleCallback(callbackQuery: TelegramCallbackQuery): Promise<void> {
  const chatId = chatIdOf(callbackQuery.message);
  if (!chatId) return;

  await acknowledgeCallback(callbackQuery.id);
  const user = await findOrCreateUser(chatId, callbackQuery.from);
  const data = callbackQuery.data ?? "";

  if (data === "register") {
    await updateUser(chatId, { flowState: "awaiting_name" });
    await sendMessage(chatId, "ለመመዝገብ ሙሉ ስምዎን ይጻፉ።");
    return;
  }

  if (data === "leaderboard" || data === "refresh_leaderboard") {
    await sendLeaderboardScreen(chatId, user, data === "refresh_leaderboard");
    return;
  }

  let players: FplPlayer[];
  try {
    players = await getFplPlayers();
  } catch (error) {
    logger.error({ error, chatId }, "Could not load FPL players for callback");
    await sendMessage(chatId, "የFPL ተጫዋቾች መረጃ አሁን አልተገኘም። እባክዎ ቆይተው ይሞክሩ።");
    return;
  }

  const selected = await loadSelection(user, players);

  const teamFlowStates = [
    "building_squad",
    "selecting_xi",
    "selecting_captain",
    "selecting_vice_captain",
    "confirming_team",
    "team_confirmed",
  ];

  if (data === "starting_xi") {
    if (!teamFlowStates.includes(user.flowState)) {
      await sendMessage(chatId, "እባክዎ መጀመሪያ ምዝገባዎን ያጠናቅቁ።");
      return;
    }
    if (selected.length !== SQUAD_LIMIT || !isCompleteSquad(selected)) {
      const screen = selectedScreen(selected);
      await sendMessage(
        chatId,
        "⚠️ የመጀመሪያ 11 ለመምረጥ በመጀመሪያ ትክክለኛ 15 ተጫዋቾችን ይምረጡ።",
        screen.markup,
      );
      return;
    }
    if (!(await ensureChallengeOpen(chatId))) return;
    if (user.flowState === "selecting_vice_captain") {
      await sendViceCaptainScreen(chatId, user, players);
      return;
    }
    if (user.flowState === "selecting_captain") {
      await sendCaptainScreen(chatId, user, players);
      return;
    }
    if (user.flowState === "confirming_team" || user.flowState === "team_confirmed") {
      await sendConfirmationScreen(chatId, user, user.flowState === "team_confirmed", players);
      return;
    }
    const xiUser =
      user.flowState === "selecting_xi"
        ? user
        : await updateUser(chatId, {
            flowState: "selecting_xi",
            startingPlayerIds: [],
            captainPlayerId: null,
            viceCaptainPlayerId: null,
          });
    await sendStartingXIScreen(chatId, xiUser, players);
    return;
  }

  if (data === "back_to_squad") {
    if (!teamFlowStates.includes(user.flowState) || user.flowState === "building_squad") return;
    if (!(await ensureChallengeOpen(chatId))) return;
    const squadUser = await updateUser(chatId, {
      flowState: "building_squad",
      startingPlayerIds: [],
      captainPlayerId: null,
      viceCaptainPlayerId: null,
    });
    await sendSquadScreen(chatId, squadUser);
    return;
  }

  if (data === "back_to_xi") {
    if (!["selecting_captain", "selecting_vice_captain", "confirming_team"].includes(user.flowState)) return;
    if (!(await ensureChallengeOpen(chatId))) return;
    const xiUser = await updateUser(chatId, {
      flowState: "selecting_xi",
      captainPlayerId: null,
      viceCaptainPlayerId: null,
    });
    await sendStartingXIScreen(chatId, xiUser, players);
    return;
  }

  if (data === "back_to_captain") {
    if (!["selecting_vice_captain", "confirming_team"].includes(user.flowState)) return;
    if (!(await ensureChallengeOpen(chatId))) return;
    const captainUser = await updateUser(chatId, {
      flowState: "selecting_captain",
      viceCaptainPlayerId: null,
    });
    await sendCaptainScreen(chatId, captainUser, players);
    return;
  }

  if (data.startsWith("xi_toggle:")) {
    if (user.flowState !== "selecting_xi") return;
    if (!(await ensureChallengeOpen(chatId))) return;
    const playerId = Number(data.slice("xi_toggle:".length));
    const player = selected.find((candidate) => candidate.id === playerId);
    if (!player) {
      await sendMessage(chatId, "ይህ ተጫዋች በቡድንዎ ውስጥ አይገኝም።");
      return;
    }

    const currentIds = user.startingPlayerIds.filter((id) =>
      selected.some((selectedPlayer) => selectedPlayer.id === id),
    );
    const currentlySelected = currentIds.includes(playerId);
    if (currentlySelected) {
      currentIds.splice(currentIds.indexOf(playerId), 1);
    } else {
      if (currentIds.length >= STARTING_XI_LIMIT) {
        await sendMessage(chatId, "11 ተጫዋቾች ተሞልተዋል። ሌላ ለመምረጥ አንዱን ይሰርዙ።");
        return;
      }
      if (
        player.position === "goalkeeper" &&
        currentIds.some(
          (id) => selected.find((selectedPlayer) => selectedPlayer.id === id)?.position === "goalkeeper",
        )
      ) {
        await sendMessage(chatId, "የመጀመሪያ 11 አንድ ግብ ጠባቂ ብቻ ሊኖረው ይገባል።");
        return;
      }
      currentIds.push(playerId);
    }

    const xiUser = await updateUser(chatId, {
      flowState: "selecting_xi",
      startingPlayerIds: currentIds,
      captainPlayerId: null,
      viceCaptainPlayerId: null,
    });
    await sendStartingXIScreen(chatId, xiUser, players);
    return;
  }

  if (data === "captain_select") {
    if (user.flowState !== "selecting_xi") return;
    if (!(await ensureChallengeOpen(chatId))) return;
    const starting = startingXIForUser(user, selected);
    const validation = validateStartingXI(starting);
    if (!validation.ok) {
      const screen = startingXIScreen(selected, starting);
      await sendMessage(chatId, `⚠️ ${validation.message}`, screen.markup);
      return;
    }
    const captainUser = await updateUser(chatId, { flowState: "selecting_captain" });
    await sendCaptainScreen(chatId, captainUser, players);
    return;
  }

  if (data.startsWith("captain:")) {
    if (user.flowState !== "selecting_captain") return;
    if (!(await ensureChallengeOpen(chatId))) return;
    const starting = startingXIForUser(user, selected);
    const validation = validateStartingXI(starting);
    if (!validation.ok) {
      const screen = startingXIScreen(selected, starting);
      await sendMessage(chatId, `⚠️ ${validation.message}`, screen.markup);
      return;
    }
    const captainId = Number(data.slice("captain:".length));
    const captain = starting.find((player) => player.id === captainId);
    if (!captain) {
      await sendMessage(chatId, "ካፒቴን ከመጀመሪያ 11 ውስጥ ብቻ መሆን አለበት።");
      return;
    }
    const confirmationUser = await updateUser(chatId, {
      flowState: "selecting_vice_captain",
      captainPlayerId: captain.id,
      viceCaptainPlayerId: null,
    });
    await sendViceCaptainScreen(chatId, confirmationUser, players);
    return;
  }

  if (data.startsWith("vice_captain:")) {
    if (user.flowState !== "selecting_vice_captain") return;
    if (!(await ensureChallengeOpen(chatId))) return;
    const starting = startingXIForUser(user, selected);
    const captain = starting.find((player) => player.id === user.captainPlayerId);
    const viceCaptainId = Number(data.slice("vice_captain:".length));
    const viceCaptain = starting.find((player) => player.id === viceCaptainId);
    if (!captain || !viceCaptain) {
      await sendMessage(chatId, "ምትክ ካፒቴን ከመጀመሪያ 11 ውስጥ ብቻ መሆን አለበት።");
      return;
    }
    const pairValidation = validateCaptainPair(starting, captain.id, viceCaptain.id);
    if (!pairValidation.ok) {
      await sendMessage(chatId, `⚠️ ${pairValidation.message}`);
      return;
    }
    const confirmationUser = await updateUser(chatId, {
      flowState: "confirming_team",
      viceCaptainPlayerId: viceCaptain.id,
    });
    await sendConfirmationScreen(chatId, confirmationUser, false, players);
    return;
  }

  if (data === "confirm_team") {
    if (user.flowState !== "confirming_team") return;
    const challenge = await ensureChallengeOpen(chatId);
    if (!challenge) return;
    const starting = startingXIForUser(user, selected);
    const validation = validateStartingXI(starting);
    const captain = starting.find((player) => player.id === user.captainPlayerId);
    const viceCaptain = starting.find((player) => player.id === user.viceCaptainPlayerId);
    const pairValidation =
      captain && viceCaptain
        ? validateCaptainPair(starting, captain.id, viceCaptain.id)
        : { ok: false as const, message: "ካፒቴን እና ምትክ ካፒቴን ይምረጡ።" };
    if (!validation.ok || !captain || !viceCaptain || !pairValidation.ok) {
      const errorMessage = !validation.ok
        ? validation.message
        : !captain || !viceCaptain
          ? "ካፒቴን እና ምትክ ካፒቴን ይምረጡ።"
          : pairValidation.ok
            ? "ካፒቴን እና ምትክ ካፒቴን ይምረጡ።"
            : pairValidation.message;
      await sendMessage(
        chatId,
        `⚠️ ${errorMessage}`,
      );
      return;
    }
    const bench = selected.filter((player) => !starting.some((starter) => starter.id === player.id));
    const registeredNow = await registerTeamForCurrentChallenge(
      user,
      challenge,
      selected,
      starting,
      bench,
      captain,
      viceCaptain,
    );
    const confirmedUser = await updateUser(chatId, { flowState: "team_confirmed" });
    await sendConfirmationScreen(
      chatId,
      confirmedUser,
      true,
      players,
      registeredNow
        ? undefined
        : "✅ የቡድን ማስተካከያዎ ተቀምጧል። የዚህ ሳምንት ውድድር በዚህ አዲሱ ቡድን ይቈጠራል።",
    );
    return;
  }

  if (user.flowState !== "building_squad") {
    await sendMessage(chatId, "የአሁኑን የቡድን ምርጫ ከታች ባሉት ቁልፎች ይቀጥሉ።");
    return;
  }

  if (data === "selected") {
    const screen = selectedScreen(selected);
    await sendMessage(chatId, screen.text, screen.markup);
    return;
  }

  if (data.startsWith("position:")) {
    const position = data.slice("position:".length) as FplPosition;
    if (!positionOrder.includes(position)) return;
    const screen = squadScreen(players, selected, position, 0);
    await sendMessage(chatId, screen.text, screen.markup);
    return;
  }

  if (data.startsWith("page:")) {
    const [, rawPosition, rawPage] = data.split(":");
    const position = rawPosition as FplPosition;
    const page = Number(rawPage);
    if (!positionOrder.includes(position) || !Number.isInteger(page)) return;
    const screen = squadScreen(players, selected, position, page);
    await sendMessage(chatId, screen.text, screen.markup);
    return;
  }

  if (data.startsWith("pick:")) {
    if (!(await ensureChallengeOpen(chatId))) return;
    const playerId = Number(data.slice("pick:".length));
    const player = players.find((candidate) => candidate.id === playerId);
    if (!player) {
      await sendMessage(chatId, "ይህ ተጫዋች በአሁኑ የFPL መረጃ ውስጥ አይገኝም።");
      return;
    }

    const validation = validatePlayerAddition(selected, player);
    if (!validation.ok) {
      await sendMessage(chatId, `⚠️ ${validation.message}`);
      return;
    }

    const updated = await updateUser(chatId, {
      selectedPlayerIds: [...selected.map((selectedPlayer) => selectedPlayer.id), player.id],
    });
    const newSelected = [...selected, player];
    const screen = squadScreen(players, newSelected, player.position, 0);
    await sendMessage(chatId, screen.text, screen.markup);
    logger.info({ chatId, playerId: player.id }, "Added player to FPL squad");
    void updated;
    return;
  }

  if (data.startsWith("remove:")) {
    if (!(await ensureChallengeOpen(chatId))) return;
    const playerId = Number(data.slice("remove:".length));
    if (!user.selectedPlayerIds.includes(playerId)) return;
    const updated = await updateUser(chatId, {
      selectedPlayerIds: user.selectedPlayerIds.filter((id) => id !== playerId),
    });
    const newSelected = selected.filter((player) => player.id !== playerId);
    const screen = squadScreen(players, newSelected);
    await sendMessage(chatId, screen.text, screen.markup);
    void updated;
  }
}

async function handleUpdate(update: TelegramUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  const message = update.message;
  const chatId = chatIdOf(message);
  if (!message || !chatId) return;

  if (message.text?.trim() === "/start") {
    const user = await findOrCreateUser(chatId, message.from);
    if (user.flowState === "new") {
      const appUrl = miniAppUrl();
      await sendMessage(chatId, "🏆 እንኳን ወደ FPL Signal Ethiopia በደህና መጡ!\n\nለመጀመር ከታች ያለውን ቁልፍ ይጫኑ።", {
        inline_keyboard: [
          ...(appUrl
            ? [[{ text: "🚀 FPL ኤፕ ክፈት", web_app: { url: appUrl } }]]
            : []),
          [{ text: "📝 ምዝገባ ጀምር", callback_data: "register" }],
        ],
      });
      return;
    }
    if (user.flowState === "awaiting_name") {
      await sendMessage(chatId, "ለመመዝገብ ሙሉ ስምዎን ይጻፉ።");
      return;
    }
  }

  await handleRegistration(chatId, message, message.from);
}

async function pollingLoop(): Promise<void> {
  let offset: number | undefined;
  while (botStarted) {
    try {
      const updates = await getUpdates(offset);
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          await handleUpdate(update);
        } catch (error) {
          logger.error({ err: error, updateId: update.update_id }, "Failed to handle Telegram update");
          const chatId = chatIdOf(update.callback_query?.message ?? update.message);
          if (chatId) {
            await sendSafeMessage(
              chatId,
              "⚠️ ይቅርታ፣ ምርጫዎን ማዘመን ላይ ችግር ተፈጥሯል። የቀድሞ የቡድን መረጃዎ አልተሰረዘም። /start ይላኩ።",
            );
          }
        }
      }
    } catch (error) {
      logger.error({ err: error }, "Telegram polling error");
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
}

const TELEGRAM_POLLING_LOCK_KEY = 72139041;

async function tryBecomeBotLeader(): Promise<boolean> {
  if (botLeader) return true;
  let client: BotLockClient | undefined;
  try {
    client = await acquirePoolClient();
    const result = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [TELEGRAM_POLLING_LOCK_KEY],
    );
    if (!result.rows[0]?.locked) {
      client.release();
      return false;
    }
    botLockClient = client;
    botLeader = true;
    logger.info("This instance acquired the Telegram polling lock");
    return true;
  } catch (error) {
    client?.release();
    logger.error({ error }, "Could not acquire Telegram polling lock");
    return false;
  }
}

function startLeaderServices(): void {
  if (!botLeader) return;
  void configureMiniAppLaunch();
  if (!scoreRefreshTimer) {
    scoreRefreshTimer = setInterval(() => { void scheduledScoreRefresh(); }, SCORE_REFRESH_INTERVAL_MS);
  }
  void scheduledScoreRefresh();
  void pollingLoop();
}

async function scheduledScoreRefresh(): Promise<void> {
  let current: WeeklyChallenge | undefined;
  try {
    current = await getCurrentChallenge();
    await ensureGwCompetition(current);
    await refreshChallengeScores(current);
  } catch (error) {
    logger.warn({ error }, "Current Weekly Challenge score refresh skipped");
  }

  if (current && current.gameweek > 1) {
    try {
      await refreshChallengeScores(createWeeklyChallenge({
        id: current.gameweek - 1,
        deadlineTime: null,
        isCurrent: false,
        isNext: false,
        finished: true,
      }));
    } catch (error) {
      logger.warn({ error, gameweek: current.gameweek - 1 }, "Previous Weekly Challenge score refresh skipped");
    }
  }
}

export async function startTelegramBot(): Promise<void> {
  if (botStarted) return;
  botStarted = true;
  logger.info("Starting FPL Signal Ethiopia Telegram bot");
  if (await tryBecomeBotLeader()) {
    startLeaderServices();
    return;
  }
  logger.info("Another instance owns Telegram polling; this instance will retry leadership");
  botLockRetryTimer = setInterval(() => {
    void (async () => {
      if (botLeader) return;
      if (await tryBecomeBotLeader()) {
        if (botLockRetryTimer) clearInterval(botLockRetryTimer);
        botLockRetryTimer = undefined;
        startLeaderServices();
      }
    })();
  }, 30_000);
}

async function releaseBotLeadership(): Promise<void> {
  if (botLockRetryTimer) clearInterval(botLockRetryTimer);
  botLockRetryTimer = undefined;
  if (scoreRefreshTimer) clearInterval(scoreRefreshTimer);
  scoreRefreshTimer = undefined;
  if (botLockClient) {
    try {
      await botLockClient.query("SELECT pg_advisory_unlock($1)", [TELEGRAM_POLLING_LOCK_KEY]);
    } catch (error) {
      logger.warn({ error }, "Could not release Telegram polling lock cleanly");
    } finally {
      botLockClient.release();
      botLockClient = undefined;
    }
  }
  botLeader = false;
  botStarted = false;
}

process.once("SIGTERM", () => { void releaseBotLeadership(); });
process.once("SIGINT", () => { void releaseBotLeadership(); });

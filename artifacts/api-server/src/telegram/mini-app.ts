import { and, eq } from "drizzle-orm";
import {
  db,
  telegramUsers,
  weeklyChallengeEntries,
  type TelegramUser as DbTelegramUser,
} from "@workspace/db";
import { logger } from "../lib/logger";
import {
  findOrCreateUser,
  getCurrentChallenge,
  loadChallengeLeaderboard,
  refreshChallengeScores,
  registerTeamForCurrentChallenge,
  updateUser,
} from "./bot";
import {
  getCurrentGameweek,
  getFplPlayers,
  getLiveGameweekStats,
  type FplPlayer,
  type FplLivePlayerStats,
} from "./fpl";
import {
  BUDGET,
  isCompleteSquad,
  validateCaptainPair,
  validatePlayerAddition,
  validateStartingXI,
} from "./squad-rules";
import { SaveMiniAppTeamBody } from "@workspace/api-zod";
import { buildSignals } from "./signal";
import type { TelegramUser } from "./types";
import type { WeeklyChallenge } from "./weekly-challenge";

export class MiniAppRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "MiniAppRequestError";
  }
}

function formatDisplayName(
  firstName: string | null | undefined,
  username: string | null | undefined,
  telegramUserId: number,
): string {
  return (
    firstName?.trim() ||
    (username?.trim() ? `@${username.trim()}` : `ተጠቃሚ ${telegramUserId}`)
  );
}

function currentEntryForUser(userId: number, challenge: WeeklyChallenge) {
  return db
    .select()
    .from(weeklyChallengeEntries)
    .where(
      and(
        eq(weeklyChallengeEntries.telegramUserId, userId),
        eq(weeklyChallengeEntries.competitionId, challenge.competitionId),
      ),
    )
    .limit(1);
}

function integerIds(values: number[], label: string): number[] {
  if (
    values.some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    new Set(values).size !== values.length
  ) {
    throw new MiniAppRequestError(`${label} መረጃ ትክክል አይደለም።`);
  }
  return values;
}

async function loadLiveStats(gameweek: number): Promise<{
  stats?: Map<number, FplLivePlayerStats>;
  available: boolean;
}> {
  try {
    return { stats: await getLiveGameweekStats(gameweek), available: true };
  } catch (error) {
    logger.warn({ error, gameweek }, "Mini App live FPL stats unavailable");
    return { available: false };
  }
}

export async function buildMiniAppState(
  user: DbTelegramUser,
  challengeOverride?: WeeklyChallenge,
) {
  const challenge = challengeOverride ?? (await getCurrentChallenge());
  const [players, live] = await Promise.all([
    getFplPlayers(),
    loadLiveStats(challenge.gameweek),
  ]);
  const entry = (await currentEntryForUser(user.id, challenge))[0];
  const leaderboardRows = await loadChallengeLeaderboard(challenge);
  const playerStats = live.stats;

  const serializedPlayers = players.map((player) => ({
    id: player.id,
    name: player.name,
    club: player.club,
    clubId: player.clubId,
    position: player.position,
    price: player.price,
    status: player.status ?? null,
    chanceOfPlayingThisRound: player.chanceOfPlayingThisRound ?? null,
    totalPoints: playerStats?.get(player.id)?.totalPoints ?? 0,
    minutes: playerStats?.get(player.id)?.minutes ?? 0,
  }));

  const selectedPlayerIds = entry?.selectedPlayerIds ?? [];
  const startingPlayerIds = entry?.startingPlayerIds ?? [];
  const benchPlayerIds =
    entry && entry.benchPlayerIds.length > 0
      ? entry.benchPlayerIds
      : selectedPlayerIds.filter((id) => !startingPlayerIds.includes(id));

  const signal = buildSignals({ players, liveStats: live.stats });

  const userRank =
    leaderboardRows.findIndex((row) => row.telegramUserId === user.id) + 1;
  const team = {
    selectedPlayerIds,
    startingPlayerIds,
    benchPlayerIds,
    captainPlayerId: entry?.captainPlayerId ?? null,
    viceCaptainPlayerId: entry?.viceCaptainPlayerId ?? null,
    points: entry?.points ?? 0,
    pointsSource: entry?.pointsSource ?? "pending",
    scoredPlayerIds: entry?.scoredPlayerIds ?? [],
    lastPointsUpdatedAt: entry?.lastPointsUpdatedAt?.toISOString() ?? null,
    submissionStatus: entry?.submissionStatus ?? "not_registered",
    registered: Boolean(entry),
  };

  return {
    user: {
      telegramId: Number(user.telegramChatId),
      firstName: user.firstName ?? null,
      username: user.username ?? null,
    },
    gameweek: {
      id: challenge.gameweek,
      deadlineTime: challenge.deadlineTime?.toISOString() ?? null,
      locked: challenge.locked,
      status: challenge.locked ? "locked" : "open",
    },
    players: serializedPlayers,
    team,
    leaderboard: leaderboardRows.map((row, index) => ({
      rank: index + 1,
      displayName: formatDisplayName(row.displayName, row.username, row.telegramUserId),
      points: row.points,
      isCurrentUser: row.telegramUserId === user.id,
      lastUpdatedAt: row.lastUpdatedAt?.toISOString() ?? null,
    })),
    signal: {
      available: signal.available,
      message: signal.message,
      disclaimer: signal.disclaimer,
      signals: signal.signals,
    },
    rank: userRank || null,
  };
}

export async function getMiniAppUser(profile: TelegramUser): Promise<DbTelegramUser> {
  return findOrCreateUser(String(profile.id), profile);
}

export async function saveMiniAppTeam(
  user: DbTelegramUser,
  body: unknown,
): Promise<void> {
  const parsed = SaveMiniAppTeamBody.safeParse(body);
  if (!parsed.success) {
    throw new MiniAppRequestError("የቡድን መረጃ ሙሉ እና ትክክል መሆን አለበት።");
  }

  const selectedIds = integerIds(parsed.data.selectedPlayerIds, "የ15 ተጫዋቾች");
  const startingIds = integerIds(parsed.data.startingPlayerIds, "የመጀመሪያ 11");
  const challenge = await getCurrentChallenge();
  if (challenge.locked) {
    throw new MiniAppRequestError("🔒 የዚህ ሳምንት ምዝገባ ተዘግቷል።", 400);
  }

  const players = await getFplPlayers();
  const playerById = new Map(players.map((player) => [player.id, player]));
  const selected = selectedIds.map((id) => playerById.get(id));
  if (selected.some((player) => !player) || selected.length !== 15) {
    throw new MiniAppRequestError("የተመረጡት 15 ተጫዋቾች ከFPL ዝርዝር ውስጥ መሆን አለባቸው።");
  }
  const selectedPlayers = selected.filter((player): player is FplPlayer => Boolean(player));
  let validatedSelection: FplPlayer[] = [];
  for (const player of selectedPlayers) {
    const validation = validatePlayerAddition(validatedSelection, player);
    if (!validation.ok) throw new MiniAppRequestError(validation.message);
    validatedSelection = [...validatedSelection, player];
  }
  if (!isCompleteSquad(validatedSelection)) {
    throw new MiniAppRequestError("የቡድኑ የቦታ ስርጭት 2 ግብ ጠባቂ፣ 5 ተከላካይ፣ 5 አማካይ እና 3 አጥቂ መሆን አለበት።");
  }
  const budget = validatedSelection.reduce((sum, player) => sum + player.price, 0);
  if (budget > BUDGET + 0.001) {
    throw new MiniAppRequestError("የቡድኑ ዋጋ ከ£100m መብለጥ አይችልም።");
  }

  const starting = startingIds.map((id) => playerById.get(id));
  if (
    starting.some((player) => !player) ||
    startingIds.some((id) => !selectedIds.includes(id))
  ) {
    throw new MiniAppRequestError("የመጀመሪያ 11 ከ15 ተጫዋቾች ውስጥ ብቻ መሆን አለበት።");
  }
  const startingPlayers = starting.filter(
    (player): player is FplPlayer => Boolean(player),
  );
  const startingValidation = validateStartingXI(startingPlayers);
  if (!startingValidation.ok) throw new MiniAppRequestError(startingValidation.message);

  const pairValidation = validateCaptainPair(
    startingPlayers,
    parsed.data.captainPlayerId,
    parsed.data.viceCaptainPlayerId,
  );
  if (!pairValidation.ok) throw new MiniAppRequestError(pairValidation.message);

  const bench = selectedPlayers.filter((player) => !startingIds.includes(player.id));
  await registerTeamForCurrentChallenge(
    user,
    challenge,
    selectedPlayers,
    startingPlayers,
    bench,
    playerById.get(parsed.data.captainPlayerId)!,
    playerById.get(parsed.data.viceCaptainPlayerId)!,
  );
  await updateUser(String(user.telegramChatId), {
    flowState: "team_confirmed",
    selectedPlayerIds: selectedIds,
    startingPlayerIds: startingIds,
    captainPlayerId: parsed.data.captainPlayerId,
    viceCaptainPlayerId: parsed.data.viceCaptainPlayerId,
  });
}
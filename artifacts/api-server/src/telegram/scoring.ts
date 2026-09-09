import {
  validateCaptainPair,
  validateStartingXI,
  type SquadValidation,
} from "./squad-rules";
import type { FplLivePlayerStats, FplPlayer } from "./fpl";

export type ConfirmedTeamForScoring = {
  selectedPlayerIds: number[];
  startingPlayerIds: number[];
  benchPlayerIds: number[];
  captainPlayerId: number;
  viceCaptainPlayerId: number | null;
};

export type WeeklyScoreResult = {
  totalPoints: number;
  scoredPlayerIds: number[];
  substitutions: Array<{ replacedPlayerId: number; substitutePlayerId: number }>;
};

function minutesFor(playerId: number, stats: Map<number, FplLivePlayerStats>): number {
  return stats.get(playerId)?.minutes ?? 0;
}

function pointsFor(playerId: number, stats: Map<number, FplLivePlayerStats>): number {
  const playerStats = stats.get(playerId);
  if (!playerStats) throw new Error(`Missing live FPL statistics for player ${playerId}`);
  return playerStats.totalPoints;
}

function validateTeamPlayerIds(
  team: ConfirmedTeamForScoring,
  players: FplPlayer[],
): SquadValidation {
  const playerIds = new Set(players.map((player) => player.id));
  const selected = new Set(team.selectedPlayerIds);
  const starting = new Set(team.startingPlayerIds);
  const bench = new Set(team.benchPlayerIds);
  if (
    selected.size !== 15 ||
    starting.size !== 11 ||
    bench.size !== 4 ||
    team.startingPlayerIds.some((id) => !selected.has(id)) ||
    team.benchPlayerIds.some((id) => !selected.has(id)) ||
    [...starting].some((id) => bench.has(id)) ||
    [...selected].some((id) => !playerIds.has(id))
  ) {
    return { ok: false, message: "የተመዘገበው ቡድን መረጃ ትክክል አይደለም።" };
  }
  return { ok: true };
}

export function calculateWeeklyScore(
  team: ConfirmedTeamForScoring,
  players: FplPlayer[],
  liveStats: Map<number, FplLivePlayerStats>,
): WeeklyScoreResult {
  const playerById = new Map(players.map((player) => [player.id, player]));
  const selectedValidation = validateTeamPlayerIds(team, players);
  if (!selectedValidation.ok) throw new Error(selectedValidation.message);

  const startingPlayers = team.startingPlayerIds.map((id) => playerById.get(id));
  const benchPlayers = team.benchPlayerIds.map((id) => playerById.get(id));
  if (
    startingPlayers.some((player) => !player) ||
    benchPlayers.some((player) => !player) ||
    !validateStartingXI(startingPlayers.filter((player): player is FplPlayer => player !== undefined)).ok
  ) {
    throw new Error("The persisted team does not contain a valid Starting XI");
  }

  const activePlayers = startingPlayers.filter(
    (player): player is FplPlayer => player !== undefined,
  );
  if (!activePlayers.some((player) => player.id === team.captainPlayerId)) {
    throw new Error("The persisted team captain is not part of the Starting XI");
  }
  if (team.viceCaptainPlayerId !== null) {
    const captainValidation = validateCaptainPair(
      activePlayers,
      team.captainPlayerId,
      team.viceCaptainPlayerId,
    );
    if (!captainValidation.ok) throw new Error(captainValidation.message);
  }
  const substitutions: WeeklyScoreResult["substitutions"] = [];

  for (const originalStarter of [...activePlayers]) {
    if (minutesFor(originalStarter.id, liveStats) > 0) continue;

    const candidateIndex = benchPlayers.findIndex((candidate) => {
      if (!candidate || minutesFor(candidate.id, liveStats) <= 0) return false;
      const proposed = activePlayers
        .filter((player) => player.id !== originalStarter.id)
        .concat(candidate);
      return validateStartingXI(proposed).ok;
    });
    if (candidateIndex < 0) continue;

    const substitute = benchPlayers[candidateIndex];
    if (!substitute) continue;
    activePlayers.splice(activePlayers.findIndex((player) => player.id === originalStarter.id), 1, substitute);
    benchPlayers.splice(candidateIndex, 1);
    substitutions.push({
      replacedPlayerId: originalStarter.id,
      substitutePlayerId: substitute.id,
    });
  }

  let totalPoints = activePlayers.reduce(
    (sum, player) => sum + pointsFor(player.id, liveStats),
    0,
  );
  const captainPlayed = minutesFor(team.captainPlayerId, liveStats) > 0;
  const viceCaptainPlayed =
    team.viceCaptainPlayerId !== null &&
    minutesFor(team.viceCaptainPlayerId, liveStats) > 0;
  if (captainPlayed) {
    totalPoints += pointsFor(team.captainPlayerId, liveStats);
  } else if (team.viceCaptainPlayerId !== null && viceCaptainPlayed) {
    totalPoints += pointsFor(team.viceCaptainPlayerId, liveStats);
  }

  return {
    totalPoints,
    scoredPlayerIds: activePlayers.map((player) => player.id),
    substitutions,
  };
}
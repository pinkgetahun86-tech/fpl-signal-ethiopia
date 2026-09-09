import type { FplGameweek } from "./fpl";

export type WeeklyChallenge = {
  competitionId: string;
  gameweek: number;
  deadlineTime: Date | null;
  locked: boolean;
};

export function createWeeklyChallenge(gameweek: FplGameweek): WeeklyChallenge {
  return {
    competitionId: `weekly-challenge-gw-${gameweek.id}`,
    gameweek: gameweek.id,
    deadlineTime: gameweek.deadlineTime,
    locked: gameweek.deadlineTime !== null && Date.now() >= gameweek.deadlineTime.getTime(),
  };
}
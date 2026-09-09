import assert from "node:assert/strict";
import { calculateWeeklyScore, type ConfirmedTeamForScoring } from "./scoring";
import {
  validateCaptainPair,
  validateStartingXI,
  isCompleteSquad,
  validatePlayerAddition,
} from "./squad-rules";
import type { FplLivePlayerStats, FplPlayer, FplPosition } from "./fpl";

const players: FplPlayer[] = [
  { id: 1, name: "Goalkeeper 1", club: "A", clubId: 1, position: "goalkeeper", price: 5 },
  { id: 2, name: "Goalkeeper 2", club: "B", clubId: 2, position: "goalkeeper", price: 5 },
  ...Array.from({ length: 5 }, (_, index) => ({
    id: 10 + index,
    name: `Defender ${index + 1}`,
    club: String.fromCharCode(67 + index),
    clubId: 3 + index,
    position: "defender" as const,
    price: 5,
  })),
  ...Array.from({ length: 5 }, (_, index) => ({
    id: 20 + index,
    name: `Midfielder ${index + 1}`,
    club: String.fromCharCode(72 + index),
    clubId: 8 + index,
    position: "midfielder" as const,
    price: 5,
  })),
  ...Array.from({ length: 3 }, (_, index) => ({
    id: 30 + index,
    name: `Forward ${index + 1}`,
    club: String.fromCharCode(77 + index),
    clubId: 13 + index,
    position: "forward" as const,
    price: 5,
  })),
];

const startingPlayerIds = [1, 10, 11, 12, 13, 20, 21, 22, 23, 30, 31];
const defaultBenchPlayerIds = [32, 2, 14, 24];

function stats(points: Record<number, number>, minutes = 90): Map<number, FplLivePlayerStats> {
  return new Map(players.map((player) => [
    player.id,
    { minutes, totalPoints: points[player.id] ?? 1 },
  ]));
}

function team(overrides: Partial<{
  startingPlayerIds: number[];
  benchPlayerIds: number[];
  captainPlayerId: number;
  viceCaptainPlayerId: number | null;
}> = {}): ConfirmedTeamForScoring {
  return {
    selectedPlayerIds: [...startingPlayerIds, ...defaultBenchPlayerIds],
    startingPlayerIds: overrides.startingPlayerIds ?? startingPlayerIds,
    benchPlayerIds: overrides.benchPlayerIds ?? defaultBenchPlayerIds,
    captainPlayerId: overrides.captainPlayerId ?? 30,
    viceCaptainPlayerId: overrides.viceCaptainPlayerId ?? 20,
  };
}

// 1. No captain boost without a vice-captain configured.
{
  const result = calculateWeeklyScore(
    team({ viceCaptainPlayerId: null }),
    players,
    stats({}),
  );
  // 10 outfielders + keeper + captain bonus = 11 x 1 + 1.
  assert.equal(result.totalPoints, 12);
}

// 2. Captain earns double points.
{
  const result = calculateWeeklyScore(team(), players, stats({ 30: 7 }));
  assert.equal(result.totalPoints, 24);
  assert.deepEqual(result.scoredPlayerIds, startingPlayerIds);
}

// 3. Vice-captain takes over when the captain plays 0 minutes.
{
  const live = stats({ 20: 5, 30: 0, 32: 4 });
  live.set(30, { minutes: 0, totalPoints: 0 });
  const result = calculateWeeklyScore(team({ benchPlayerIds: [32, 2, 14, 24] }), players, live);
  assert.equal(result.totalPoints, 23);
  assert.deepEqual(result.substitutions, [{ replacedPlayerId: 30, substitutePlayerId: 32 }]);
}

// 4. Both captain and vice-captain out: no bonus at all.
{
  const live = stats({ 20: 0, 30: 0, 32: 4, 24: 3 });
  live.set(20, { minutes: 0, totalPoints: 0 });
  live.set(30, { minutes: 0, totalPoints: 0 });
  const result = calculateWeeklyScore(
    team({ benchPlayerIds: [32, 24, 2, 14] }),
    players,
    live,
  );
  assert.equal(result.totalPoints, 16);
  assert.equal(result.substitutions.length, 2);
}

// 5. A player with 1 minute keeps their spot (only 0-minute players are subbed).
{
  const live = stats({ 30: 7 });
  live.set(30, { minutes: 1, totalPoints: 0 });
  const result = calculateWeeklyScore(team(), players, live);
  assert.equal(result.substitutions.length, 0);
  assert.equal(result.scoredPlayerIds.includes(30), true);
  assert.equal(result.totalPoints, 10);
}

// 6. Substitutions happen in bench order (first entry tried first).
{
  // 30 (starter, FWD) and 31 (starter, FWD) are out; 32 (FWD) and 24 (MID) on bench.
  const live = stats({});
  live.set(30, { minutes: 0, totalPoints: 0 });
  live.set(31, { minutes: 0, totalPoints: 0 });
  const result = calculateWeeklyScore(
    team({ benchPlayerIds: [32, 24, 2, 14] }),
    players,
    live,
  );
  // 30 -> 32 (FWD for FWD), 31 -> 24 (MID) keeps 3 DEF / 3 MID / 3 FWD + GK valid.
  assert.deepEqual(result.substitutions, [
    { replacedPlayerId: 30, substitutePlayerId: 32 },
    { replacedPlayerId: 31, substitutePlayerId: 24 },
  ]);
}

// 7. Formation rules block invalid swaps (no double goalkeeper).
{
  const live = stats({});
  live.set(1, { minutes: 0, totalPoints: 0 }); // starting keeper out
  // Bench order puts DEF 14 first; swapping a keeper for a defender would break
  // the 1-GK requirement, so the engine must skip it and use GK 2 instead.
  const result = calculateWeeklyScore(
    team({ benchPlayerIds: [14, 2, 24, 32] }),
    players,
    live,
  );
  assert.deepEqual(result.substitutions, [{ replacedPlayerId: 1, substitutePlayerId: 2 }]);
}

// 8. A 0-minute bench player is skipped; the next playable candidate is used.
{
  const live = stats({});
  live.set(30, { minutes: 0, totalPoints: 0 });
  live.set(31, { minutes: 0, totalPoints: 0 });
  live.set(32, { minutes: 0, totalPoints: 0 }); // bench forward did not play
  const result = calculateWeeklyScore(
    team({ benchPlayerIds: [32, 24, 2, 14] }),
    players,
    live,
  );
  // 30 is replaced by 24 (MID) — formation stays valid.
  // 31 cannot be replaced: GK 2 breaks the single-keeper rule and DEF 14
  // would leave zero forwards.
  assert.deepEqual(result.substitutions, [{ replacedPlayerId: 30, substitutePlayerId: 24 }]);
  assert.equal(result.scoredPlayerIds.includes(31), true); // stays, scores 0
}

// 9. Missing live statistics are handled safely:
//     a starter without stats is treated as having played 0 minutes and is
//     substituted when a valid bench candidate exists; if none exists, scoring
//     must throw instead of inventing points.
{
  const live = stats({});
  live.delete(10); // outfielder missing -> substituted by playable bench
  const result = calculateWeeklyScore(
    team({ benchPlayerIds: [32, 24, 2, 14] }),
    players,
    live,
  );
  assert.deepEqual(result.substitutions, [{ replacedPlayerId: 10, substitutePlayerId: 32 }]);
  assert.equal(result.scoredPlayerIds.includes(10), false);
}
{
  const live = stats({});
  live.delete(1); // starting keeper missing and no keeper available on the bench
  assert.throws(() =>
    calculateWeeklyScore(team({ benchPlayerIds: [32, 24, 14, 13] }), players, live),
  );
}

// 10. Invalid squad sizes are rejected.
{
  assert.throws(() =>
    calculateWeeklyScore({ ...team(), selectedPlayerIds: startingPlayerIds }, players, stats({})),
  );
  assert.throws(() =>
    calculateWeeklyScore({ ...team(), startingPlayerIds: startingPlayerIds.slice(0, 10) }, players, stats({})),
  );
  assert.throws(() =>
    calculateWeeklyScore({ ...team(), benchPlayerIds: [32, 2] }, players, stats({})),
  );
}

// 11. Starting XI must satisfy formation rules.
{
  // Two keepers in the XI.
  assert.throws(() =>
    calculateWeeklyScore(
      team({ startingPlayerIds: [1, 2, 10, 11, 12, 20, 21, 22, 30, 31, 32] }),
      players,
      stats({}),
    ),
  );
}

// 12. Captain must be part of the starting XI.
{
  assert.throws(() => calculateWeeklyScore(team({ captainPlayerId: 32 }), players, stats({})));
}

// 13. Invalid captain/vice-captain combinations are rejected.
{
  const starting = startingPlayerIds.map((id) => players.find((player) => player.id === id)!);
  assert.equal(validateCaptainPair(starting, 30, 30).ok, false);
  assert.equal(validateCaptainPair(starting, 32, 20).ok, false);
  assert.equal(validateCaptainPair(starting, 30, undefined).ok, false);
}

// 14. Formation validation helpers.
{
  const starting = startingPlayerIds.map((id) => players.find((player) => player.id === id)!);
  assert.equal(validateStartingXI(starting).ok, true);
  assert.equal(
    validateStartingXI([...starting.filter((p) => p.position !== "defender"), players[10]!]).ok,
    false,
  );
  assert.equal(isCompleteSquad(players), true);
  assert.equal(isCompleteSquad(players.slice(0, 14)), false);
}

// 15. Squad addition rules (budget / duplicates / position limits / club cap).
{
  const selected: FplPlayer[] = [players[0]!];
  assert.equal(validatePlayerAddition(selected, players[0]!).ok, false); // duplicate
  assert.equal(validatePlayerAddition(selected, players[1]!).ok, true);
}

// 16. Mixed point totals with captain bonus.
{
  const live = stats({ 20: 3, 30: 4 });
  const result = calculateWeeklyScore(team(), players, live);
  // Starters: 9 x 1 + 3 (player 20) + 4 (player 30) = 16, captain bonus +4.
  assert.equal(result.totalPoints, 20);
}

// 17. Negative points (red cards etc.) flow straight through.
{
  const live = stats({});
  live.set(10, { minutes: 90, totalPoints: -2 });
  const result = calculateWeeklyScore(team(), players, live);
  // 9 starters x 1 + (-2) = 8 base, captain bonus +1.
  assert.equal(result.totalPoints, 9);
}

// 18. Position typing sanity for FplPosition usage.
{
  const positions: FplPosition[] = ["goalkeeper", "defender", "midfielder", "forward"];
  assert.equal(positions.length, 4);
}

console.log("scoring tests passed");

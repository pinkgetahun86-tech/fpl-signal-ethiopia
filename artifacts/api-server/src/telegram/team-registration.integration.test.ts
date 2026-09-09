import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// This test verifies the unique (telegram_user_id, competition_id) upsert
// behavior against a real PostgreSQL database. It runs only when
// TEST_DATABASE_URL is provided (e.g. by CI) and never touches production data:
// all rows live inside a dedicated schema that is dropped afterwards.
const databaseUrl = process.env["TEST_DATABASE_URL"];
if (!databaseUrl) {
  console.log("team-registration integration test skipped (TEST_DATABASE_URL not set)");
  process.exit(0);
}

process.env["DATABASE_URL"] = databaseUrl;
// Silence the pretty-print logger transport (not bundled into the test file).
process.env["LOG_LEVEL"] = "silent";
process.env["NODE_ENV"] = "production";

const { pool, db, telegramUsers, weeklyChallengeEntries } = await import("@workspace/db");
const { registerTeamForCurrentChallenge } = await import("./bot");
const { calculateWeeklyScore } = await import("./scoring");
import type { FplPlayer } from "./fpl";

const schemaName = `fpl_test_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const client = await pool.connect();
try {
  await client.query(`CREATE SCHEMA ${schemaName}`);
  await client.query(`SET search_path TO ${schemaName}, public`);
  await client.query(`
    CREATE TABLE telegram_users (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      telegram_chat_id varchar(64) NOT NULL UNIQUE,
      first_name text,
      username text,
      flow_state text NOT NULL DEFAULT 'new',
      selected_player_ids jsonb NOT NULL DEFAULT '[]',
      starting_player_ids jsonb NOT NULL DEFAULT '[]',
      captain_player_id integer,
      vice_captain_player_id integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE gw_competitions (
      id text PRIMARY KEY,
      gameweek integer NOT NULL,
      entry_fee_etb integer NOT NULL DEFAULT 0,
      currency varchar(3) NOT NULL DEFAULT 'ETB',
      status text NOT NULL DEFAULT 'open',
      deadline_time timestamptz,
      prize_pool_etb integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE TABLE weekly_challenge_entries (
      id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      telegram_user_id integer NOT NULL REFERENCES telegram_users(id),
      competition_id text NOT NULL,
      gameweek integer NOT NULL,
      selected_player_ids jsonb NOT NULL,
      starting_player_ids jsonb NOT NULL,
      bench_player_ids jsonb NOT NULL DEFAULT '[]',
      captain_player_id integer NOT NULL,
      vice_captain_player_id integer,
      submission_status text NOT NULL DEFAULT 'confirmed',
      points integer NOT NULL DEFAULT 0,
      points_source text NOT NULL DEFAULT 'placeholder',
      scored_player_ids jsonb NOT NULL DEFAULT '[]',
      last_points_updated_at timestamptz,
      registered_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX weekly_challenge_user_competition_unique
      ON weekly_challenge_entries (telegram_user_id, competition_id)
  `);
} finally {
  client.release();
}

const challenge = {
  competitionId: `weekly-challenge-gw-test-${randomUUID().slice(0, 8)}`,
  gameweek: 99,
  deadlineTime: null,
  locked: false,
};

// PAID_COMPETITION_ENABLED is read from env at module load; the free-to-enter
// default path marks new entries confirmed.
const playerById = new Map<number, FplPlayer>();
for (let i = 0; i < 20; i += 1) {
  const id = 1000 + i;
  playerById.set(id, {
    id,
    name: `Player ${id}`,
    club: "Test FC",
    clubId: 1,
    position: i < 2 ? "goalkeeper" : i < 7 ? "defender" : i < 12 ? "midfielder" : "forward",
    price: 5,
  });
}
const allPlayers = [...playerById.values()];

function pickTeam(): {
  selected: FplPlayer[];
  starting: FplPlayer[];
  bench: FplPlayer[];
  captain: FplPlayer;
  viceCaptain: FplPlayer;
} {
  const gks = allPlayers.filter((p) => p.position === "goalkeeper");
  const defs = allPlayers.filter((p) => p.position === "defender");
  const mids = allPlayers.filter((p) => p.position === "midfielder");
  const fwds = allPlayers.filter((p) => p.position === "forward");
  const selected = [gks[0]!, gks[1]!, ...defs.slice(0, 5), ...mids.slice(0, 5), ...fwds.slice(0, 3)];
  const starting = [gks[0]!, ...defs.slice(0, 4), ...mids.slice(0, 4), ...fwds.slice(0, 2)];
  const bench = selected.filter((p) => !starting.some((s) => s.id === p.id));
  return {
    selected,
    starting,
    bench,
    captain: starting[starting.length - 1]!,
    viceCaptain: starting[starting.length - 2]!,
  };
}

const chatId = `test-${randomUUID().slice(0, 8)}`;
const insertedUser = await db
  .insert(telegramUsers)
  .values({ telegramChatId: chatId, firstName: "መሣሪያ", flowState: "team_confirmed", selectedPlayerIds: [], startingPlayerIds: [] })
  .returning();
const user = insertedUser[0]!;

try {
  const first = pickTeam();
  const createdFirst = await registerTeamForCurrentChallenge(user, challenge, first.selected, first.starting, first.bench, first.captain, first.viceCaptain);
  assert.equal(createdFirst, true, "first submission should create an entry");

  const afterFirst = await db
    .select()
    .from(weeklyChallengeEntries)
    .where(
      and(
        eq(weeklyChallengeEntries.telegramUserId, user.id),
        eq(weeklyChallengeEntries.competitionId, challenge.competitionId),
      ),
    );
  assert.equal(afterFirst.length, 1, "exactly one entry per user/competition");
  assert.deepEqual(afterFirst[0]!.selectedPlayerIds.length, 15);

  // Edit: swap the captain and one starter, then re-submit.
  const second = pickTeam();
  const newCaptain = second.selected.find((p) => p.position === "goalkeeper")!;
  const editedStarting = [newCaptain, ...second.starting.filter((p) => p.position !== "goalkeeper")];
  const editedCaptain = second.captain;
  const editedVice = second.viceCaptain;
  const editedBench = second.selected.filter((p) => !editedStarting.some((s) => s.id === p.id));

  const createdSecond = await registerTeamForCurrentChallenge(
    user,
    challenge,
    second.selected,
    editedStarting,
    editedBench,
    editedCaptain,
    editedVice,
  );
  assert.equal(createdSecond, false, "second submission must update, not insert");

  const afterEdit = await db
    .select()
    .from(weeklyChallengeEntries)
    .where(
      and(
        eq(weeklyChallengeEntries.telegramUserId, user.id),
        eq(weeklyChallengeEntries.competitionId, challenge.competitionId),
      ),
    );
  assert.equal(afterEdit.length, 1, "still exactly one entry after edit");
  assert.equal(afterEdit[0]!.captainPlayerId, editedCaptain.id, "captain edit must be persisted");
  assert.equal(afterEdit[0]!.viceCaptainPlayerId, editedVice.id, "vice-captain edit must be persisted");
  assert.equal(afterEdit[0]!.startingPlayerIds.includes(newCaptain.id), true, "starting XI edit must be persisted");
  assert.deepEqual(afterEdit[0]!.benchPlayerIds.length, 4, "bench stays 4 players after edit");

  // Scoring still works on the edited entry shape.
  const live = new Map(allPlayers.map((p) => [p.id, { minutes: 90, totalPoints: 2 }]));
  const score = calculateWeeklyScore(
    {
      selectedPlayerIds: afterEdit[0]!.selectedPlayerIds,
      startingPlayerIds: afterEdit[0]!.startingPlayerIds,
      benchPlayerIds: afterEdit[0]!.benchPlayerIds,
      captainPlayerId: afterEdit[0]!.captainPlayerId,
      viceCaptainPlayerId: afterEdit[0]!.viceCaptainPlayerId,
    },
    allPlayers,
    live,
  );
  assert.equal(score.totalPoints, 11 * 2 + 2);

  console.log("team-registration integration tests passed");
} finally {
  await pool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
  await pool.end();
}

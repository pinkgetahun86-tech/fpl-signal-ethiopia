import {
  calculatePrizeShares,
  calculateTop20PrizeShares,
  TOP_20_PRIZE_WEIGHTS,
  TOP_20_PRIZE_WEIGHT_TOTAL,
} from "./prize-distribution";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: unknown, expected: unknown, message: string) {
  assert(
    actual === expected,
    `${message}: expected ${String(expected)}, got ${String(actual)}`,
  );
}

function assertFullPool(
  shares: Array<{ amountEtb: number }>,
  pool: number,
  message: string,
) {
  const total = shares.reduce((sum, share) => sum + share.amountEtb, 0);
  assertEqual(total, pool, message);
}

/* -------------------------------------------------------
 * Legacy percentage distribution
 * ----------------------------------------------------- */

const normal = calculatePrizeShares(1000, [
  { entryId: 1, telegramUserId: 1, rank: 1, percentage: 60 },
  { entryId: 2, telegramUserId: 2, rank: 2, percentage: 30 },
  { entryId: 3, telegramUserId: 3, rank: 3, percentage: 10 },
]);

assertEqual(
  normal.map((x) => x.amountEtb).join(","),
  "600,300,100",
  "legacy normal distribution failed",
);

const remainder = calculatePrizeShares(101, [
  { entryId: 21, telegramUserId: 21, rank: 1, percentage: 60 },
  { entryId: 22, telegramUserId: 22, rank: 2, percentage: 30 },
  { entryId: 23, telegramUserId: 23, rank: 3, percentage: 10 },
]);

assertFullPool(
  remainder,
  101,
  "legacy remainder was lost",
);

assertEqual(
  remainder.map((x) => x.amountEtb).join(","),
  "61,30,10",
  "legacy remainder allocation failed",
);

/* -------------------------------------------------------
 * Fixed Top-20 structure
 * ----------------------------------------------------- */

assertEqual(
  TOP_20_PRIZE_WEIGHTS.length,
  20,
  "Top-20 must contain exactly 20 prize positions",
);

assertEqual(
  TOP_20_PRIZE_WEIGHT_TOTAL,
  20033,
  "Top-20 weight total is incorrect",
);

/* -------------------------------------------------------
 * 20 participants
 * ----------------------------------------------------- */

const twentyParticipants = Array.from(
  { length: 20 },
  (_, index) => ({
    entryId: index + 1,
    telegramUserId: index + 1,
    points: 100 - index,
  }),
);

const twentyShares = calculateTop20PrizeShares(
  20033,
  twentyParticipants,
);

assertEqual(
  twentyShares.length,
  20,
  "20 participants should produce 20 winners",
);

assertFullPool(
  twentyShares,
  20033,
  "20-player prize pool was not fully distributed",
);

assertEqual(
  twentyShares[0]?.amountEtb,
  7005,
  "1st prize weight is incorrect",
);

assertEqual(
  twentyShares[1]?.amountEtb,
  4000,
  "2nd prize weight is incorrect",
);

assertEqual(
  twentyShares[19]?.amountEtb,
  100,
  "20th prize weight is incorrect",
);

/* -------------------------------------------------------
 * Fewer than 20 participants
 * ----------------------------------------------------- */

const fiveParticipants = Array.from(
  { length: 5 },
  (_, index) => ({
    entryId: 100 + index,
    telegramUserId: 100 + index,
    points: 100 - index,
  }),
);

const fiveShares = calculateTop20PrizeShares(
  1000,
  fiveParticipants,
);

assertEqual(
  fiveShares.length,
  5,
  "5 participants should produce 5 winners",
);

assertFullPool(
  fiveShares,
  1000,
  "fewer-than-20 prize pool was not fully distributed",
);

/* -------------------------------------------------------
 * More than 20 participants
 * ----------------------------------------------------- */

const twentyFiveParticipants = Array.from(
  { length: 25 },
  (_, index) => ({
    entryId: 200 + index,
    telegramUserId: 200 + index,
    points: 100 - index,
  }),
);

const twentyFiveShares = calculateTop20PrizeShares(
  20033,
  twentyFiveParticipants,
);

assertEqual(
  twentyFiveShares.length,
  20,
  "more than 20 participants should normally produce 20 winners",
);

assertFullPool(
  twentyFiveShares,
  20033,
  "25-player prize pool was not fully distributed",
);

/* -------------------------------------------------------
 * Tie handling
 * ----------------------------------------------------- */

const tiedParticipants = [
  { entryId: 301, telegramUserId: 301, points: 100 },
  { entryId: 302, telegramUserId: 302, points: 100 },
  { entryId: 303, telegramUserId: 303, points: 90 },
  { entryId: 304, telegramUserId: 304, points: 80 },
];

const tiedShares = calculateTop20PrizeShares(
  1000,
  tiedParticipants,
);

assertEqual(
  tiedShares.length,
  4,
  "tie test should include all eligible participants",
);

assertFullPool(
  tiedShares,
  1000,
  "tie distribution did not allocate full pool",
);

assertEqual(
  tiedShares[0]?.rank,
  1,
  "first tied player rank is incorrect",
);

assertEqual(
  tiedShares[1]?.rank,
  1,
  "second tied player rank is incorrect",
);

assertEqual(
  tiedShares[2]?.rank,
  3,
  "rank after two-player tie is incorrect",
);

/* -------------------------------------------------------
 * Tie at the 20th position
 * ----------------------------------------------------- */

const cutoffTieParticipants = [
  ...Array.from({ length: 19 }, (_, index) => ({
    entryId: 400 + index,
    telegramUserId: 400 + index,
    points: 200 - index,
  })),
  {
    entryId: 419,
    telegramUserId: 419,
    points: 100,
  },
  {
    entryId: 420,
    telegramUserId: 420,
    points: 100,
  },
  {
    entryId: 421,
    telegramUserId: 421,
    points: 100,
  },
];

const cutoffTieShares = calculateTop20PrizeShares(
  20033,
  cutoffTieParticipants,
);

assert(
  cutoffTieShares.length >= 20,
  "tie at 20th position should include tied recipients",
);

assertFullPool(
  cutoffTieShares,
  20033,
  "20th-place tie did not preserve full pool",
);

assert(
  cutoffTieShares.some((share) => share.entryId === 419),
  "20th-place tied player 419 is missing",
);

assert(
  cutoffTieShares.some((share) => share.entryId === 420),
  "20th-place tied player 420 is missing",
);

assert(
  cutoffTieShares.some((share) => share.entryId === 421),
  "20th-place tied player 421 is missing",
);

/* -------------------------------------------------------
 * Deterministic rounding
 * ----------------------------------------------------- */

const roundingInput = [
  { entryId: 501, telegramUserId: 501, points: 100 },
  { entryId: 502, telegramUserId: 502, points: 90 },
  { entryId: 503, telegramUserId: 503, points: 80 },
];

const roundingA = calculateTop20PrizeShares(
  1001,
  roundingInput,
);

const roundingB = calculateTop20PrizeShares(
  1001,
  roundingInput,
);

assertEqual(
  JSON.stringify(roundingA),
  JSON.stringify(roundingB),
  "rounding must be deterministic",
);

assertFullPool(
  roundingA,
  1001,
  "rounding lost part of the prize pool",
);

/* -------------------------------------------------------
 * Zero pool
 * ----------------------------------------------------- */

const zeroPool = calculateTop20PrizeShares(
  0,
  fiveParticipants,
);

assert(
  zeroPool.every((share) => share.amountEtb === 0),
  "zero prize pool should produce zero payouts",
);

/* -------------------------------------------------------
 * Empty participants
 * ----------------------------------------------------- */

const empty = calculateTop20PrizeShares(1000, []);

assertEqual(
  empty.length,
  0,
  "empty participant list should produce no winners",
);

/* -------------------------------------------------------
 * Invalid pool
 * ----------------------------------------------------- */

let invalidPoolRejected = false;

try {
  calculateTop20PrizeShares(-1, fiveParticipants);
} catch {
  invalidPoolRejected = true;
}

assert(
  invalidPoolRejected,
  "negative prize pool must be rejected",
);

console.log("all prize distribution tests passed");

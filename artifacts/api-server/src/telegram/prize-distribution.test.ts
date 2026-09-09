import { calculatePrizeShares } from "./prize-distribution";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const normal = calculatePrizeShares(1000, [
  { entryId: 1, telegramUserId: 1, rank: 1, percentage: 60 },
  { entryId: 2, telegramUserId: 2, rank: 2, percentage: 30 },
  { entryId: 3, telegramUserId: 3, rank: 3, percentage: 10 },
]);
assert(normal.map((x) => x.amountEtb).join(",") === "600,300,100", "normal distribution failed");

const tied = calculatePrizeShares(1000, [
  { entryId: 11, telegramUserId: 11, rank: 1, percentage: 50 },
  { entryId: 12, telegramUserId: 12, rank: 1, percentage: 50 },
]);
assert(tied.reduce((sum, x) => sum + x.amountEtb, 0) === 1000, "tied distribution did not allocate full pool");
assert(tied.map((x) => x.amountEtb).join(",") === "500,500", "tied distribution failed");

const remainder = calculatePrizeShares(101, [
  { entryId: 21, telegramUserId: 21, rank: 1, percentage: 60 },
  { entryId: 22, telegramUserId: 22, rank: 2, percentage: 30 },
  { entryId: 23, telegramUserId: 23, rank: 3, percentage: 10 },
]);
assert(remainder.reduce((sum, x) => sum + x.amountEtb, 0) === 101, "remainder was lost");
assert(remainder.map((x) => x.amountEtb).join(",") === "61,30,10", "remainder allocation failed");

const threeWayTie = calculatePrizeShares(1000, [
  { entryId: 31, telegramUserId: 31, rank: 1, percentage: 60 },
  { entryId: 32, telegramUserId: 32, rank: 1, percentage: 30 },
  { entryId: 33, telegramUserId: 33, rank: 1, percentage: 10 },
]);
assert(threeWayTie.reduce((sum, x) => sum + x.amountEtb, 0) === 1000, "three-way tie lost money");
assert(threeWayTie.map((x) => x.amountEtb).join(",") === "600,300,100", "three-way tie failed");

console.log("prize distribution tests passed");

export type PrizeWinnerInput = {
  entryId: number;
  telegramUserId: number;
  rank: number;
  percentage: number;
};

export type PrizeWinnerShare = PrizeWinnerInput & {
  amountEtb: number;
};

/**
 * Fixed Top-20 prize weights.
 *
 * These are the exact weights agreed for the Weekly Challenge.
 * The actual ETB payout is calculated proportionally from the
 * competition's real prize pool.
 */
export const TOP_20_PRIZE_WEIGHTS = [
  7005,
  4000,
  2509,
  1500,
  859,
  650,
  550,
  450,
  400,
  350,
  300,
  270,
  230,
  200,
  170,
  150,
  130,
  110,
  100,
  100,
] as const;

export const TOP_20_PRIZE_WEIGHT_TOTAL =
  TOP_20_PRIZE_WEIGHTS.reduce(
    (sum, weight) => sum + weight,
    0,
  );

/**
 * Keeps the old percentage-based API for compatibility
 * with any code that may still use it.
 */
export function calculatePrizeShares(
  prizePoolEtb: number,
  winners: PrizeWinnerInput[],
): PrizeWinnerShare[] {
  if (
    !Number.isSafeInteger(prizePoolEtb) ||
    prizePoolEtb < 0
  ) {
    throw new Error("Invalid prize pool");
  }

  if (winners.length === 0) return [];

  const raw = winners.map((winner) => {
    const exact =
      (prizePoolEtb * winner.percentage) / 100;

    const floor = Math.floor(exact);

    return {
      winner,
      exact,
      floor,
      fraction: exact - floor,
    };
  });

  let remainder =
    prizePoolEtb -
    raw.reduce(
      (sum, item) => sum + item.floor,
      0,
    );

  if (remainder < 0) {
    throw new Error(
      "Prize shares exceed prize pool",
    );
  }

  raw.sort(
    (a, b) =>
      b.fraction - a.fraction ||
      a.winner.entryId - b.winner.entryId,
  );

  for (
    let i = 0;
    i < raw.length && remainder > 0;
    i += 1, remainder -= 1
  ) {
    raw[i].floor += 1;
  }

  return raw
    .map(({ winner, floor }) => ({
      ...winner,
      amountEtb: floor,
    }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.entryId - b.entryId,
    );
}

/**
 * Calculates the fixed Top-20 prize structure.
 *
 * For fewer than 20 participants, only the available positions
 * are used and the entire prize pool is distributed among them.
 *
 * For ties, the tied players share the total weight of the
 * positions occupied by that tied group.
 *
 * Integer ETB rounding uses largest-remainder allocation with
 * entryId as the deterministic tie-breaker.
 */
export function calculateTop20PrizeShares(
  prizePoolEtb: number,
  winners: Array<{
    entryId: number;
    telegramUserId: number;
    points: number;
  }>,
): Array<{
  entryId: number;
  telegramUserId: number;
  rank: number;
  amountEtb: number;
}> {
  if (
    !Number.isSafeInteger(prizePoolEtb) ||
    prizePoolEtb < 0
  ) {
    throw new Error("Invalid prize pool");
  }

  if (winners.length === 0) return [];

  /*
   * Winners must already be sorted by:
   * points DESC, registeredAt ASC, id ASC
   * by the settlement layer.
   *
   * We only need the first 20 ranking slots, but a tie at
   * position 20 may include additional players.
   */
  const top20Slots = Math.min(
    winners.length,
    TOP_20_PRIZE_WEIGHTS.length,
  );

  const cutoffPoints =
    winners[top20Slots - 1]?.points;

  const eligible = winners.filter(
    (winner, index) =>
      index < top20Slots ||
      winner.points === cutoffPoints,
  );

  /*
   * Build ranking groups.
   *
   * Example:
   * 1st: one player
   * 2nd: three players tied
   * next rank = 5
   */
  const groups: Array<{
    rank: number;
    players: typeof eligible;
  }> = [];

  let index = 0;
  let rank = 1;

  while (index < eligible.length) {
    const points = eligible[index].points;
    const players: typeof eligible = [];

    let end = index;

    while (
      end < eligible.length &&
      eligible[end].points === points
    ) {
      players.push(eligible[end]);
      end += 1;
    }

    /*
     * If the group begins beyond the 20th prize slot,
     * it cannot receive a prize.
     */
    if (rank > TOP_20_PRIZE_WEIGHTS.length) {
      break;
    }

    groups.push({
      rank,
      players,
    });

    rank += players.length;
    index = end;
  }

  /*
   * Each player receives a rational share:
   *
   * pool × (sum of occupied slot weights)
   * --------------------------------------
   *      total weight × group size
   *
   * We keep numerator/denominator as integers so there is
   * no floating-point percentage error.
   */
  const allocations = groups.flatMap(
    (group) => {
      const firstSlot = group.rank - 1;

      const lastSlot = Math.min(
        firstSlot + group.players.length,
        TOP_20_PRIZE_WEIGHTS.length,
      );

      if (firstSlot >= lastSlot) {
        return [];
      }

      const slotWeight = TOP_20_PRIZE_WEIGHTS
        .slice(firstSlot, lastSlot)
        .reduce(
          (sum, weight) => sum + weight,
          0,
        );

      const denominator =
        TOP_20_PRIZE_WEIGHT_TOTAL *
        group.players.length;

      return group.players.map(
        (player) => {
          const numerator =
            prizePoolEtb * slotWeight;

          const floor =
            Math.floor(
              numerator / denominator,
            );

          const remainder =
            numerator % denominator;

          return {
            entryId: player.entryId,
            telegramUserId:
              player.telegramUserId,
            rank: group.rank,
            floor,
            remainder,
            denominator,
          };
        },
      );
    },
  );

  /*
   * The full prize pool must be distributed among the
   * available winning recipients.
   *
   * For fewer than 20 participants, normalize against the
   * weights that are actually available.
   *
   * Recalculate using the applicable weight total.
   */
  const actualGroups = groups.filter(
    (group) =>
      group.rank <=
      TOP_20_PRIZE_WEIGHTS.length,
  );

  const usedWeights = actualGroups.reduce(
    (sum, group) => {
      const start = group.rank - 1;
      const count = Math.min(
        group.players.length,
        TOP_20_PRIZE_WEIGHTS.length - start,
      );

      return (
        sum +
        TOP_20_PRIZE_WEIGHTS
          .slice(start, start + count)
          .reduce(
            (a, b) => a + b,
            0,
          )
      );
    },
    0,
  );

  if (usedWeights <= 0) return [];

  const normalized = actualGroups.flatMap(
    (group) => {
      const start = group.rank - 1;

      const count = Math.min(
        group.players.length,
        TOP_20_PRIZE_WEIGHTS.length - start,
      );

      if (count <= 0) return [];

      const slotWeight =
        TOP_20_PRIZE_WEIGHTS
          .slice(start, start + count)
          .reduce(
            (a, b) => a + b,
            0,
          );

      const denominator =
        usedWeights *
        group.players.length;

      return group.players.map(
        (player) => {
          const numerator =
            prizePoolEtb * slotWeight;

          return {
            entryId: player.entryId,
            telegramUserId:
              player.telegramUserId,
            rank: group.rank,
            floor: Math.floor(
              numerator / denominator,
            ),
            remainder:
              numerator % denominator,
            denominator,
          };
        },
      );
    },
  );

  let distributed = normalized.reduce(
    (sum, item) => sum + item.floor,
    0,
  );

  let remainder =
    prizePoolEtb - distributed;

  if (remainder < 0) {
    throw new Error(
      "Prize allocations exceed prize pool",
    );
  }

  /*
   * Largest remainder method.
   *
   * If several recipients have the same fractional
   * remainder, entryId decides deterministically.
   */
  const rankedForRemainder = [...normalized].sort(
    (a, b) => {
      const left =
        BigInt(a.remainder) *
        BigInt(b.denominator);

      const right =
        BigInt(b.remainder) *
        BigInt(a.denominator);

      if (left > right) return -1;
      if (left < right) return 1;

      return a.entryId - b.entryId;
    },
  );

  for (
    let i = 0;
    i < rankedForRemainder.length &&
    remainder > 0;
    i += 1
  ) {
    rankedForRemainder[i].floor += 1;
    remainder -= 1;
  }

  distributed = rankedForRemainder.reduce(
    (sum, item) => sum + item.floor,
    0,
  );

  if (distributed !== prizePoolEtb) {
    throw new Error(
      "Prize pool was not fully distributed",
    );
  }

  return rankedForRemainder
    .map((item) => ({
      entryId: item.entryId,
      telegramUserId:
        item.telegramUserId,
      rank: item.rank,
      amountEtb: item.floor,
    }))
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.entryId - b.entryId,
    );
}

export type PrizeWinnerInput = {
  entryId: number;
  telegramUserId: number;
  rank: number;
  percentage: number;
};

export type PrizeWinnerShare = PrizeWinnerInput & { amountEtb: number };

/**
 * Calculates integer ETB payouts without losing money to rounding.
 * Any remainder is assigned one birr at a time to the largest fractional
 * shares, with entryId as the deterministic tie-breaker.
 */
export function calculatePrizeShares(
  prizePoolEtb: number,
  winners: PrizeWinnerInput[],
): PrizeWinnerShare[] {
  if (!Number.isSafeInteger(prizePoolEtb) || prizePoolEtb < 0) {
    throw new Error("Invalid prize pool");
  }
  if (winners.length === 0) return [];

  const raw = winners.map((winner) => {
    const exact = (prizePoolEtb * winner.percentage) / 100;
    const floor = Math.floor(exact);
    return { winner, exact, floor, fraction: exact - floor };
  });

  let remainder = prizePoolEtb - raw.reduce((sum, item) => sum + item.floor, 0);
  if (remainder < 0) throw new Error("Prize shares exceed prize pool");

  raw.sort((a, b) => b.fraction - a.fraction || a.winner.entryId - b.winner.entryId);
  for (let i = 0; i < raw.length && remainder > 0; i += 1, remainder -= 1) {
    raw[i].floor += 1;
  }

  return raw
    .map(({ winner, floor }) => ({ ...winner, amountEtb: floor }))
    .sort((a, b) => a.rank - b.rank || a.entryId - b.entryId);
}

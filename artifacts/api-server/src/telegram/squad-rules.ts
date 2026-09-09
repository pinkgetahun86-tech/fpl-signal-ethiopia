import type { FplPlayer, FplPosition } from "./fpl";

export const SQUAD_LIMIT = 15;
export const STARTING_XI_LIMIT = 11;
export const BUDGET = 100;

export const POSITION_LIMITS: Record<FplPosition, number> = {
  goalkeeper: 2,
  defender: 5,
  midfielder: 5,
  forward: 3,
};

export type SquadValidation =
  | { ok: true }
  | { ok: false; message: string };

const positionLabels: Record<FplPosition, string> = {
  goalkeeper: "ግብ ጠባቂ",
  defender: "ተከላካይ",
  midfielder: "አማካይ",
  forward: "አጥቂ",
};

export function validatePlayerAddition(
  selected: FplPlayer[],
  player: FplPlayer,
): SquadValidation {
  if (selected.some((selectedPlayer) => selectedPlayer.id === player.id)) {
    return { ok: false, message: "ይህ ተጫዋች አስቀድሞ ተመርጧል።" };
  }

  if (selected.length >= SQUAD_LIMIT) {
    return { ok: false, message: "15 ተጫዋቾች ተሟልተዋል።" };
  }

  const positionCount = selected.filter(
    (selectedPlayer) => selectedPlayer.position === player.position,
  ).length;
  const positionLimit = POSITION_LIMITS[player.position];
  if (positionCount >= positionLimit) {
    return {
      ok: false,
      message: `የ${positionLabels[player.position]} ቦታ ሙሉ ነው። ከፍተኛው ${positionLimit} ብቻ ነው።`,
    };
  }

  const totalCost = selected.reduce((sum, selectedPlayer) => sum + selectedPlayer.price, 0);
  if (totalCost + player.price > BUDGET + 0.001) {
    const remaining = Math.max(0, BUDGET - totalCost);
    return {
      ok: false,
      message: `የቀረው በጀት £${remaining.toFixed(1)}m ነው፤ ይህ ተጫዋች £${player.price.toFixed(1)}m ዋጋ አለው።`,
    };
  }

  const clubCount = selected.filter(
    (selectedPlayer) => selectedPlayer.clubId === player.clubId,
  ).length;
  if (clubCount >= 3) {
    return {
      ok: false,
      message: `ከ${player.club} ከፍተኛው 3 ተጫዋቾች ብቻ ሊመረጡ ይችላሉ።`,
    };
  }

  return { ok: true };
}

export function isCompleteSquad(selected: FplPlayer[]): boolean {
  return (
    selected.length === SQUAD_LIMIT &&
    (Object.keys(POSITION_LIMITS) as FplPosition[]).every(
      (position) =>
        selected.filter((selectedPlayer) => selectedPlayer.position === position).length ===
        POSITION_LIMITS[position],
    )
  );
}

export function validateStartingXI(starting: FplPlayer[]): SquadValidation {
  if (starting.length !== STARTING_XI_LIMIT) {
    return {
      ok: false,
      message: `የመጀመሪያ 11 ተጫዋቾች መሆን አለበት፤ አሁን ${starting.length} ተመርጠዋል።`,
    };
  }

  const goalkeeperCount = starting.filter((player) => player.position === "goalkeeper").length;
  const defenderCount = starting.filter((player) => player.position === "defender").length;
  const midfielderCount = starting.filter((player) => player.position === "midfielder").length;
  const forwardCount = starting.filter((player) => player.position === "forward").length;

  if (goalkeeperCount !== 1) {
    return { ok: false, message: "የመጀመሪያ 11 አንድ ግብ ጠባቂ ብቻ ሊኖረው ይገባል።" };
  }
  if (defenderCount < 3) {
    return { ok: false, message: "የመጀመሪያ 11 ቢያንስ 3 ተከላካዮች ሊኖሩት ይገባል።" };
  }
  if (midfielderCount < 2) {
    return { ok: false, message: "የመጀመሪያ 11 ቢያንስ 2 አማካዮች ሊኖሩት ይገባል።" };
  }
  if (forwardCount < 1) {
    return { ok: false, message: "የመጀመሪያ 11 ቢያንስ 1 አጥቂ ሊኖረው ይገባል።" };
  }

  return { ok: true };
}

export function isValidStartingXI(starting: FplPlayer[]): boolean {
  return validateStartingXI(starting).ok;
}

export function validateCaptainPair(
  starting: FplPlayer[],
  captainId: number | null | undefined,
  viceCaptainId: number | null | undefined,
): SquadValidation {
  if (!captainId || !starting.some((player) => player.id === captainId)) {
    return { ok: false, message: "ካፒቴን ከመጀመሪያ 11 ውስጥ መሆን አለበት።" };
  }
  if (!viceCaptainId || !starting.some((player) => player.id === viceCaptainId)) {
    return { ok: false, message: "ምትክ ካፒቴን ከመጀመሪያ 11 ውስጥ መሆን አለበት።" };
  }
  if (captainId === viceCaptainId) {
    return { ok: false, message: "ካፒቴን እና ምትክ ካፒቴን የተለያዩ ተጫዋቾች መሆን አለባቸው።" };
  }
  return { ok: true };
}

export function getBudgetUsed(selected: FplPlayer[]): number {
  return selected.reduce((sum, player) => sum + player.price, 0);
}
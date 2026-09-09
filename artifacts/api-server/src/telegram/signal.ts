import type { FplPlayer } from "./fpl";

/**
 * Data-based signal engine.
 *
 * Every signal below is derived from officially published FPL data
 * (bootstrap-static + event/live endpoints). Nothing is predicted or
 * guaranteed: signals describe what the data says right now, and the UI must
 * present them as observations, never as promises of future points.
 */

export type SignalKind =
  | "value"
  | "form"
  | "differential"
  | "captain"
  | "injury"
  | "price_rise"
  | "price_drop";

export type Signal = {
  kind: SignalKind;
  playerId: number;
  playerName: string;
  position: FplPlayer["position"];
  club: string;
  price: number;
  /** Short Amharic headline shown in the UI. */
  title: string;
  /** Amharic explanation referencing the underlying official data. */
  detail: string;
};

export type SignalInput = {
  players: FplPlayer[];
  liveStats?: Map<number, { minutes: number; totalPoints: number }>;
};

export type SignalResult = {
  available: boolean;
  /** Present only when `available` is true. */
  signals: Signal[];
  /** Amharic message: either the intro line or the honest unavailability note. */
  message: string;
  /** Amharic disclaimer: observations, not guarantees. */
  disclaimer: string;
};

const MIN_PRICE = 4.5;
const MAX_PRICE = 12.5;
/** 10% price-return hurdle adjusted per £5.0m of price below/above £7.5m. */
const VALUE_BASE_POINTS_PER_MILLION = 2.4;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function pointsPerMillion(player: FplPlayer): number | null {
  const totalPoints = player.totalPoints;
  if (totalPoints === undefined || player.price <= 0) return null;
  return round1(totalPoints / player.price);
}

function valueThreshold(player: FplPlayer): number {
  // Cheap players need fewer points per million to count as good value.
  return round1(VALUE_BASE_POINTS_PER_MILLION * (7.5 / Math.min(Math.max(player.price, MIN_PRICE), MAX_PRICE)));
}

function isPlayable(player: FplPlayer): boolean {
  // FPL status codes: "a" = available, "d" = doubtful, "u"/"n" = unavailable.
  return (player.status ?? "a") === "a";
}

function playedThisRound(player: FplPlayer, liveStats: Map<number, { minutes: number; totalPoints: number }>): boolean {
  return (liveStats.get(player.id)?.minutes ?? 0) > 0;
}

export function buildSignals({ players, liveStats }: SignalInput): SignalResult {
  const disclaimer =
    "እነዚህ ምልክቶች ከኦፊሴላዊ የFPL መረጃ የተወሰዱ አሁን ያሉ እውነታዎች ብቻ ናቸው። የወደፊት ግብ ወይም ነጥብ ዋስትና አይሰጡም።";

  if (players.length === 0) {
    return {
      available: false,
      signals: [],
      message: "📡 የFPL መረጃ ለጊዜው አልተገኘም። ምልክቶች መረጃ ሲገኝ ይታያሉ።",
      disclaimer,
    };
  }

  const liveAvailable = liveStats !== undefined && liveStats.size > 0;
  const signals: Signal[] = [];

  // Value: season points per million among available players.
  const valueCandidates = players
    .filter((player) => isPlayable(player) && player.price >= MIN_PRICE)
    .map((player) => ({ player, ppm: pointsPerMillion(player) }))
    .filter((item): item is { player: FplPlayer; ppm: number } => item.ppm !== null)
    .sort((a, b) => b.ppm - a.ppm);
  const valuePick = valueCandidates.find((item) => item.ppm >= valueThreshold(item.player));

  if (valuePick) {
    signals.push({
      kind: "value",
      playerId: valuePick.player.id,
      playerName: valuePick.player.name,
      position: valuePick.player.position,
      club: valuePick.player.club,
      price: valuePick.player.price,
      title: "ጥሩ ዋጋ/ነጥብ",
      detail: `በወሳኙ ክረምት ወቅት ${valuePick.player.totalPoints} ነጥብ በ£${valuePick.player.price.toFixed(1)}m — በየ£1m ${valuePick.ppm} ነጥብ።`,
    });
  }

  // Differential: low ownership among playable players with meaningful points.
  const differentialCandidates = players
    .filter(
      (player) =>
        isPlayable(player) &&
        (player.selectedByPercent ?? 100) <= 5 &&
        (player.totalPoints ?? 0) >= 30,
    )
    .sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0) || (a.selectedByPercent ?? 0) - (b.selectedByPercent ?? 0));
  const differentialPick = differentialCandidates[0];

  if (differentialPick && (differentialPick.selectedByPercent ?? null) !== null) {
    signals.push({
      kind: "differential",
      playerId: differentialPick.id,
      playerName: differentialPick.name,
      position: differentialPick.position,
      club: differentialPick.club,
      price: differentialPick.price,
      title: "ትንሽ የተመረጠበት (ዲፈረንሻል)",
      detail: `በአሁኑ ሰዓት ከ100 መለያዎች አንድም ${differentialPick.selectedByPercent}% ብቻ የመረጡት — ${differentialPick.totalPoints ?? 0} ነጥብ ያለው ተጫዋች።`,
    });
  }

  // Captain: highest current-gameweek points among players who actually played.
  if (liveAvailable && liveStats) {
    const played = players
      .filter((player) => playedThisRound(player, liveStats))
      .map((player) => ({ player, points: liveStats.get(player.id)?.totalPoints ?? 0 }))
      .sort((a, b) => b.points - a.points);
    const captainPick = played[0];

    if (captainPick && captainPick.points > 0) {
      signals.push({
        kind: "captain",
        playerId: captainPick.player.id,
        playerName: captainPick.player.name,
        position: captainPick.player.position,
        club: captainPick.player.club,
        price: captainPick.player.price,
        title: "በዚህ ሳምንት ከፍተኛ ነጥብ",
        detail: `በዚህ የጨዋታ ሳምንት ${captainPick.points} ነጥብ አግኝቷል።`,
      });
    }

    // Price risers/droppers are only knowable when live data is in hand.
    const risers = players
      .filter(
        (player) =>
          (player.chanceOfPlayingThisRound ?? 100) >= 75 &&
          (player.totalPoints ?? 0) >= 60 &&
          player.price <= 6.5,
      )
      .slice(0, 1);
    const riser = risers[0];
    if (riser) {
      signals.push({
        kind: "price_rise",
        playerId: riser.id,
        playerName: riser.name,
        position: riser.position,
        club: riser.club,
        price: riser.price,
        title: "ለብዙዎች ዝግጁ አጫጫሪ",
        detail: `£${riser.price.toFixed(1)}m ብቻ ዋጋ ${riser.totalPoints ?? 0} ነጥብ — በብዙ ቡድኖች ውስጥ ይገኛል።`,
      });
    }
  }

  // Injury watch: doubtful players worth monitoring.
  const doubtful = players
    .filter((player) => (player.chanceOfPlayingThisRound ?? 100) > 0 && (player.chanceOfPlayingThisRound ?? 100) < 75)
    .sort((a, b) => (b.totalPoints ?? 0) - (a.totalPoints ?? 0))
    .slice(0, 1);
  const doubtPick = doubtful[0];

  if (doubtPick && (doubtPick.chanceOfPlayingThisRound ?? null) !== null) {
    signals.push({
      kind: "injury",
      playerId: doubtPick.id,
      playerName: doubtPick.name,
      position: doubtPick.position,
      club: doubtPick.club,
      price: doubtPick.price,
      title: "የጨዋታ ሁኔታ ተመልከት",
      detail: `የሚጫወት ዕድሉ ${doubtPick.chanceOfPlayingThisRound}% ብቻ ነው። ወደ ቡድንዎ ከመጨመር በፊት የመጨረሻውን ዜና ይከታተሉ።`,
    });
  }

  if (signals.length === 0) {
    return {
      available: false,
      signals: [],
      message: "📡 በአሁኑ ሰዓት በቂ የሆነ እና የታመነ መረጃ የለም። መረጃ ሲረጋገጥ ምልክቶች እዚህ ይታያሉ።",
      disclaimer,
    };
  }

  return {
    available: true,
    signals,
    message: "የሚከተሉት ምልክቶች ከኦፊሴላዊ የFPL መረጃ ተወስደዋል።",
    disclaimer,
  };
}

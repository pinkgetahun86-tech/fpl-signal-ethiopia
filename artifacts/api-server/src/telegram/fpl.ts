import { logger } from "../lib/logger";

const FPL_BOOTSTRAP_URL = "https://fantasy.premierleague.com/api/bootstrap-static/";
const FPL_LIVE_EVENT_URL = (gameweek: number) =>
  `https://fantasy.premierleague.com/api/event/${gameweek}/live/`;
const BOOTSTRAP_CACHE_TTL_MS = 10 * 60 * 1000;
const LIVE_CACHE_TTL_MS = 60 * 1000;

export type FplPosition = "goalkeeper" | "defender" | "midfielder" | "forward";

export type FplPlayer = {
  id: number;
  name: string;
  club: string;
  clubId: number;
  position: FplPosition;
  price: number;
  status?: string;
  chanceOfPlayingThisRound?: number | null;
  chanceOfPlayingNextRound?: number | null;
  totalPoints?: number;
  /** Official FPL ownership percentage (bootstrap `selected_by_percent`). */
  selectedByPercent?: number | null;
};

export type FplGameweek = {
  id: number;
  deadlineTime: Date | null;
  isCurrent: boolean;
  isNext: boolean;
  finished: boolean;
};

export type FplLivePlayerStats = {
  minutes: number;
  totalPoints: number;
  goalsScored?: number;
  assists?: number;
  cleanSheets?: number;
  goalsConceded?: number;
  ownGoals?: number;
  penaltiesSaved?: number;
  penaltiesMissed?: number;
  yellowCards?: number;
  redCards?: number;
  saves?: number;
  bonus?: number;
  bps?: number;
};

type FplSnapshot = {
  players: FplPlayer[];
  gameweeks: FplGameweek[];
  loadedAt: number;
};

type RawFplPlayer = {
  id?: unknown;
  web_name?: unknown;
  first_name?: unknown;
  second_name?: unknown;
  team?: unknown;
  element_type?: unknown;
  now_cost?: unknown;
  status?: unknown;
  chance_of_playing_this_round?: unknown;
  chance_of_playing_next_round?: unknown;
  total_points?: unknown;
  selected_by_percent?: unknown;
};

type RawFplTeam = {
  id?: unknown;
  name?: unknown;
  short_name?: unknown;
};

type RawFplEvent = {
  id?: unknown;
  deadline_time?: unknown;
  is_current?: unknown;
  is_next?: unknown;
  finished?: unknown;
};

type RawLiveElement = {
  id?: unknown;
  stats?: {
    minutes?: unknown;
    total_points?: unknown;
    goals_scored?: unknown;
    assists?: unknown;
    clean_sheets?: unknown;
    goals_conceded?: unknown;
    own_goals?: unknown;
    penalties_saved?: unknown;
    penalties_missed?: unknown;
    yellow_cards?: unknown;
    red_cards?: unknown;
    saves?: unknown;
    bonus?: unknown;
    bps?: unknown;
  };
};

let snapshot: FplSnapshot | undefined;
const liveStatsCache = new Map<number, { stats: Map<number, FplLivePlayerStats>; loadedAt: number }>();

const positionByElementType: Record<number, FplPosition> = {
  1: "goalkeeper",
  2: "defender",
  3: "midfielder",
  4: "forward",
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function asNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function asInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function asPercentage(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100
    ? value
    : undefined;
}

function parsePercentage(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null;
}

function parseDate(value: unknown): Date | null {
  if (!isNonEmptyString(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function loadBootstrap(): Promise<FplSnapshot> {
  if (snapshot && Date.now() - snapshot.loadedAt < BOOTSTRAP_CACHE_TTL_MS) {
    return snapshot;
  }

  const response = await fetch(FPL_BOOTSTRAP_URL, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });

  if (!response.ok) {
    throw new Error(`FPL bootstrap returned HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object") {
    throw new Error("FPL bootstrap response was not an object");
  }

  const typedPayload = payload as {
    elements?: unknown;
    teams?: unknown;
    events?: unknown;
  };
  if (!Array.isArray(typedPayload.elements) || !Array.isArray(typedPayload.teams)) {
    throw new Error("FPL bootstrap response did not include players and clubs");
  }

  const clubs = new Map<number, string>();
  for (const rawTeam of typedPayload.teams as RawFplTeam[]) {
    const id = asPositiveInteger(rawTeam.id);
    const name = isNonEmptyString(rawTeam.name)
      ? rawTeam.name
      : isNonEmptyString(rawTeam.short_name)
        ? rawTeam.short_name
        : undefined;
    if (id && name) clubs.set(id, name.trim());
  }

  const players: FplPlayer[] = [];
  for (const rawPlayer of typedPayload.elements as RawFplPlayer[]) {
    const id = asPositiveInteger(rawPlayer.id);
    const clubId = asPositiveInteger(rawPlayer.team);
    const elementType = asPositiveInteger(rawPlayer.element_type);
    const rawPrice = rawPlayer.now_cost;
    const price =
      typeof rawPrice === "number" && Number.isInteger(rawPrice) && rawPrice > 0
        ? rawPrice / 10
        : undefined;
    const position = elementType ? positionByElementType[elementType] : undefined;
    const webName = isNonEmptyString(rawPlayer.web_name) ? rawPlayer.web_name.trim() : undefined;
    const fullName =
      isNonEmptyString(rawPlayer.first_name) && isNonEmptyString(rawPlayer.second_name)
        ? `${rawPlayer.first_name.trim()} ${rawPlayer.second_name.trim()}`
        : undefined;
    const name = webName ?? fullName;
    const club = clubId ? clubs.get(clubId) : undefined;

    if (!id || !clubId || !position || !name || !club || price === undefined) continue;
    players.push({
      id,
      name,
      club,
      clubId,
      position,
      price,
      status: isNonEmptyString(rawPlayer.status) ? rawPlayer.status : undefined,
      chanceOfPlayingThisRound: asPercentage(rawPlayer.chance_of_playing_this_round),
      chanceOfPlayingNextRound: asPercentage(rawPlayer.chance_of_playing_next_round),
      totalPoints: asNonNegativeInteger(rawPlayer.total_points),
      selectedByPercent: parsePercentage(rawPlayer.selected_by_percent),
    });
  }

  if (players.length === 0) {
    throw new Error("FPL bootstrap contained no valid players");
  }

  const gameweeks = Array.isArray(typedPayload.events)
    ? (typedPayload.events as RawFplEvent[])
        .map((event): FplGameweek | undefined => {
          const id = asPositiveInteger(event.id);
          if (!id) return undefined;
          return {
            id,
            deadlineTime: parseDate(event.deadline_time),
            isCurrent: event.is_current === true,
            isNext: event.is_next === true,
            finished: event.finished === true,
          };
        })
        .filter((event): event is FplGameweek => event !== undefined)
    : [];

  players.sort((a, b) => a.position.localeCompare(b.position) || a.name.localeCompare(b.name));
  snapshot = { players, gameweeks, loadedAt: Date.now() };
  logger.info({ count: players.length, gameweeks: gameweeks.length }, "Loaded live FPL data");
  return snapshot;
}

export async function getFplPlayers(): Promise<FplPlayer[]> {
  return (await loadBootstrap()).players;
}

export async function getCurrentGameweek(): Promise<FplGameweek> {
  const gameweeks = (await loadBootstrap()).gameweeks;
  const selected =
    gameweeks.find((gameweek) => gameweek.isCurrent) ??
    gameweeks.find((gameweek) => gameweek.isNext) ??
    [...gameweeks].reverse().find((gameweek) => !gameweek.finished) ??
    [...gameweeks].reverse()[0];
  if (!selected) throw new Error("FPL bootstrap did not include a gameweek");
  return selected;
}

export async function getLiveGameweekStats(
  gameweek: number,
): Promise<Map<number, FplLivePlayerStats>> {
  const cached = liveStatsCache.get(gameweek);
  if (cached && Date.now() - cached.loadedAt < LIVE_CACHE_TTL_MS) {
    return cached.stats;
  }

  const response = await fetch(FPL_LIVE_EVENT_URL(gameweek), {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) {
    throw new Error(`FPL live gameweek ${gameweek} returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as { elements?: unknown };
  if (!Array.isArray(payload.elements)) {
    throw new Error(`FPL live gameweek ${gameweek} did not include player statistics`);
  }

  const stats = new Map<number, FplLivePlayerStats>();
  for (const element of payload.elements as RawLiveElement[]) {
    const id = asPositiveInteger(element.id);
    if (!id || !element.stats) continue;
    const minutes = asNonNegativeInteger(element.stats.minutes);
    const totalPoints = asInteger(element.stats.total_points);
    if (totalPoints === undefined) continue;
    stats.set(id, {
      minutes,
      totalPoints,
      goalsScored: asNonNegativeInteger(element.stats.goals_scored),
      assists: asNonNegativeInteger(element.stats.assists),
      cleanSheets: asNonNegativeInteger(element.stats.clean_sheets),
      goalsConceded: asNonNegativeInteger(element.stats.goals_conceded),
      ownGoals: asNonNegativeInteger(element.stats.own_goals),
      penaltiesSaved: asNonNegativeInteger(element.stats.penalties_saved),
      penaltiesMissed: asNonNegativeInteger(element.stats.penalties_missed),
      yellowCards: asNonNegativeInteger(element.stats.yellow_cards),
      redCards: asNonNegativeInteger(element.stats.red_cards),
      saves: asNonNegativeInteger(element.stats.saves),
      bonus: asNonNegativeInteger(element.stats.bonus),
      bps: asNonNegativeInteger(element.stats.bps),
    });
  }

  if (stats.size === 0) {
    throw new Error(`FPL live gameweek ${gameweek} contained no player statistics`);
  }

  liveStatsCache.set(gameweek, { stats, loadedAt: Date.now() });
  logger.info({ gameweek, count: stats.size }, "Loaded live FPL gameweek points");
  return stats;
}
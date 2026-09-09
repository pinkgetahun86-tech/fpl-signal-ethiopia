import assert from "node:assert/strict";
import { buildSignals } from "./signal";
import type { FplPlayer } from "./fpl";

function player(overrides: Partial<FplPlayer> & { id: number }): FplPlayer {
  return {
    name: `Player ${overrides.id}`,
    club: "FC",
    clubId: 1,
    position: "midfielder",
    price: 6,
    status: "a",
    totalPoints: 0,
    selectedByPercent: 10,
    ...overrides,
  };
}

const basePlayers: FplPlayer[] = [
  player({ id: 1, name: "Cheap Value", price: 4.5, totalPoints: 40, selectedByPercent: 20 }),
  player({ id: 2, name: "Expensive", price: 12, totalPoints: 60, selectedByPercent: 45 }),
  player({ id: 3, name: "Differential", price: 6, totalPoints: 45, selectedByPercent: 3.2 }),
  player({ id: 4, name: "Doubtful", price: 7, totalPoints: 80, status: "d", chanceOfPlayingThisRound: 25, selectedByPercent: 30 }),
];

// 1. Empty player list must be an honest "unavailable" signal, never invented data.
{
  const result = buildSignals({ players: [] });
  assert.equal(result.available, false);
  assert.deepEqual(result.signals, []);
  assert.ok(result.message.includes("አልተገኘም"));
}

// 2. Value signal: cheap high-scorer surfaces with points-per-million reasoning.
{
  const result = buildSignals({ players: basePlayers });
  const value = result.signals.find((signal) => signal.kind === "value");
  assert.ok(value, "value signal expected");
  assert.equal(value.playerId, 1);
  assert.ok(value.detail.includes("£4.5m"));
}

// 3. Differential: low ownership + real points.
{
  const result = buildSignals({ players: basePlayers });
  const differential = result.signals.find((signal) => signal.kind === "differential");
  assert.ok(differential, "differential signal expected");
  assert.equal(differential.playerId, 3);
  assert.ok(differential.detail.includes("3.2%"));
}

// 4. Injury watch surfaces doubtful players with the official chance.
{
  const result = buildSignals({ players: basePlayers });
  const injury = result.signals.find((signal) => signal.kind === "injury");
  assert.ok(injury, "injury signal expected");
  assert.equal(injury.playerId, 4);
  assert.ok(injury.detail.includes("25%"));
}

// 5. Captain signal comes from live gameweek points only.
{
  const liveStats = new Map([
    [2, { minutes: 90, totalPoints: 12 }],
    [3, { minutes: 60, totalPoints: 7 }],
  ]);
  const result = buildSignals({ players: basePlayers, liveStats });
  const captain = result.signals.find((signal) => signal.kind === "captain");
  assert.ok(captain, "captain signal expected");
  assert.equal(captain.playerId, 2);
  assert.ok(captain.detail.includes("12"));
}

// 6. No played players -> no captain signal (never invent one).
{
  const liveStats = new Map([
    [2, { minutes: 0, totalPoints: 0 }],
  ]);
  const result = buildSignals({ players: basePlayers, liveStats });
  assert.equal(result.signals.find((signal) => signal.kind === "captain"), undefined);
}

// 7. Every signal always carries the disclaimer and never promises points.
{
  const result = buildSignals({ players: basePlayers });
  assert.ok(result.disclaimer.includes("ዋስትና"));
  for (const signal of result.signals) {
    assert.ok(signal.title.length > 0);
    assert.ok(signal.detail.length > 0);
    assert.ok(!/ወደፊት .*ያስቀምጣል|guaranteed/i.test(signal.detail));
  }
}

// 8. Unavailable players are excluded from value/differential picks.
{
  const result = buildSignals({
    players: [player({ id: 9, name: "Out Long-term", price: 4.5, totalPoints: 90, status: "u" })],
  });
  assert.equal(result.signals.find((signal) => signal.kind === "value"), undefined);
}

// 9. Signals with no qualifying candidates must say data is unavailable.
{
  const result = buildSignals({
    players: [player({ id: 10, name: "Nobody", price: 6, totalPoints: 2, selectedByPercent: 50 })],
  });
  assert.equal(result.available, false);
  assert.deepEqual(result.signals, []);
  assert.ok(result.message.length > 0);
}

console.log("signal tests passed");

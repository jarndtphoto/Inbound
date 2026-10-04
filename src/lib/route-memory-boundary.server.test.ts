import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "./db.ts";
import { createRouteMemoryStore } from "./route-memory-store.server.ts";
import { emptyRouteMemory, mergeRouteMemory, routeLeg, routeMemoryEqual, routeProgress, sanitizeRouteMemory, type RouteMemory } from "./route-memory.ts";
import { polylineLengthNm, progressAlongPath } from "./geo.ts";

const key = "leg:v1:UAL218|2026-10-03|HNL|ORD";
const leg = routeLeg(key, "HNL", "ORD")!;
const takeoff = Date.parse("2026-10-04T02:16:00Z");
const seenAt = takeoff + 65_000;
const older = [
  { lat: 22.495972, lon: -156.312777, seenAt: takeoff - 3 * 3600_000 },
  { lat: 21.275118, lon: -157.819468, seenAt: takeoff - 170 * 60_000 },
];
const current = [
  { lat: 21.31, lon: -157.90, seenAt: takeoff },
  { lat: 21.28, lon: -157.88, seenAt },
];
const filed: RouteMemory["filed"] = {
  waypoints: [{ lat: 21.32, lon: -157.92 }, { lat: 30, lon: -140 }, { lat: 40, lon: -110 }, { lat: 41.98, lon: -87.90 }],
  observedAt: takeoff, fingerprint: "same-dated-filed-plan",
};
const polluted = (): RouteMemory => ({
  ...emptyRouteMemory(leg), filed, track: [...older, ...current],
  lastObserved: { ...current[1]!, progress: .04, totalNm: 3900, remainingNm: 3744 },
});
const repaired = (): RouteMemory => ({
  ...sanitizeRouteMemory(polluted(), takeoff),
  lastObserved: { ...current[1]!, progress: .001, totalNm: 3900, remainingNm: 3896.1 },
  progressGeometryVersion: 1,
});

test("a real departure boundary drops an earlier sector and invalidates its current-timestamp progress", () => {
  const raw = polluted(), original = structuredClone(raw);
  const clean = sanitizeRouteMemory(raw, takeoff);
  assert.deepEqual(clean.track, current, "the observation exactly at the cutoff is retained");
  assert.equal(clean.lastObserved, null, "a recent timestamp does not make progress over an old sector valid");
  assert.equal(clean.trackNotBeforeMs, takeoff);
  assert.equal(clean.filed, raw.filed, "sanitization does not change the filed route");
  assert.deepEqual(raw, original, "raw loaded memory remains available for the dirty check");
  assert(!routeMemoryEqual(raw, clean));
  assert.equal(sanitizeRouteMemory(clean), clean, "an already clean boundary is a no-op");
});

test("a late provider stamp cannot advance an accepted departure boundary or trim good observations", () => {
  const clean = repaired();
  const late = sanitizeRouteMemory(clean, takeoff + 10 * 60_000);
  assert.equal(late, clean);
  assert.equal(mergeRouteMemory(clean, { ...emptyRouteMemory(leg), trackNotBeforeMs: takeoff + 10 * 60_000 }).trackNotBeforeMs, takeoff);
  assert.deepEqual(late.track, current);
  assert.deepEqual(late.lastObserved, clean.lastObserved);
});

test("sanitizing both merge inputs rejects stale history while retaining corrected progress at the same timestamp", () => {
  const clean = repaired(), stale = polluted();
  const merged = mergeRouteMemory(stale, clean);
  assert.deepEqual(merged.track, current);
  assert.deepEqual(merged.lastObserved, clean.lastObserved, "the polluted input's same-timestamp progress is invalidated first");
  const reverse = mergeRouteMemory(clean, stale);
  assert.deepEqual(reverse.track, current);
  assert.deepEqual(reverse.lastObserved, clean.lastObserved);
});

test("no boundary preserves the complete observed-only oceanic history and last-known progress", () => {
  const oceanLeg = { origin: "ORD", destination: "HNL", date: "2026-10-03" };
  const ocean = {
    ...emptyRouteMemory(oceanLeg),
    track: [
      { lat: 41.98, lon: -87.90, seenAt: takeoff - 8 * 3600_000 },
      { lat: 35, lon: -125, seenAt: takeoff - 4 * 3600_000 },
      { lat: 25, lon: -150, seenAt: takeoff - 2 * 3600_000 },
    ],
    lastObserved: { lat: 25, lon: -150, seenAt: takeoff - 2 * 3600_000, progress: .8, totalNm: 4000, remainingNm: 800 },
  };
  assert.equal(sanitizeRouteMemory(ocean), ocean, "first airborne observation is not a departure-time cutoff");
  const gap = mergeRouteMemory(ocean, emptyRouteMemory(oceanLeg));
  assert.deepEqual(gap.track, ocean.track);
  assert.deepEqual(gap.lastObserved, ocean.lastObserved);
  const progress = routeProgress(filed!.waypoints, gap, null, true, false);
  assert.equal(progress.source, "last_known");
  assert.equal(progress.progress, .8);
  assert.equal(progress.remainingNm, 800);
});

test("missing/null/invalid boundaries compare equally and boundaries never cross date or route changes", () => {
  const state = polluted();
  for (const value of [null, undefined, NaN, Infinity, -1, 0]) {
    assert(routeMemoryEqual(state, { ...state, trackNotBeforeMs: value }));
    assert.equal(sanitizeRouteMemory(state, value), state);
  }
  for (const other of [{ ...leg, date: "2026-10-04" }, { ...leg, destination: "SFO" }]) {
    const incoming = { ...emptyRouteMemory(other), track: older };
    assert.deepEqual(mergeRouteMemory(repaired(), incoming), incoming);
  }
});

test("progress ends at the first actual anchor even when a future loop revisits it more precisely", () => {
  const observation = { lat: 21.324603, lon: -157.367859, seenAt };
  const path = [
    { lat: 21.3187, lon: -157.9225 },
    { lat: observation.lat + 1e-7, lon: observation.lon }, // <2 cm from the actual anchor
    { lat: 30, lon: -150 },
    observation, // a projected future loop, not additional flown history
    { lat: 41.9786, lon: -87.9048 },
  ];
  const result = routeProgress(path, null, observation, true, false);
  const flown = polylineLengthNm(path.slice(0, 2));
  assert.equal(result.progress, flown / polylineLengthNm(path));
  assert.equal(result.remainingNm, polylineLengthNm(path) - flown);
  assert(flown < 40, "the future's out-and-back loop contributes no flown distance");
  assert.equal(result.observedAt, observation.seenAt);
});

test("an exact origin anchor stays at zero before a projected loop and an unanchored path still uses projection", () => {
  const observation = { lat: 21.3187, lon: -157.9225, seenAt };
  const loop = [observation, { lat: 24, lon: -150 }, observation, { lat: 41.9786, lon: -87.9048 }];
  const anchored = routeProgress(loop, null, observation, true, false);
  assert.equal(anchored.progress, 0);
  assert.equal(anchored.remainingNm, anchored.totalNm);
  const path = [{ lat: 0, lon: 0 }, { lat: 0, lon: 4 }];
  const between = { lat: 0, lon: 2, seenAt };
  const projected = progressAlongPath(path, between);
  const unanchored = routeProgress(path, null, between, true, false);
  assert.equal(unanchored.progress, projected.frac);
  assert.equal(unanchored.remainingNm, projected.remainingNm);
});

test("corrected filed-only progress supersedes a legacy prefix at the same timestamp without dropping observed points", () => {
  const legacy = { ...polluted(), track: [] };
  const corrected: RouteMemory = { ...legacy, progressGeometryVersion: 1,
    lastObserved: { ...legacy.lastObserved!, progress: .001, remainingNm: 3896.1 } };
  assert(!routeMemoryEqual(legacy, corrected));
  for (const merged of [mergeRouteMemory(legacy, corrected), mergeRouteMemory(corrected, legacy)]) {
    assert.deepEqual(merged.lastObserved, corrected.lastObserved);
    assert.equal(merged.progressGeometryVersion, 1);
    assert.deepEqual(merged.filed, legacy.filed);
  }
  const newerLegacy = { ...polluted(), lastObserved: { ...legacy.lastObserved!, seenAt: seenAt + 30_000 } };
  const held = mergeRouteMemory(corrected, newerLegacy);
  assert.deepEqual(held.lastObserved, corrected.lastObserved, "a newer timestamp cannot restore old geometry");
  assert.deepEqual(held.track, newerLegacy.track, "geometry version does not prune real points without a takeoff boundary");
});

test("current-version progress keeps the newer actual anchor and remains stable through a coverage gap", () => {
  const first = repaired();
  const newer: RouteMemory = { ...first, lastObserved: { ...first.lastObserved!, seenAt: seenAt + 30_000, progress: .002, remainingNm: 3892.2 } };
  for (const merged of [mergeRouteMemory(first, newer), mergeRouteMemory(newer, first)])
    assert.deepEqual(merged.lastObserved, newer.lastObserved);
  const gap = mergeRouteMemory(newer, emptyRouteMemory(leg));
  assert.deepEqual(gap.lastObserved, newer.lastObserved);
  assert.equal(gap.progressGeometryVersion, 1);
  assert.deepEqual(routeProgress(filed!.waypoints, gap, null, true, false), {
    progress: .002, totalNm: 3900, remainingNm: 3892.2, source: "last_known", observedAt: seenAt + 30_000,
  });
});

async function database() {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL("../../migrations/0005_route_geometry_state.sql", import.meta.url), "utf8"));
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0];
    for (let i = 0; i < values.length; i++) query += `$${i + 1}${strings[i + 1]}`;
    return (await pg.query(query, values)).rows;
  }) as Sql;
  sql.query = async <T = Record<string, unknown>>(query: string, values: unknown[] = []) => (await pg.query<T>(query, values)).rows;
  const store = () => createRouteMemoryStore(async () => sql, async () => {});
  return { pg, sql, store };
}

test("cold load sanitizes a legacy JSONB row without writing and save repairs its raw stored state once", async () => {
  const { pg, store } = await database();
  try {
    const raw = { ...polluted(), trackNotBeforeMs: takeoff };
    await pg.query("insert into flight_route_state (land_key,state,version) values ($1,$2::jsonb,1)", [key, JSON.stringify(raw)]);
    const loaded = await store().load(key, leg);
    assert.deepEqual(loaded.state.track, current);
    assert.equal(loaded.state.lastObserved, null);
    assert.deepEqual(loaded.storedState, raw);
    assert(!routeMemoryEqual(loaded.state, loaded.storedState));
    assert.equal((await pg.query<{ version: number }>("select version from flight_route_state where land_key=$1", [key])).rows[0]!.version, 1);
    const saved = await store().save(key, { ...loaded.state, lastObserved: repaired().lastObserved }, loaded.version);
    assert.equal(saved.status, "ok");
    assert.equal(saved.version, 2);
    const cold = await store().load(key, leg);
    assert(routeMemoryEqual(cold.state, cold.storedState));
    assert.deepEqual(cold.state.lastObserved, repaired().lastObserved);
    await store().save(key, cold.state, cold.version);
    assert.equal((await pg.query<{ version: number }>("select version from flight_route_state where land_key=$1", [key])).rows[0]!.version, 2);
  } finally { await pg.close(); }
});

test("a lost CAS retry merges the clean winner before a stale poll can resurrect prior-flight observations", async () => {
  const { pg, sql, store } = await database();
  try {
    const stale = polluted();
    await pg.query("insert into flight_route_state (land_key,state,version) values ($1,$2::jsonb,1)", [key, JSON.stringify(stale)]);
    const winner = repaired();
    winner.track.push({ lat: 21.25, lon: -157.84, seenAt: seenAt + 30_000 });
    winner.lastObserved = { ...winner.track.at(-1)!, progress: .002, totalNm: 3900, remainingNm: 3892.2 };
    let insertedWinner = false;
    const racingSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!insertedWinner && /^\s*insert/i.test(strings[0])) {
        insertedWinner = true;
        await pg.query("update flight_route_state set state=$2::jsonb,version=version+1 where land_key=$1", [key, JSON.stringify(winner)]);
      }
      return sql(strings, ...values);
    }) as Sql;
    racingSql.query = sql.query;
    const racing = createRouteMemoryStore(async () => racingSql, async () => {});
    const saved = await racing.save(key, repaired(), 1);
    assert(insertedWinner);
    assert.equal(saved.status, "conflict_resolved");
    assert.deepEqual(saved.state.track, winner.track);
    assert.deepEqual(saved.state.lastObserved, winner.lastObserved);
    assert.equal(saved.state.trackNotBeforeMs, takeoff);
    const oldPoll = await store().save(key, stale, 1);
    assert.deepEqual(oldPoll.state.track, winner.track);
    assert.deepEqual(oldPoll.state.lastObserved, winner.lastObserved);
    const cold = await store().load(key, leg);
    assert.deepEqual(cold.state.track, winner.track);
    assert.deepEqual(cold.state.lastObserved, winner.lastObserved);
  } finally { await pg.close(); }
});

test("cold stores preserve unbounded oceanic history during a no-position poll", async () => {
  const { pg, store } = await database();
  try {
    const ocean = polluted();
    const saved = await store().save(key, ocean, 0);
    const cold = await store().load(key, leg);
    assert.deepEqual(cold.state.track, ocean.track);
    assert.deepEqual(cold.state.lastObserved, ocean.lastObserved);
    const gap = await store().save(key, emptyRouteMemory(leg), cold.version);
    assert.deepEqual(gap.state.track, ocean.track);
    assert.deepEqual(gap.state.lastObserved, ocean.lastObserved);
    assert.equal(gap.version, saved.version, "the gap neither clears history nor creates a new write");
  } finally { await pg.close(); }
});

test("a filed-only legacy JSONB row is repaired at the same observation timestamp and stale CAS data cannot restore it", async () => {
  const { pg, store } = await database();
  try {
    const legacy: RouteMemory = { ...polluted(), track: [] };
    await pg.query("insert into flight_route_state (land_key,state,version) values ($1,$2::jsonb,1)", [key, JSON.stringify(legacy)]);
    const loaded = await store().load(key, leg);
    assert.deepEqual(loaded.state.lastObserved, legacy.lastObserved, "the real held anchor remains available to recompute geometry");
    const corrected: RouteMemory = { ...loaded.state, progressGeometryVersion: 1,
      lastObserved: { ...loaded.state.lastObserved!, progress: .001, remainingNm: 3896.1 } };
    const saved = await store().save(key, corrected, loaded.version);
    assert.equal(saved.version, 2);
    assert.deepEqual(saved.state.lastObserved, corrected.lastObserved);
    const stale: RouteMemory = { ...legacy, lastObserved: { ...legacy.lastObserved!, seenAt: seenAt + 60_000 } };
    const held = await store().save(key, stale, 1);
    assert.equal(held.state.progressGeometryVersion, 1);
    assert.deepEqual(held.state.lastObserved, corrected.lastObserved);
    const cold = await store().load(key, leg);
    assert.deepEqual(cold.state.lastObserved, corrected.lastObserved);
    assert.equal(cold.state.progressGeometryVersion, 1);
    assert(routeMemoryEqual(cold.state, cold.storedState));
  } finally { await pg.close(); }
});

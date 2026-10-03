import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "./db.ts";
import { createRouteMemoryStore } from "./route-memory-store.server.ts";
import { emptyRouteMemory, routeLeg, validatedFiledRoute, mergeRouteMemory } from "./route-memory.ts";

const key = "leg:v1:UAL219|2026-10-03|ORD|HNL";
const leg = routeLeg(key, "ORD", "HNL")!;
const origin = { lat: 41.98, lon: -87.90 }, dest = { lat: 21.32, lon: -157.92 };
const waypoints = [origin, { lat: 40, lon: -110 }, { lat: 30, lon: -140 }, dest];
const now = Date.parse("2026-10-03T19:00:00Z");
const poll = () => emptyRouteMemory(leg);

test("filed → direct → filed, cold stores, reroute and concurrent weak polls retain the best same-leg geometry", async () => {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL("../../migrations/0005_route_geometry_state.sql", import.meta.url), "utf8"));
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0]; for (let i = 0; i < values.length; i++) query += `$${i + 1}${strings[i + 1]}`;
    return (await pg.query(query, values)).rows;
  }) as Sql;
  const cold = () => createRouteMemoryStore(async () => sql);
  try {
    const first = poll(); first.filed = validatedFiledRoute(waypoints, origin, dest, true, now);
    first.track = [{ ...origin, seenAt: now - 100_000 }, { lat: 35, lon: -120, seenAt: now }];
    first.lastObserved = { lat: 35, lon: -120, seenAt: now, progress: 0.45, totalNm: 3900, remainingNm: 2145 };
    const saved = await cold().save(key, first, 0);
    const direct = await cold().save(key, poll(), saved.version);
    assert.deepEqual(direct.state.filed, first.filed); assert.deepEqual(direct.state.track, first.track);
    assert.deepEqual((await cold().load(key, leg)).state, direct.state, "cold instance recovers both spine and observed track");
    const reroute = poll(); reroute.filed = validatedFiledRoute([origin, { lat: 43, lon: -108 }, { lat: 33, lon: -135 }, dest], origin, dest, true, now + 1000);
    const nextTrack = poll(); nextTrack.track = [{ lat: 34, lon: -122, seenAt: now + 2000 }];
    const race = await Promise.all([cold().save(key, reroute, direct.version), cold().save(key, nextTrack, direct.version), cold().save(key, poll(), direct.version)]);
    assert(race.every(r => ["ok", "conflict_resolved", "conflict_held"].includes(r.status)));
    const final = await cold().load(key, leg);
    assert.equal(final.state.filed!.fingerprint, reroute.filed!.fingerprint);
    assert.equal(final.state.track.length, 3);
    assert.deepEqual(final.state.lastObserved, first.lastObserved, "weak/concurrent cold polls retain observed progress and time");
    assert.equal((await pg.query("select * from flight_route_state")).rows.length, 1);
    for (const other of ["leg:v1:UAL219|2026-10-04|ORD|HNL", "leg:v1:UAL219|2026-10-03|ORD|SFO"]) {
      const otherLeg = routeLeg(other, "ORD", other.endsWith("SFO") ? "SFO" : "HNL")!;
      assert.equal((await cold().load(other, otherLeg)).state.filed, null);
    }
    const fallback = "leg:unvalidated:UAL219|ORD|HNL|2026-10-03";
    await cold().save(fallback, first, 0);
    const promoted = await cold().load(key, leg, [fallback]);
    assert.equal(promoted.state.filed!.fingerprint, reroute.filed!.fingerprint);
    assert.equal((await pg.query("select * from flight_route_state where land_key = $1", [fallback])).rows.length, 1, "legacy row is not deleted");
  } finally { await pg.close(); }
});

test("route memory rejects unvalidated waypoints and isolates date/route/diversion changes", () => {
  assert.equal(validatedFiledRoute(waypoints, origin, dest, false, now), null);
  assert.equal(validatedFiledRoute([{ lat: NaN, lon: 0 }, ...waypoints], origin, dest, true, now), null);
  assert.equal(routeLeg(key, "ORD", "SFO"), null);
  const first = poll(); first.filed = validatedFiledRoute(waypoints, origin, dest, true, now);
  for (const other of [{ ...leg, date: "2026-10-04" }, { ...leg, destination: "SFO" }])
    assert.equal(mergeRouteMemory(first, emptyRouteMemory(other)).filed, null);
});

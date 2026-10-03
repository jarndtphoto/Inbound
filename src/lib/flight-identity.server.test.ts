import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "./db.ts";
import { canonicalLegKey, legacyLegKeys, flightStateIdentity, unvalidatedLegKey } from "./flight-identity.ts";
import { createFlightPhaseStateStore } from "./flight-phase-state-store.server.ts";
import { createArrivalStateStore } from "./arrival-state-store.server.ts";
import { emptyArrivalState } from "./arrival-projection-state.ts";

const schedule = { ident: "UAL219", iataIdent: "UA219", flightId: "UAL219-1790952900-schedule-old",
  originIata: "ORD", destIata: "HNL", gateOut: { scheduled: 1790952900 } };
const context = { requested: "UA219", origin: { iata: "ORD" }, destination: { iata: "HNL" } };
const key = canonicalLegKey(schedule, context)!;
const departure = { push: { unix: 1790955180, source: "provider_actual", live: true, at: 1790955180 }, taxiOut: { at: 1790957520 } };
const arrival = { ...emptyArrivalState(), active: true, side: -1, startedAt: 1790983600000,
  lastFixAt: 1790983600000, cursorNm: 10, points: [{ lat: 21.4, lon: -158 }], pointAlongNm: [20] };

async function database() {
  const pg = new PGlite();
  for (const file of ["0002_flight_phase_state.sql", "0003_arrival_projection_state.sql"])
    await pg.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0]; for (let i = 0; i < values.length; i++) query += `$${i + 1}${strings[i + 1]}`;
    return (await pg.query(query, values)).rows;
  }) as Sql;
  return { pg, sql, phase: () => createFlightPhaseStateStore(async () => sql),
    arrival: () => createArrivalStateStore(async () => sql) };
}

test("legacy provider row carries forward; handoff and cold stores use one canonical row, legacy untouched", async () => {
  const db = await database(), realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error("Canonical identity must not request providers"); };
  try {
    const legacy = `${schedule.flightId}|ORD|HNL`;
    await db.phase().save(legacy, departure, 0); await db.arrival().save(legacy, arrival, 0);
    for (const flightId of [schedule.flightId, null, schedule.flightId]) {
      const record = { ...schedule, flightId }, canonical = canonicalLegKey(record, context)!;
      assert.equal(canonical, key);
      const phase = await db.phase().load(canonical, legacyLegKeys(record, context));
      const ar = await db.arrival().load(canonical, legacyLegKeys(record, context));
      assert.deepEqual(phase.state, departure); assert.deepEqual(ar.state, arrival);
      assert.equal(phase.version, 1); assert.equal(ar.version, 1);
    }
    for (const table of ["flight_phase_state", "arrival_projection_state"]) {
      const rows = (await db.pg.query<{ land_key: string; version: number }>(`select land_key, version from ${table}`)).rows;
      assert.deepEqual(rows.map(r => r.land_key).sort(), [legacy, key].sort());
      assert.equal(rows.find(r => r.land_key === legacy)!.version, 1);
    }
  } finally { globalThis.fetch = realFetch; await db.pg.close(); }
});
test("fallback cold start carries old origKey forward; existing canonical state takes precedence", async () => {
  const db = await database();
  try {
    const legacy = "UAL219|ORD|HNL|2026-10-02", fallback = { ...schedule, flightId: null };
    await db.phase().save(legacy, departure, 0); await db.arrival().save(legacy, arrival, 0);
    assert.deepEqual((await db.phase().load(key, legacyLegKeys(fallback, context))).state, departure);
    assert.deepEqual((await db.arrival().load(key, legacyLegKeys(fallback, context))).state, arrival);
    await db.phase().save(legacy, { ...departure, taxiOut: { at: 1790959999 } }, 1);
    await db.arrival().save(legacy, { ...arrival, lastFixAt: arrival.lastFixAt + 1000 }, 1);
    assert.deepEqual((await db.phase().load(key, legacyLegKeys(fallback, context))).state, departure);
    assert.deepEqual((await db.arrival().load(key, legacyLegKeys(fallback, context))).state, arrival);
  } finally { await db.pg.close(); }
});
test("fallback-only cold start discovers dated provider rows, leaving opaque and tomorrow's rows untouched", async () => {
  const db = await database();
  try {
    const legacy = `${schedule.flightId}|ORD|HNL`, tomorrow = `UAL219-${1790952900 + 86400}-schedule-next|ORD|HNL`;
    for (const old of [legacy, tomorrow, "opaque-id|ORD|HNL"]) {
      await db.phase().save(old, departure, 0); await db.arrival().save(old, arrival, 0);
    }
    const keys = legacyLegKeys({ ...schedule, flightId: null }, context);
    assert.deepEqual((await db.phase().load(key, keys)).state, departure);
    assert.deepEqual((await db.arrival().load(key, keys)).state, arrival);
    for (const table of ["flight_phase_state", "arrival_projection_state"])
      assert.equal((await db.pg.query(`select land_key from ${table}`)).rows.length, 4);
  } finally { await db.pg.close(); }
});
test("simultaneous cold carry-forward and stale phase saves retain CAS/mergeForward", async () => {
  const db = await database();
  try {
    await db.phase().save(`${schedule.flightId}|ORD|HNL`, departure, 0);
    const stores = [db.phase(), db.phase()];
    const loaded = await Promise.all(stores.map(store => store.load(key, legacyLegKeys(schedule, context))));
    assert(loaded.every(row => row.status === "ok"));
    assert.deepEqual((await db.phase().load(key)).state, departure);
    await stores[0].save(key, { ...departure, taxiOut: { at: 1790959999 } }, loaded[0].version);
    assert.equal(await stores[1].save(key, { push: null, taxiOut: null }, loaded[0].version), "conflict_resolved");
    assert.deepEqual((await db.phase().load(key)).state, { ...departure, taxiOut: { at: 1790959999 } });
    assert.equal((await db.pg.query("select land_key from flight_phase_state where land_key = $1", [key])).rows.length, 1);
  } finally { await db.pg.close(); }
});
test("arrival carry-forward never overwrites a concurrent canonical winner", async () => {
  const db = await database();
  try {
    await db.arrival().save(`${schedule.flightId}|ORD|HNL`, arrival, 0);
    const stores = [db.arrival(), db.arrival()];
    const loaded = await Promise.all(stores.map(store => store.load(key, legacyLegKeys(schedule, context))));
    const current = await db.arrival().load(key);
    const winner = { ...arrival, side: 1, lastFixAt: arrival.lastFixAt + 1000 };
    await stores[0].save(key, winner, current.version);
    const stale = await stores[1].save(key, arrival, current.version);
    assert.equal(stale.status, "conflict_held"); assert.deepEqual(stale.state, winner);
    assert(loaded.every(row => row.status === "ok"));
    assert.equal((await db.pg.query("select land_key from arrival_projection_state where land_key = $1", [key])).rows.length, 1);
  } finally { await db.pg.close(); }
});
test("next-day and different-route polls do not carry old state forward", async () => {
  const db = await database();
  try {
    await db.phase().save(key, departure, 0); await db.arrival().save(key, arrival, 0);
    await db.phase().save(`${schedule.flightId}|ORD|HNL`, departure, 0);
    const tomorrow = { ...schedule, gateOut: { scheduled: 1790952900 + 86400 } };
    assert(!legacyLegKeys(tomorrow, context).includes(`${schedule.flightId}|ORD|HNL`));
    for (const [record, route] of [[tomorrow, context], [{ ...schedule, destIata: "LAX" }, { ...context, destination: { iata: "LAX" } }]] as const) {
      const other = canonicalLegKey(record, route)!;
      assert.deepEqual((await db.phase().load(other, legacyLegKeys(record, route))).state, { push: null, taxiOut: null });
      assert.equal((await db.arrival().load(other, legacyLegKeys(record, route))).state.active, false);
    }
  } finally { await db.pg.close(); }
});
test("UA219 provider handoff fixture selects the same durable leg without changing stage logic", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../scripts/fixtures/ua219-provider-handoff.json", import.meta.url), "utf8"));
  const first = { ...schedule, flightId: fixture.flightawareRecord.flightId,
    gateOut: { scheduled: fixture.flightawareRecord.gateDepartureTimes.scheduled } };
  assert.match(fixture.flightstatsHtml, /ORD[\s\S]*HNL/);
  assert.equal(canonicalLegKey(first, context), canonicalLegKey({ ...first, flightId: null }, context));
});
test("unvalidated FR24 state survives cold stores, folds forward, and reconciles later schedule gaps", async () => {
  const db = await database();
  try {
    const noSchedule = { ...schedule, gateOut: {}, takeoff: {} };
    const fallback = flightStateIdentity(noSchedule, context, { nowSec: 1790952900 });
    assert.equal(fallback.canPersist, true);
    await db.phase().save(fallback.key!, departure, 0); await db.arrival().save(fallback.key!, arrival, 0);
    assert.deepEqual((await db.phase().load(fallback.key!)).state, departure);
    const validated = flightStateIdentity(schedule, context);
    assert.deepEqual((await db.phase().load(validated.key!, validated.legacyKeys)).state, departure);
    assert.deepEqual((await db.arrival().load(validated.key!, validated.legacyKeys)).state, arrival);
    await db.phase().save(fallback.key!, { ...departure, taxiOut: { at: 1790959999 } }, 1);
    const laterArrival = { ...arrival, lastFixAt: arrival.lastFixAt + 1000 };
    await db.arrival().save(fallback.key!, laterArrival, 1);
    const carried = await db.phase().load(validated.key!, validated.legacyKeys);
    assert.equal(carried.state.taxiOut!.at, 1790959999);
    assert.deepEqual((await db.arrival().load(validated.key!, validated.legacyKeys)).state, laterArrival);
    assert.equal((await db.phase().load(validated.key!, validated.legacyKeys)).version, carried.version, "unchanged carry-forward does not write again");
    assert.equal((await db.phase().load(fallback.key!)).version, 2, "fallback row retained");
  } finally { await db.pg.close(); }
});
test("fallback rows isolate different days/routes and UTC date is validated against scheduled clock", async () => {
  const db = await database();
  try {
    const noSchedule = { ...schedule, gateOut: {} }, today = unvalidatedLegKey(noSchedule, context, 1790952900)!;
    await db.phase().save(today, departure, 0); await db.arrival().save(today, arrival, 0);
    const tomorrow = unvalidatedLegKey(noSchedule, context, 1790952900 + 86400)!;
    const otherRoute = unvalidatedLegKey(noSchedule, { ...context, destination: { iata: "LAX" } }, 1790952900)!;
    for (const other of [tomorrow, otherRoute]) {
      assert.deepEqual((await db.phase().load(other)).state, { push: null, taxiOut: null });
      assert.equal((await db.arrival().load(other)).state.active, false);
    }
    const next = { ...schedule, flightId: null, gateOut: { scheduled: 1790952900 + 86400 } };
    const identity = flightStateIdentity(next, context);
    assert(!identity.legacyKeys.includes(today));
    assert.deepEqual((await db.phase().load(identity.key!, identity.legacyKeys)).state, { push: null, taxiOut: null });
    const midnight = { ...schedule, gateOut: { scheduled: Date.parse("2026-10-03T04:45:00Z") / 1000 } };
    const keys = legacyLegKeys(midnight, context);
    assert(keys.includes("leg:unvalidated:UAL219|ORD|HNL|2026-10-03"));
    assert(!keys.includes("leg:unvalidated:UAL219|ORD|HNL|2026-10-04"));
  } finally { await db.pg.close(); }
});

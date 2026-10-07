import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "./db.ts";
import { activeConfirmedTakeoff } from "./flight-phase-state-logic.ts";
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
  for (const file of ["0002_flight_phase_state.sql", "0003_arrival_projection_state.sql", "0004_confirmed_takeoff.sql", "0011_push_scope_boundary.sql"])
    await pg.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0]; for (let i = 0; i < values.length; i++) query += `$${i + 1}${strings[i + 1]}`;
    return (await pg.query(query, values)).rows;
  }) as Sql;
  return { pg, sql, phase: () => createFlightPhaseStateStore(async () => sql),
    arrival: () => createArrivalStateStore(async () => sql) };
}

const deltaContext = { requested: "DL4820", origin: { iata: "MDW" }, destination: { iata: "MSP" } };
const deltaSchedule = { ident: "EDV4820", iataIdent: "DL4820", originIata: "MDW", destIata: "MSP",
  gateOut: { scheduled: 1791054000 }, serviceDate: "2026-10-03" };
const deltaKey = "leg:v1:DAL4820|2026-10-03|MDW|MSP", endeavorKey = "leg:v1:EDV4820|2026-10-03|MDW|MSP";
const deltaDeparture = { push: { unix: 1791053460, source: "provider_actual", live: true, at: 1791053460 }, taxiOut: { at: 1791054380 } };
const deltaArrival = { ...arrival, startedAt: 1791054460000, lastFixAt: 1791054460000, points: [{ lat: 44.88, lon: -93.22 }] };

test("FR24-only EDV/DAL alternation keeps one writable fallback row across cold stores and folds old alias state", async () => {
  const db = await database(), nowSec = 1791054460;
  const fallback = "leg:unvalidated:DAL4820|MDW|MSP|2026-10-03";
  const oldAlias = "leg:unvalidated:EDV4820|MDW|MSP|2026-10-03";
  try {
    await db.phase().save(oldAlias, deltaDeparture, 0); await db.arrival().save(oldAlias, deltaArrival, 0);
    for (const ident of ["EDV4820", "DAL4820", "EDV4820"]) {
      const id = flightStateIdentity({ ident, operatingIdent: ident, iataIdent: "DL4820", originIata: "MDW", destIata: "MSP" }, deltaContext, { nowSec });
      assert.equal(id.key, fallback); assert.equal(id.canonicalKey, null); assert.equal(id.canPersist, true);
      const phase = await db.phase().load(id.key!, id.legacyKeys), ar = await db.arrival().load(id.key!, id.legacyKeys);
      assert.deepEqual(phase.state, deltaDeparture); assert.deepEqual(ar.state, deltaArrival);
      await db.phase().save(id.key!, phase.state, phase.version); await db.arrival().save(id.key!, ar.state, ar.version);
    }
    for (const table of ["flight_phase_state", "arrival_projection_state"]) {
      const rows = (await db.pg.query<{ land_key: string; version: number }>(`select land_key, version from ${table}`)).rows;
      assert.deepEqual(rows.map(r => r.land_key).sort(), [oldAlias, fallback].sort());
      assert.equal(rows.find(r => r.land_key === oldAlias)!.version, 1, "old alias remains untouched; new polls write only requested fallback");
    }
  } finally { await db.pg.close(); }
});

test("EDV/DAL alternation keeps push/taxi/takeoff and arrival in one requested row across cold stores and late alias updates", async () => {
  const db = await database(), realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error("Alias folding must not request providers"); };
  try {
    const initial = { ...deltaDeparture, taxiOut: null };
    await db.phase().save(endeavorKey, initial, 0); await db.arrival().save(endeavorKey, deltaArrival, 0);
    const id = flightStateIdentity(deltaSchedule, deltaContext);
    assert.equal(id.key, deltaKey);
    assert.deepEqual((await db.phase().load(id.key!, id.legacyKeys)).state, initial);
    assert.deepEqual((await db.arrival().load(id.key!, id.legacyKeys)).state, deltaArrival);

    // An old deployed instance can still update the alias after our row exists.
    const confirmed = { ...deltaDeparture, confirmedTakeoff: { time: null, source: "observed_airborne" as const, confirmedAt: 1791054450 } };
    const newerArrival = { ...deltaArrival, lastFixAt: deltaArrival.lastFixAt + 1000 };
    await db.phase().save(endeavorKey, confirmed, 1); await db.arrival().save(endeavorKey, newerArrival, 1);
    for (const ident of ["EDV4820", "DAL4820", "EDV4820"]) {
      const current = flightStateIdentity({ ...deltaSchedule, ident, iataIdent: ident === "DAL4820" ? "DL4820" : "9E4820" }, deltaContext);
      assert.equal(current.key, deltaKey);
      const phase = await db.phase().load(current.key!, current.legacyKeys);
      const ar = await db.arrival().load(current.key!, current.legacyKeys);
      assert.deepEqual(phase.state, confirmed); assert.deepEqual(ar.state, newerArrival);
      await db.phase().save(current.key!, phase.state, phase.version);
      await db.arrival().save(current.key!, ar.state, ar.version);
    }
    for (const table of ["flight_phase_state", "arrival_projection_state"]) {
      const rows = (await db.pg.query<{ land_key: string; version: number }>(`select land_key, version from ${table}`)).rows;
      assert.deepEqual(rows.map(r => r.land_key).sort(), [endeavorKey, deltaKey].sort());
      assert.equal(rows.find(r => r.land_key === endeavorKey)!.version, 2, "alias row is neither deleted nor rewritten by folding");
    }
  } finally { globalThis.fetch = realFetch; await db.pg.close(); }
});

test("validated alias folds isolate dates/routes and preserve CAS winners under concurrent cold loads", async () => {
  const db = await database();
  try {
    const confirmed = { ...deltaDeparture, confirmedTakeoff: { time: 1791054450, source: "provider_actual" as const, confirmedAt: 1791054451 } };
    await db.phase().save(endeavorKey, confirmed, 0); await db.arrival().save(endeavorKey, deltaArrival, 0);
    for (const [record, route] of [
      [{ ...deltaSchedule, gateOut: { scheduled: 1791054000 + 86400 }, serviceDate: "2026-10-04" }, deltaContext],
      [{ ...deltaSchedule, destIata: "BWI" }, { ...deltaContext, destination: { iata: "BWI" } }],
    ] as const) {
      const id = flightStateIdentity(record, route);
      assert(!id.legacyKeys.includes(endeavorKey));
      assert.deepEqual((await db.phase().load(id.key!, id.legacyKeys)).state, { push: null, taxiOut: null });
      assert.equal((await db.arrival().load(id.key!, id.legacyKeys)).state.active, false);
    }
    const id = flightStateIdentity(deltaSchedule, deltaContext), phaseStores = [db.phase(), db.phase()], arrivalStores = [db.arrival(), db.arrival()];
    const [phases, arrivals] = await Promise.all([
      Promise.all(phaseStores.map(store => store.load(id.key!, id.legacyKeys))),
      Promise.all(arrivalStores.map(store => store.load(id.key!, id.legacyKeys))),
    ]);
    assert(phases.every(p => p.status === "ok")); assert(arrivals.every(a => a.status === "ok"));
    const current = await db.phase().load(deltaKey), winner = { ...confirmed, taxiOut: { at: 1791054490 } };
    await phaseStores[0].save(deltaKey, winner, current.version);
    assert.equal(await phaseStores[1].save(deltaKey, { push: null, taxiOut: null }, current.version), "conflict_resolved");
    assert.deepEqual((await db.phase().load(deltaKey)).state, winner);
    const ar = await db.arrival().load(deltaKey), pathWinner = { ...deltaArrival, side: 1, lastFixAt: deltaArrival.lastFixAt + 2000 };
    await arrivalStores[0].save(deltaKey, pathWinner, ar.version);
    assert.equal((await arrivalStores[1].save(deltaKey, deltaArrival, ar.version)).status, "conflict_held");
    assert.deepEqual((await db.arrival().load(deltaKey, id.legacyKeys)).state, pathWinner);
  } finally { await db.pg.close(); }
});

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


test("schedule-less push/taxi and arrival survive midnight in cold stores, only from a recent same-route row", async () => {
  const db = await database();
  try {
    const record = { ...schedule, flightId: null, gateOut: {}, takeoff: {} };
    const before = flightStateIdentity(record, context, { nowSec: Date.parse("2026-10-02T23:59:00Z") / 1000 });
    const after = flightStateIdentity(record, context, { nowSec: Date.parse("2026-10-03T00:01:00Z") / 1000 });
    assert.notEqual(before.key, after.key); assert.deepEqual(after.recentLegacyKeys, [before.key]);
    await db.phase().save(before.key!, departure, 0); await db.arrival().save(before.key!, arrival, 0);
    assert.deepEqual((await db.phase().load(after.key!, after.legacyKeys, after.recentLegacyKeys)).state, departure);
    assert.deepEqual((await db.arrival().load(after.key!, after.legacyKeys, after.recentLegacyKeys)).state, arrival);
    // No previous-day lookup when any departure clock or a device-only scope exists.
    assert.deepEqual(flightStateIdentity({ ...record, gateOut: { actual: 1790955180 } }, context).recentLegacyKeys, []);
    assert.deepEqual(flightStateIdentity(record, context, { deviceOnly: true }).recentLegacyKeys, []);
    const other = flightStateIdentity(record, { ...context, destination: { iata: "LAX" } }, { nowSec: Date.parse("2026-10-03T00:01:00Z") / 1000 });
    assert.deepEqual((await db.phase().load(other.key!, other.legacyKeys, other.recentLegacyKeys)).state, { push: null, taxiOut: null });
    // An older flight cannot be inherited on a later day.
    for (const table of ["flight_phase_state", "arrival_projection_state"])
      await db.pg.query(`update ${table} set updated_at = now() - interval '19 hours'`);
    const next = flightStateIdentity(record, context, { nowSec: Date.parse("2026-10-04T00:01:00Z") / 1000 });
    assert.deepEqual((await db.phase().load(next.key!, next.legacyKeys, next.recentLegacyKeys)).state, { push: null, taxiOut: null });
    assert.equal((await db.arrival().load(next.key!, next.legacyKeys, next.recentLegacyKeys)).state.active, false);
  } finally { await db.pg.close(); }
});


test("confirmed takeoff survives concurrent stale CAS writes and same-version omissions", async () => {
  const db = await database();
  try {
    const observed = { time: null, source: "observed_airborne" as const, confirmedAt: 1790957521 };
    const actual = { time: 1790957520, source: "provider_actual" as const, confirmedAt: 1790957530 };
    const stale = await db.phase().load(key);
    assert.equal(await db.phase().save(key, { ...departure, confirmedTakeoff: observed }, 0), "ok");
    assert.equal(await db.phase().save(key, { ...departure, confirmedTakeoff: actual }, stale.version), "conflict_resolved");
    const current = await db.phase().load(key);
    assert.deepEqual(current.state.confirmedTakeoff, { ...actual, confirmedAt: observed.confirmedAt, observedAt: observed.confirmedAt });
    await db.phase().save(key, { push: null, taxiOut: null }, current.version);
    await db.phase().save(key, departure, 0);
    assert.deepEqual((await db.phase().load(key)).state.confirmedTakeoff, current.state.confirmedTakeoff);
    const status = await Promise.all([db.phase().save(key, departure, 0), db.phase().save(key, { ...departure, confirmedTakeoff: observed }, 0)]);
    assert(status.every(x => ["conflict_resolved", "conflict_dropped"].includes(x)));
    assert.deepEqual((await db.phase().load(key)).state.confirmedTakeoff, current.state.confirmedTakeoff);
  } finally { await db.pg.close(); }
});


test("confirmed takeoff never crosses a scheduled service day or route", async () => {
  const db = await database();
  try {
    const confirmedTakeoff = { source: "provider_actual" as const, time: 1790957520, confirmedAt: 1790957521 };
    await db.phase().save(key, { ...departure, confirmedTakeoff }, 0);
    for (const [record, ctx] of [[{ ...schedule, gateOut: { scheduled: 1790952900 + 86400 } }, context],
      [{ ...schedule, destIata: "LAX" }, { ...context, destination: { iata: "LAX" } }]] as const) {
      const id = flightStateIdentity(record, ctx);
      assert.equal((await db.phase().load(id.key!, id.legacyKeys, id.recentLegacyKeys)).state.confirmedTakeoff, undefined);
    }
  } finally { await db.pg.close(); }
});

test("early provider revocation survives stale CAS, omissions and legacy folds; observed races remain permanent", async () => {
  const db = await database();
  try {
    const provider = { time: 1790957520, source: "provider_actual" as const, confirmedAt: 1790957530 };
    const rejected = { ...provider, revocations: [{ time: provider.time, at: 1790957600 }] };
    await db.phase().save(key, { ...departure, confirmedTakeoff: provider }, 0);
    const stale = await db.phase().load(key);
    await db.phase().save(key, { ...departure, confirmedTakeoff: rejected }, stale.version);
    assert.equal(await db.phase().save(key, { ...departure, confirmedTakeoff: provider }, stale.version), "conflict_resolved");
    let loaded = await db.phase().load(key);
    assert.equal(activeConfirmedTakeoff(loaded.state.confirmedTakeoff), undefined);
    await db.phase().save(key, departure, loaded.version);
    const fallback = unvalidatedLegKey(schedule, context)!;
    await db.phase().save(fallback, { ...departure, confirmedTakeoff: provider }, 0);
    loaded = await db.phase().load(key, [fallback]);
    assert.equal(activeConfirmedTakeoff(loaded.state.confirmedTakeoff), undefined);
    assert.equal(loaded.state.confirmedTakeoff?.revocations?.[0].time, provider.time);
    const observed = { time: null, source: "observed_airborne" as const, confirmedAt: 1790957610 };
    await db.phase().save(key, { ...departure, confirmedTakeoff: observed }, stale.version);
    loaded = await db.phase().load(key);
    assert.equal(activeConfirmedTakeoff(loaded.state.confirmedTakeoff)?.source, "observed_airborne");
    await db.phase().save(key, { ...departure, confirmedTakeoff: rejected }, 0);
    assert.equal(activeConfirmedTakeoff((await db.phase().load(key)).state.confirmedTakeoff)?.source, "observed_airborne");
  } finally { await db.pg.close(); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalLegKey, canonicalLegIdentity, legacyLegKeys, flightStateIdentity, unvalidatedLegKey, departureSeedUnix, type LegSchedule } from "./flight-identity.ts";

const schedule: LegSchedule = { ident: "UAL219", iataIdent: "UA219", flightId: "UAL219-1790952900-schedule-0001",
  originIata: "ORD", originIcao: "KORD", destIata: "HNL", destIcao: "PHNL",
  gateOut: { scheduled: 1790952900 }, _publicScheduleDate: "2026-10-02" };
const context = { requested: "UA219", origin: { iata: "ORD" }, destination: { iata: "HNL" } };
const key = (over: Partial<LegSchedule> = {}) => canonicalLegKey({ ...schedule, ...over }, context);

test("provider-ID -> dated fallback -> provider-ID uses the same canonical IATA leg key", () => {
  assert.equal(key(), "leg:v1:UAL219|2026-10-02|ORD|HNL");
  assert.equal(key({ flightId: null }), key());
  assert.equal(key({ flightId: "opaque-fr24-id" }), key());
  assert.equal(key({ ident: "UA219", flightId: null }), key());
});
test("next day's same flight number has a different key", () => {
  assert.notEqual(key({ gateOut: { scheduled: 1790952900 + 86400 }, _publicScheduleDate: "2026-10-03" }), key());
});
test("different routes have different keys", () => {
  assert.notEqual(canonicalLegKey({ ...schedule, destIata: "LAX", destIcao: "KLAX" },
    { ...context, destination: { iata: "LAX" } }), key());
});
test("scheduled departure date uses origin local time, not UTC or delayed actual time", () => {
  const midnightUtc = Date.parse("2026-10-03T04:45:00Z") / 1000;
  assert.equal(key({ gateOut: { scheduled: midnightUtc } }), key());
});
test("reject mismatched service date/route and missing scheduled departure", () => {
  assert.equal(key({ _publicScheduleDate: "2026-10-03" }), null);
  assert.equal(key({ destIcao: "KLAX" }), null);
  assert.equal(key({ gateOut: {}, takeoff: {} }), null);
});
test("requested carrier and normalized number select the key, regardless of provider carrier", () => {
  assert.equal(key({ operatingIdent: "SKW5219" }), key());
  assert.equal(key({ ident: "UAL0219" }), key());
  assert.equal(canonicalLegKey(schedule, { ...context, requested: "UA0219" }), key());
});
test("DL4820 uses DAL across EDV/DAL provider alternation and only folds validated same-leg aliases", () => {
  const route = { requested: "DL4820", origin: { iata: "MDW" }, destination: { iata: "MSP" } };
  const flight = { originIata: "MDW", destIata: "MSP", gateOut: { scheduled: 1791054000 }, serviceDate: "2026-10-03" };
  const canonical = "leg:v1:DAL4820|2026-10-03|MDW|MSP";
  for (const ident of ["EDV4820", "DAL4820", "9E4820"]) {
    const record = { ...flight, ident, operatingIdent: ident, iataIdent: "DL4820" };
    assert.equal(canonicalLegKey(record, route), canonical);
    const aliases = legacyLegKeys(record, route);
    if (ident !== "DAL4820") assert(aliases.includes("leg:v1:EDV4820|2026-10-03|MDW|MSP"));
    assert(!aliases.includes(canonical));
    assert(!aliases.includes("leg:v1:EDV4820|2026-10-04|MDW|MSP"));
    assert(!aliases.includes("leg:v1:EDV4820|2026-10-03|MDW|BWI"));
    assert.deepEqual(legacyLegKeys({ ...record, serviceDate: "2026-10-04" }, route), []);
    assert.deepEqual(legacyLegKeys({ ...record, destIata: "BWI" }, route), []);
  }
  assert.equal(canonicalLegKey({ ...flight, ident: "EDV4820" }, { ...route, requested: "9E4820" }),
    "leg:v1:EDV4820|2026-10-03|MDW|MSP", "separate searches may keep separate rows");
});
test("provider aliases use the validated origin-local day, including a UTC date boundary", () => {
  const record = { ...schedule, operatingIdent: "SKW5219", gateOut: { scheduled: Date.parse("2026-10-03T04:45:00Z") / 1000 },
    flightId: `SKW5219-${Date.parse("2026-10-03T04:45:00Z") / 1000}-schedule-1` };
  const aliases = legacyLegKeys(record, context);
  assert(aliases.includes("leg:v1:SKW5219|2026-10-02|ORD|HNL"));
  assert(!aliases.includes("leg:v1:SKW5219|2026-10-03|ORD|HNL"));
  assert(aliases.includes(`${record.flightId}|ORD|HNL`));
  assert(!legacyLegKeys({ ...record, gateOut: { scheduled: record.gateOut.scheduled + 86400 },
    _publicScheduleDate: "2026-10-03" }, context).includes(`${record.flightId}|ORD|HNL`));
});
test("already resolved provider airports outside the local catalog retain durable identity", () => {
  assert.equal(canonicalLegKey({ ...schedule, destIata: "MSY", destIcao: "KMSY" },
    { ...context, destination: { iata: "MSY", icao: "KMSY" } }), "leg:v1:UAL219|2026-10-02|ORD|MSY");
  assert.equal(canonicalLegKey({ ...schedule, destIata: "MSY", destIcao: "KMSY" },
    { ...context, destination: { iata: "MSY", icao: "KXXX" } }), null);
});
test("each unavailable canonical key logs its specific reason and selects separate durable fallback", t => {
  const logs: Array<{ event: string; reason: string }> = [];
  t.mock.method(console, "warn", (value: string) => logs.push(JSON.parse(value)));
  const cases = [
    [{ ...schedule, gateOut: {}, takeoff: {} }, context, "missing_scheduled"],
    [{ ...schedule, destIcao: "KLAX" }, context, "route_mismatch"],
    [{ ...schedule, _publicScheduleDate: "2026-10-03" }, context, "service_date_mismatch"],
    [{ ...schedule, ident: "N12345", iataIdent: null }, { ...context, requested: "N12345" }, "no_ident"],
  ] as const;
  for (const [record, route, reason] of cases) {
    const selected = flightStateIdentity(record, route, { nowSec: 1790952900 });
    assert.equal(selected.canonicalKey, null); assert.equal(selected.reason, reason);
    assert.equal(selected.canPersist, true); assert.match(selected.key!, /^leg:unvalidated:/);
    assert.equal(logs.at(-1)!.reason, reason); assert.equal(logs.at(-1)!.event, "canonical_leg_key_unavailable");
  }
  assert.equal(logs.length, 4);
});
test("unvalidated key preserves origKey's scheduled/estimated/actual/now UTC date source", () => {
  const noSchedule = { ...schedule, gateOut: {}, takeoff: {} };
  assert.equal(unvalidatedLegKey(noSchedule, context, 1790952900), "leg:unvalidated:UAL219|ORD|HNL|2026-10-02");
  assert.equal(departureSeedUnix({ scheduled: 1000, estimated: 1100, actual: 2000 }), 1000);
  assert.equal(departureSeedUnix({ scheduled: 1000, estimated: 40000, actual: 41000 }), 40000);
  assert.equal(departureSeedUnix({ estimated: 40000, actual: 41000 }), 40000);
  assert.equal(departureSeedUnix({ actual: 41000 }), 41000);
  assert.notEqual(unvalidatedLegKey(noSchedule, context, 1790952900 + 86400), unvalidatedLegKey(noSchedule, context, 1790952900));
});
test("schedule-less identity prefers the request and folds only same-day/route provider fallback aliases", () => {
  const route = { requested: "DL4820", origin: { iata: "MDW" }, destination: { iata: "MSP" } };
  const record = { ident: "EDV4820", operatingIdent: "EDV4820", iataIdent: "DL4820" };
  const identity = flightStateIdentity(record, route, { nowSec: 1791054000 });
  assert.equal(identity.key, "leg:unvalidated:DAL4820|MDW|MSP|2026-10-03");
  assert(identity.legacyKeys.includes("leg:unvalidated:EDV4820|MDW|MSP|2026-10-03"));
  assert(!identity.legacyKeys.includes("leg:unvalidated:EDV4820|MDW|MSP|2026-10-04"));
  assert(!identity.legacyKeys.includes("leg:unvalidated:EDV4820|MDW|BWI|2026-10-03"));
  assert.equal(unvalidatedLegKey(record, { ...route, requested: "unparseable request" }, 1791054000),
    "leg:unvalidated:EDV4820|MDW|MSP|2026-10-03");
});
test("device-only fallback and canonical resumes never write or carry legacy into shared rows", () => {
  for (const record of [schedule, { ...schedule, gateOut: {}, takeoff: {} }]) {
    const selected = flightStateIdentity(record, context, { deviceOnly: true, nowSec: 1790952900 });
    assert.equal(selected.canPersist, false); assert.deepEqual(selected.legacyKeys, []);
  }
});

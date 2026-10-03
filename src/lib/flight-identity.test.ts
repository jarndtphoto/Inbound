import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalLegKey, canonicalLegIdentity, flightStateIdentity, unvalidatedLegKey, departureSeedUnix, type LegSchedule } from "./flight-identity.ts";

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
test("operating carrier and normalized number select the key", () => {
  assert.match(key({ operatingIdent: "SKW5219" })!, /^leg:v1:SKW5219\|/);
  assert.equal(key({ ident: "UAL0219" }), key());
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
test("device-only fallback and canonical resumes never write or carry legacy into shared rows", () => {
  for (const record of [schedule, { ...schedule, gateOut: {}, takeoff: {} }]) {
    const selected = flightStateIdentity(record, context, { deviceOnly: true, nowSec: 1790952900 });
    assert.equal(selected.canPersist, false); assert.deepEqual(selected.legacyKeys, []);
  }
});

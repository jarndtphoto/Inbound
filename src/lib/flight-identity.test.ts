import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalLegKey, type LegSchedule } from "./flight-identity.ts";

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

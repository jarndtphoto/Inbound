import { test } from "node:test";
import assert from "node:assert/strict";
import { operationalDepartureUnix, storyLegDate } from "./flight-story-date.ts";
import { flightDepartureDate, airlineStatusLink } from "./airline-status.ts";
import { journeyKey, journeyChanges } from "./traveler.ts";
import type { FlightStory } from "./types.ts";

const scheduled = Date.parse("2026-10-03T04:30:00Z") / 1000; // Oct 2 in Chicago.
const stamp = (s: number | null, e: number | null = null, a: number | null = null) => ({ scheduled: s, estimated: e, actual: a });
function story(extra: Partial<FlightStory> = {}): FlightStory {
  return { callsign: "UAL219", iata: "UA219", fetchedAt: (scheduled + 3600) * 1000, currentStage: "taxi",
    origin: { iata: "ORD", icao: "KORD", tz: "America/Chicago" }, dest: { iata: "HNL", icao: "PHNL" },
    times: { origPushUnix: scheduled, origTakeoffUnix: scheduled + 900,
      pushUnix: scheduled + 600, pushKind: "estimated", takeoffUnix: scheduled + 1500, takeoffKind: "estimated" },
    resume: { gateOut: stamp(scheduled, scheduled + 600), takeoff: stamp(scheduled + 900, scheduled + 1500) },
    ...extra } as FlightStory;
}
const clearOriginals = (s: FlightStory): FlightStory => ({ ...s, times: { ...s.times, origPushUnix: null, origTakeoffUnix: null, origLandUnix: null } });

test("origin-local canonical day keeps baggage, airline and history identities stable when originals are cleared", () => {
  for (const stateKey of [undefined, "leg:v1:UAL219|2026-10-02|ORD|HNL", "leg:unvalidated:UAL219|ORD|HNL|2026-10-03"]) {
    const before = story({ stateKey }), after = clearOriginals(before);
    assert.equal(flightDepartureDate(before), "2026-10-02");
    assert.equal(flightDepartureDate(after), flightDepartureDate(before));
    assert.deepEqual(airlineStatusLink(after), airlineStatusLink(before));
    assert.equal(journeyKey(after), journeyKey(before));
    assert.equal(storyLegDate(after), stateKey?.startsWith("leg:v1:") ? "2026-10-02" : "2026-10-03");
  }
});

test("eight-hour slip retains the operational fallback rule independent of original schedule memory", () => {
  const before = story();
  before.resume!.gateOut = stamp(scheduled, scheduled + 9 * 3600, scheduled + 10 * 3600);
  assert.equal(operationalDepartureUnix(before), scheduled + 9 * 3600);
  assert.equal(operationalDepartureUnix(clearOriginals(before)), scheduled + 9 * 3600);
  assert.equal(flightDepartureDate(before), "2026-10-03");
  assert.equal(flightDepartureDate(clearOriginals(before)), "2026-10-03");
  const canonical = { ...before, stateKey: "leg:v1:UAL219|2026-10-02|ORD|HNL" };
  assert.equal(flightDepartureDate(canonical), "2026-10-02", "validated service date wins over slipped clocks");
});

test("legacy posted clocks and validated dates work without original fields; wrong-route keys cannot choose a date", () => {
  const base = story({ resume: undefined });
  assert.equal(operationalDepartureUnix(clearOriginals(base)), base.times.pushUnix);
  assert.equal(flightDepartureDate({ ...base, stateKey: "leg:v1:UAL219|2026-10-05|ORD|LAX" }), "2026-10-02");
  const empty = { ...base, times: {}, stateKey: undefined } as FlightStory;
  assert.equal(flightDepartureDate(empty), null, "no invented airline date");
});

test("same flight tomorrow and a different route have separate history identities", () => {
  const base = story({ stateKey: "leg:v1:UAL219|2026-10-02|ORD|HNL" });
  const tomorrow = story({ stateKey: "leg:v1:UAL219|2026-10-03|ORD|HNL" });
  const route = story({ stateKey: "leg:v1:UAL219|2026-10-02|ORD|LAX", dest: { iata: "LAX", icao: "KLAX" } as FlightStory["dest"] });
  assert.notEqual(journeyKey(base), journeyKey(tomorrow));
  assert.notEqual(journeyKey(base), journeyKey(route));
});

test("canonical state identity matches diversion alerts through provider-ID handoff with null originals", () => {
  const base = clearOriginals(story({ stateKey: "leg:v1:UAL219|2026-10-02|ORD|HNL", flightId: "provider-one" }));
  const next = { ...base, fetchedAt: base.fetchedAt + 1000, flightId: "provider-two",
    diversion: { source: "flightaware", reportedAt: base.fetchedAt, originalDestination: "HNL", destination: "LAX" } } as FlightStory;
  assert.equal(journeyChanges(base, next)[0].kind, "diversion");
  for (const stateKey of ["leg:v1:UAL219|2026-10-03|ORD|HNL", "leg:v1:UAL219|2026-10-02|ORD|LAX"]) {
    assert.deepEqual(journeyChanges(base, { ...next, stateKey }), []);
  }
});

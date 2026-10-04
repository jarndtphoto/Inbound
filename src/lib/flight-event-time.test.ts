import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatAirportEventTime, formatStoryEventTime } from "./flight-event-time.ts";
import { formatClockTime } from "./presentation-time.ts";
import type { FlightStory } from "./types.ts";

const leg = {
  stateKey: "leg:v1:UAL203|2026-10-03|OGG|ORD",
  origin: { iata: "OGG", icao: "PHOG", tz: "Pacific/Honolulu" },
  dest: { iata: "ORD", icao: "KORD", tz: "America/Chicago" },
} as FlightStory;

describe("airport-local flight event clocks", () => {
  it("shows an OGG/HNL departure in HST without a same-day marker", () => {
    const departure = Date.UTC(2026, 9, 4, 2, 16) / 1000;
    assert.equal(formatStoryEventTime(leg, departure, leg.origin.tz), "4:16 PM HST");
  });

  it("shows an ORD arrival in CDT with a next-day marker", () => {
    const arrival = Date.UTC(2026, 9, 4, 9, 27) / 1000;
    assert.equal(formatStoryEventTime(leg, arrival, leg.dest.tz), "4:27 AM CDT +1");
    assert.equal(formatAirportEventTime(arrival, "America/Chicago", "2026-10-03"), "4:27 AM CDT +1");
  });

  it("keeps freshness clocks in the viewer's own time zone", () => {
    const before = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const arrivalMs = Date.UTC(2026, 9, 4, 9, 27);
      assert.equal(formatClockTime(arrivalMs), "9:27 AM UTC");
      assert.equal(formatStoryEventTime(leg, arrivalMs / 1000, leg.dest.tz), "4:27 AM CDT +1");
    } finally {
      if (before == null) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });
});

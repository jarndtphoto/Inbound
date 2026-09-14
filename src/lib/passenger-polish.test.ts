import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { FlightStory } from "./types.ts";
import { passengerNextEvent } from "./next-event.ts";
import { passengerAirportWeather } from "./passenger-airport-weather.ts";
import { destinationGateTime } from "./passenger-time.ts";

function story(stage: FlightStory["currentStage"], over: Partial<FlightStory> = {}): FlightStory {
  return {
    currentStage: stage,
    dest: { city: "Chicago" },
    times: { landKind: null, gateKind: null, land: "2:15 PM CDT" },
    aircraft: { onGround: false },
    ...over,
  } as FlightStory;
}

describe("passenger next-event lifecycle", () => {
  it("never sends final approach back to a departure event", () => {
    const result = passengerNextEvent(story("final_approach", {
      times: { pushed: true, airborne: true, push: "11:42 AM", takeoff: "12:04 PM", land: "2:15 PM CDT", landKind: "estimated", gateKind: "estimated" } as FlightStory["times"],
    }));
    assert.equal(result.title, "Landing is next");
    assert.doesNotMatch(`${result.title} ${result.body}`, /pushback|taxiing out|takeoff/i);
  });

  it("follows arrival stages monotonically", () => {
    assert.equal(passengerNextEvent(story("arrival")).title, "Final approach is next");
    assert.equal(passengerNextEvent(story("final_approach")).title, "Landing is next");
    assert.equal(passengerNextEvent(story("arrival", { aircraft: { onGround: true } as FlightStory["aircraft"] })).title, "Taxiing in is next");
    assert.equal(passengerNextEvent(story("taxi_in")).title, "At the gate is next");
  });
});

describe("passenger airport presentation", () => {
  const decoded = (over: Record<string, unknown> = {}) => ({
    category: "VFR", categoryLabel: "Good visibility and higher cloud ceilings", wind: "Calm",
    vis: "Clear visibility, 10 miles or more", ceiling: "No solid ceiling", temp: "20°C / 68°F",
    wx: "No significant weather reported", summary: "Good visibility.", ...over,
  }) as never;

  it("uses observations rather than publishing flight categories", () => {
    assert.equal(passengerAirportWeather(decoded(), "KORD 121651Z 25005KT 10SM SCT050"), "Partly cloudy");
    assert.equal(passengerAirportWeather(decoded(), "KORD 121651Z 25005KT 10SM BKN050"), "Cloudy");
    assert.equal(passengerAirportWeather(decoded({ wx: "-RA" }), "KORD 121651Z 10SM -RA BKN050"), "Rain");
    assert.doesNotMatch(passengerAirportWeather(decoded(), "KORD 121651Z 10SM SCT050"), /VFR|IFR/);
  });

  it("formats the UA219 gate event in Honolulu time, not the current wall clock", () => {
    const unix = Date.UTC(2026, 6, 1, 0, 19) / 1000;
    const value = destinationGateTime(unix, "fallback", "Pacific/Honolulu");
    assert.equal(value, "2:19 PM HST");
  });
});

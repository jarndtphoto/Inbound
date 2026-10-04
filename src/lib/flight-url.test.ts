import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FLIGHT_TABS, flightHref, parseFlightLocation, storyMatchesFlightLink } from "./flight-url.ts";

describe("flight URL state", () => {
  it("restores the requested flight and every tab from a reload URL", () => {
    const slugs = ["overview", "map", "weather", "briefing"];
    for (const [index, tab] of FLIGHT_TABS.entries()) {
      assert.deepEqual(parseFlightLocation(`/?flight=UA203&tab=${slugs[index]}&date=2026-10-03`), {
        kind: "flight", flight: "UA203", tab, date: "2026-10-03",
      });
      assert.equal(flightHref("UA 203", tab, "2026-10-03"), `/?flight=UA203&tab=${slugs[index]}&date=2026-10-03`);
    }
  });

  it("keeps landing URLs inert and rejects invalid flight or date links", () => {
    assert.deepEqual(parseFlightLocation("/"), { kind: "landing" });
    assert.deepEqual(parseFlightLocation("/?flight=not-a-flight&tab=map"), {
      kind: "invalid", flight: "NOT-A-FLIGHT", reason: "invalid_flight",
    });
    assert.deepEqual(parseFlightLocation("/?flight=UA203&date=2026-02-30"), {
      kind: "invalid", flight: "UA203", reason: "invalid_date",
    });
  });

  it("defaults unknown tabs to Overview without changing the flight", () => {
    assert.deepEqual(parseFlightLocation("/?flight=UAL203&tab=unknown"), {
      kind: "flight", flight: "UA203", tab: "Overview", date: null,
    });
  });

  it("rejects a different flight or service date before an old link can display it", () => {
    const story = { callsign: "UAL203", iata: "UA203", stateKey: "leg:v1:UAL203|2026-10-04|OGG|ORD",
      origin: { iata: "OGG", tz: "Pacific/Honolulu" }, dest: { iata: "ORD" } } as never;
    assert.equal(storyMatchesFlightLink(story, "UA203", "2026-10-04"), true);
    assert.equal(storyMatchesFlightLink(story, "UA203", "2026-10-03"), false);
    assert.equal(storyMatchesFlightLink(story, "UA204", "2026-10-04"), false);
  });
});

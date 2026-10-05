import { test } from "node:test";
import assert from "node:assert/strict";
import { groundCoverageNotice } from "./ground-coverage.ts";

test("shows the limited-ground disclaimer only for MCO, TPA and PHX departures without a reliable live fix", () => {
  for (const airportIata of ["MCO", "TPA", "PHX"]) {
    const notice = groundCoverageNotice({
      kind: "departure",
      airportIata,
      hasReliableLiveGroundPosition: false,
    });
    assert.equal(notice?.headline, `Ground tracking may be limited at ${airportIata}.`);
    assert.equal(notice?.detail, "Position and taxi-stage updates can lag until the aircraft is airborne.");
  }
});

test("does not show the disclaimer for arrivals, other airports, or a reliable live ground fix", () => {
  assert.equal(groundCoverageNotice({
    kind: "arrival", airportIata: "MCO", hasReliableLiveGroundPosition: false,
  }), null);
  assert.equal(groundCoverageNotice({
    kind: "departure", airportIata: "ORD", hasReliableLiveGroundPosition: false,
  }), null);
  assert.equal(groundCoverageNotice({
    kind: "departure", airportIata: "PHX", hasReliableLiveGroundPosition: true,
  }), null);
});

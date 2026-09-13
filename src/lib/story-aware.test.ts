import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { faAltFt, hasAirborneEvidence, liveFromAware, parseJsonObject, timeFracOf } from "./fa-track.ts";

describe("departure evidence", () => {
  it("does not mark UA1532 airborne while its takeoff is still in the future", () => {
    assert.equal(hasAirborneEvidence({status: "airborne", takeoff: {actual: null, estimated: 1789232580}}, 1789231976), false);
  });
  it("does not treat gate departure alone as takeoff", () => {
    const now = Date.now() / 1000;
    assert.equal(hasAirborneEvidence({status: "departed", takeoff: {estimated: now - 60}}, now), false);
    assert.equal(timeFracOf({status: "departed", gateOut: {actual: now - 300}}), 0);
    assert.equal(hasAirborneEvidence({status: "airborne", takeoff: {actual: now - 60}}, now), true);
  });
  it("keeps an old FlightAware fix at its observed location", () => {
    const now = Date.now() / 1000;
    const live = liveFromAware({faTrack: [{t: now - 120, lat: 41, lon: -87, alt: 30000, gs: 450, track: 90}]});
    assert.equal(live?.lat, 41);
    assert.equal(live?.lon, -87);
    assert.ok((live?.seenSec ?? 0) >= 120);
    assert.equal(liveFromAware({faTrack: [{lat: 41, lon: -87}]}), null);
    assert.equal(liveFromAware({faTrack: [{t: now, lat: NaN, lon: -87}]}), null);
  });
});

describe("FlightAware JSON", () => {
  it("parses an object even when a string contains braces", () => {
    const raw = '{"flights":{"SWA1":{"ident":"SWA1","note":"hello } { world"}},"x":1}; other({';
    const parsed = parseJsonObject(raw);
    assert.ok(parsed);
    const out = parsed as { flights: { SWA1: { ident: string } }; x: number };
    assert.equal(out.flights.SWA1.ident, "SWA1");
    assert.equal(out.x, 1);
  });
});

describe("FA altitude", () => {
  it("treats FlightAware hundreds as feet", () => {
    assert.equal(faAltFt(90), 9000);
    assert.equal(faAltFt(8), 800);
    assert.equal(faAltFt(35000), 35000);
  });
});

describe("airborne without takeoff actual", () => {
  it("uses estimated takeoff once the flight is airborne", () => {
    const now = Date.now() / 1e3;
    const frac = timeFracOf({
      status: "airborne",
      takeoff: { actual: null, estimated: now - 10 * 60, scheduled: now - 8 * 60 },
      landing: { actual: null, estimated: now + 70 * 60, scheduled: now + 80 * 60 },
    });
    assert.ok(frac > 0.08 && frac < 0.25);
  });
});

describe("live from FA track", () => {
  it("uses the last track point when top-level coord is missing", () => {
    const now = Date.now() / 1e3;
    const live = liveFromAware({
      ident: "SWA3745",
      type: "B737",
      gsKt: 297,
      heading: 195,
      altFt: 9000,
      faTrack: [
        { t: now - 40, lat: 41.78, lon: -87.76, alt: 800, gs: 160, track: 180, ground: false },
        { t: now - 8, lat: 41.5673, lon: -87.8213, alt: 9000, gs: 297, track: 195, ground: false },
      ],
    });
    assert.ok(live);
    assert.ok(Math.abs(live.lat - 41.5673) < 0.02);
    assert.ok(Math.abs(live.lon - -87.8213) < 0.05);
    assert.equal(live.onGround, false);
    assert.equal(live.gsKt, 297);
    assert.equal(live.track, 195);
  });
});


describe("estimated takeoff is not observation", () => {
 it("keeps off-block flights on the ground when an airborne label precedes actual takeoff", () => {
   const now = Date.now() / 1000;
   assert.equal(hasAirborneEvidence({status:"airborne",takeoff:{estimated:now-120,scheduled:now-300}}, now), false);
   assert.equal(hasAirborneEvidence({status:"airborne",takeoff:{actual:now-20}}, now), true);
 });
});

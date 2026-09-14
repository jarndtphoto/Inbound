import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { choosePosition, finalApproachEtaMin, type NormalizedPosition } from "./flight-data.ts";
import { normalizeAeroApiFlight } from "./flightaware-aeroapi.server.ts";
import { normalizeFr24Position } from "./fr24.server.ts";

const pos = (provider: NormalizedPosition["provider"], lat: number, lon: number, age = 1): NormalizedPosition => ({
  provider, flightId: null, callsign: "AAL2668", lat, lon, altFt: 1000, gsKt: 140, track: 90, onGround: false,
  seenAt: 10_000 - age, registration: "N123AA", type: "B738", hex: "abc123", confidence: "high",
});

describe("official provider normalization", () => {
  it("normalizes FR24 live kinematics", () => {
    const p = normalizeFr24Position({ fr24_id: "f1", callsign: "AAL2668", lat: 32.9, lon: -97.0, alt: 800, gspeed: 145, track: 180, on_ground: false, timestamp: 10_000 });
    assert.equal(p?.provider, "fr24"); assert.equal(p?.altFt, 800); assert.equal(p?.gsKt, 145);
  });
  it("normalizes AeroAPI operational times and position", () => {
    const f = normalizeAeroApiFlight({ fa_flight_id: "AAL2668-1", ident: "AAL2668", last_position: { latitude: 32.9, longitude: -97, altitude: 8, groundspeed: 140, heading: 180, timestamp: "1970-01-01T02:46:40Z" }, scheduled_out: "2026-09-14T10:00:00Z", gate_destination: "C12" });
    assert.equal(f.position?.altFt, 800); assert.equal(f.destination, null); assert.ok(f.push.scheduled);
  });
});

describe("position confidence fusion", () => {
  it("uses consensus and rejects a spatial outlier", () => {
    const choice = choosePosition([pos("fr24", 32.9, -97), pos("adsb", 32.901, -97.001), pos("flightaware", 35, -90)], { callsigns: ["AA2668"] }, 10_000);
    assert.notEqual(choice.chosen?.provider, "flightaware"); assert.ok((choice.disagreementNm ?? 0) > 100);
  });
  it("falls back when providers are stale or absent", () => {
    const choice = choosePosition([pos("fr24", 32.9, -97, 90), pos("adsb", 32.9, -97, 2)], {}, 10_000);
    assert.equal(choice.chosen?.provider, "adsb");
  });
  it("protects sticky aircraft identity", () => {
    const wrong = { ...pos("fr24", 32.9, -97), registration: "N999ZZ", hex: "999999" };
    const right = pos("adsb", 32.901, -97.001);
    assert.equal(choosePosition([wrong, right], { registration: "N123AA", hex: "abc123" }, 10_000).chosen?.provider, "adsb");
  });
});

describe("AA2668 touchdown ETA regression", () => {
  it("collapses from live geometry despite a stale provider ETA", () => {
    const values = [[15, 160], [10, 150], [5, 140], [2, 120], [0.8, 90], [0.1, 25]].map(([nm, gs]) => finalApproachEtaMin(nm!, gs!));
    assert.deepEqual(values.map((v) => Math.round(v * 10) / 10), [5.6, 4, 2.1, 1, 0.5, 0]);
  });
});

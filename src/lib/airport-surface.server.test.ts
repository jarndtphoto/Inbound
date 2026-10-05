import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAirportSurfaceElements } from "./airport-surface.server.ts";

const square = (id: number, west: number, south: number, east: number, north: number, tags: Record<string, string>) => ({
  id,
  type: "way" as const,
  tags,
  geometry: [
    { lat: south, lon: west },
    { lat: south, lon: east },
    { lat: north, lon: east },
    { lat: north, lon: west },
    { lat: south, lon: west },
  ],
});

const line = (id: number, points: Array<{ lat: number; lon: number }>, tags: Record<string, string>) => ({
  id,
  type: "way" as const,
  tags,
  geometry: points,
});

test("airport surface keeps target aerodrome geometry and rejects a neighboring field", () => {
  const parsed = parseAirportSurfaceElements([
    square(1, -0.02, -0.02, 0.02, 0.02, { aeroway: "aerodrome", icao: "KSAN", iata: "SAN", name: "San Diego International Airport" }),
    square(2, 0.04, -0.02, 0.08, 0.02, { aeroway: "aerodrome", icao: "KNZY", name: "NAS North Island" }),
    line(10, [{ lat: 0, lon: -0.015 }, { lat: 0, lon: 0.015 }], { aeroway: "runway", ref: "09/27" }),
    line(11, [{ lat: 0, lon: 0.045 }, { lat: 0, lon: 0.075 }], { aeroway: "runway", ref: "18/36" }),
    line(12, [{ lat: 0.05, lon: 0.0 }, { lat: 0.055, lon: 0.0 }], { aeroway: "taxiway", ref: "A" }),
  ], "KSAN", 123, { lat: 0, lon: 0 });

  assert.equal(parsed.boundary?.length, 1);
  assert.deepEqual(parsed.features.map((feature) => feature.id), [10]);
  assert.equal(parsed.features[0]?.ref, "09/27");
});

test("airport surface can choose a matching aerodrome boundary even when another boundary also contains the field point", () => {
  const parsed = parseAirportSurfaceElements([
    square(1, -0.03, -0.03, 0.03, 0.03, { aeroway: "aerodrome", name: "Wrong Field" }),
    square(2, -0.02, -0.02, 0.02, 0.02, { aeroway: "aerodrome", ref: "LGA", name: "LaGuardia Airport" }),
    line(20, [{ lat: 0, lon: -0.01 }, { lat: 0, lon: 0.01 }], { aeroway: "runway" }),
  ], "KLGA", 123, { lat: 0, lon: 0 });

  assert.equal(parsed.boundary?.[0]?.[1]?.lon, 0.02);
  assert.equal(parsed.features.length, 1);
});

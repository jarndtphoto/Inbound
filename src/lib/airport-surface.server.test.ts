import { test } from "node:test";
import assert from "node:assert/strict";
import { boxedAirportSurfaceOverpassQuery, exactAirportSurfaceOverpassQuery, parseAirportSurfaceElements } from "./airport-surface.server.ts";

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


test("exact airport surface query targets the requested aerodrome before any broad box", () => {
  const query = exactAirportSurfaceOverpassQuery("KSAN", { lat: 32.7338, lon: -117.1933 });
  assert.match(query, /aeroway"="aerodrome"/);
  assert.match(query, /"icao"="KSAN"/);
  assert.match(query, /"iata"="SAN"/);
  assert.match(query, /map_to_area/);
  assert.match(query, /area\.airportArea/);
  assert.match(query, /natural"="coastline"/);
  assert.match(query, /natural"="water"/);
  assert.match(query, /water"~"\^\(lake\|lagoon\|reservoir\|bay\)\$"/);
  assert.match(query, /32\.658800/);
  assert.match(query, /out geom\(32\.658800/);
});

test("boxed airport surface query remains available as a bounded fallback", () => {
  const query = boxedAirportSurfaceOverpassQuery({ lat: 32.7338, lon: -117.1933 });
  assert.match(query, /\[timeout:8\]/);
  assert.match(query, /32\.658800/);
  assert.match(query, /32\.808800/);
  assert.match(query, /aeroway"="aerodrome"/);
  assert.match(query, /natural"="coastline"/);
  assert.match(query, /natural"="water"/);
});

test("airport surface parses multipolygon inland water in the same payload", () => {
  const parsed = parseAirportSurfaceElements([
    square(1, -0.02, -0.02, 0.02, 0.02, { aeroway: "aerodrome", icao: "KORD" }),
    line(10, [{ lat: 0, lon: -0.015 }, { lat: 0, lon: 0.015 }], { aeroway: "runway", ref: "10R/28L" }),
    {
      id: 90,
      type: "relation" as const,
      tags: { natural: "water", water: "lake", name: "Lake Example" },
      members: [
        { type: "way" as const, role: "outer", ref: 901 },
        { type: "way" as const, role: "outer", ref: 902 },
      ],
    },
    line(901, [{ lat: 0.03, lon: 0.03 }, { lat: 0.03, lon: 0.05 }, { lat: 0.05, lon: 0.05 }], {}),
    line(902, [{ lat: 0.05, lon: 0.05 }, { lat: 0.05, lon: 0.03 }, { lat: 0.03, lon: 0.03 }], {}),
  ], "KORD", 123, { lat: 0, lon: 0 });

  assert.equal(parsed.hydrography?.fallback, false);
  assert.equal(parsed.hydrography?.ocean, false);
  assert.equal(parsed.hydrography?.waterPolygons, 1);
  assert.equal(parsed.hydrography?.water.length, 1);
});

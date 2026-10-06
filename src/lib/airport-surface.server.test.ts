import { test } from "node:test";
import assert from "node:assert/strict";
import { boxedAirportSurfaceOverpassQuery, exactAirportSurfaceOverpassQuery, fallbackAirportSurface, parseAirportSurfaceElements } from "./airport-surface.server.ts";
import { airportDetailGeographyBounds, airportGeographyIsWater, airportSurfaceBounds } from "./airport-coastline.ts";

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
  assert.match(query, /32\.283800/);
  assert.match(query, /out geom\(32\.283800/);
});

test("boxed airport surface query remains available as a bounded fallback", () => {
  const query = boxedAirportSurfaceOverpassQuery({ lat: 32.7338, lon: -117.1933 });
  assert.match(query, /\[timeout:8\]/);
  assert.match(query, /32\.658800/);
  assert.match(query, /32\.808800/);
  assert.match(query, /aeroway"="aerodrome"/);
  assert.match(query, /natural"="coastline"/);
  assert.match(query, /natural"="water"/);
  assert.match(query, /out geom\(32\.283800/);
});

test("complete provider failure still returns geography that fades the coarse coastline", () => {
  const surface = fallbackAirportSurface({ airport: "ksan", lat: 32.7338, lon: -117.1933 });
  assert.equal(surface.airport, "KSAN");
  assert.equal(surface.source, "fallback");
  assert.deepEqual(surface.features, []);
  assert.equal(surface.geography?.base, "land");
  assert.equal(surface.geography?.fallback, true);
  assert.equal(surface.geography?.fallbackReason, "airport-surface-unavailable");
  assert.deepEqual(surface.geography?.bounds, airportDetailGeographyBounds({ lat: 32.7338, lon: -117.1933 }));
});


test("surface parser includes same-response coastline and multipolygon inland water", () => {
  const parsed = parseAirportSurfaceElements([
    square(1, -0.03, -0.03, 0.03, 0.03, { aeroway: "aerodrome", icao: "KORD" }),
    line(2, [{ lat: 0, lon: -0.02 }, { lat: 0, lon: 0.02 }], { aeroway: "runway", ref: "10/28" }),
    line(20, [{ lat: -0.60, lon: 0.04 }, { lat: 0.60, lon: 0.04 }], { natural: "coastline" }),
    {
      id: 30,
      type: "relation" as const,
      tags: { natural: "water", water: "lake", type: "multipolygon" },
      members: [
        { type: "way" as const, role: "outer", geometry: [{ lat: -0.04, lon: 0.05 }, { lat: -0.04, lon: 0.07 }, { lat: 0.04, lon: 0.07 }] },
        { type: "way" as const, role: "outer", geometry: [{ lat: 0.04, lon: 0.07 }, { lat: 0.04, lon: 0.05 }, { lat: -0.04, lon: 0.05 }] },
      ],
    },
  ], "KORD", 123, { lat: 0, lon: 0 });

  assert.ok(parsed.geography);
  assert.equal(parsed.geography?.fallback, false);
  assert.equal(parsed.geography?.base, "water");
  assert.equal(parsed.geography?.water.length, 1);
});


test("ORD detailed geography reaches Lake Michigan while airport features stay tightly boxed", () => {
  const input = { lat: 41.9742, lon: -87.9073 };
  const detail = airportDetailGeographyBounds(input);
  const surface = airportSurfaceBounds(input);
  assert.ok(detail.east > -87.55, "detailed geography reaches the Lake Michigan shoreline");
  assert.ok(surface.east < -87.75, "airport feature box stays local to ORD");
  const exact = exactAirportSurfaceOverpassQuery("KORD", input);
  assert.ok(exact.includes(detail.east.toFixed(6)));
  assert.match(exact, /natural"="water"/);
});


test("open water ways are not promoted to polygons across the detail box", () => {
  const parsed = parseAirportSurfaceElements([
    square(101, -0.03, -0.03, 0.03, 0.03, { aeroway: "aerodrome", icao: "KDEN" }),
    line(102, [{ lat: 0, lon: -0.02 }, { lat: 0, lon: 0.02 }], { aeroway: "runway", ref: "17/35" }),
    line(103, [{ lat: -0.1, lon: 0.1 }, { lat: 0.1, lon: 0.1 }, { lat: 0.15, lon: 0.15 }], { natural: "water" }),
  ], "KDEN", 123, { lat: 0, lon: 0 });
  assert.equal(parsed.geography?.fallback, false);
  assert.equal(parsed.geography?.base, "land");
  assert.equal(parsed.geography?.water.length, 0);
});

test("bounded coastline gaps cannot invent a segment across the airport", () => {
  const parsed = parseAirportSurfaceElements([{
    id: 201, type: "way", tags: { natural: "coastline" },
    geometry: [
      { lat: -0.6, lon: -0.2 }, { lat: 0, lon: -0.2 }, null,
      { lat: 0, lon: 0.2 }, { lat: 0.6, lon: 0.2 },
    ],
  }], "KSAN", 123, { lat: 0, lon: 0 });
  assert.equal(parsed.geography?.fallback, true);
  assert.equal(parsed.geography?.fallbackReason, "open-coastline-not-on-box-edge");
});

test("bounded water ways and incomplete relation members never receive invented closing edges", () => {
  const geometry = [
    { lat: -0.1, lon: -0.1 }, { lat: -0.1, lon: 0.1 }, null,
    { lat: 0.1, lon: 0.1 }, { lat: 0.1, lon: -0.1 }, { lat: -0.1, lon: -0.1 },
  ];
  const parsed = parseAirportSurfaceElements([
    { id: 202, type: "way", tags: { natural: "water" }, geometry },
    { id: 203, type: "relation", tags: { natural: "water", type: "multipolygon" },
      members: [{ type: "way", role: "outer", geometry }] },
  ], "KORD", 123, { lat: 0, lon: 0 });
  assert.equal(parsed.geography?.water.length, 0);
});


test("water relation joins separately returned member ways and preserves island holes without duplicates", () => {
  const outer = square(901, 0.03, 0.03, 0.12, 0.12, { natural: "water" });
  const inner = square(902, 0.05, 0.05, 0.09, 0.09, { natural: "water" });
  const parsed = parseAirportSurfaceElements([
    { id: 90, type: "relation", tags: { natural: "water", type: "multipolygon" }, members: [
      { type: "way", ref: 901, role: "outer" }, { type: "way", ref: 902, role: "inner" },
    ] }, outer, inner,
  ], "KORD", 123, { lat: 0, lon: 0 });
  assert.equal(parsed.geography?.fallback, false);
  assert.equal(parsed.geography?.water.length, 1);
  assert.equal(parsed.geography?.water[0]?.holes?.length, 1);
  assert.equal(airportGeographyIsWater(parsed.geography!, { lat: 0.07, lon: 0.07 }), false);
  assert.equal(airportGeographyIsWater(parsed.geography!, { lat: 0.04, lon: 0.04 }), true);
});

test("bounded reference-only water members join complete fragments but retain missing-node breaks", () => {
  const a = [{ lat: 0.03, lon: 0.03 }, { lat: 0.03, lon: 0.05 }, { lat: 0.05, lon: 0.05 }];
  const b = [{ lat: 0.05, lon: 0.05 }, { lat: 0.05, lon: 0.03 }, { lat: 0.03, lon: 0.03 }];
  const relation = { id: 90, type: "relation" as const, tags: { natural: "water" }, members: [
    { type: "way" as const, ref: 901, role: "outer" }, { type: "way" as const, ref: 902, role: "outer" },
  ] };
  const parse = (geometry: Array<{ lat: number; lon: number } | null>) => parseAirportSurfaceElements([
    relation, line(901, a, {}), { id: 902, type: "way", geometry },
  ], "KORD", 123, { lat: 0, lon: 0 });
  assert.equal(parse(b).geography?.water.length, 1);
  assert.equal(parse([b[0]!, null, b[1]!, b[2]!]).geography?.water.length, 0);
});

test("water relation associates a concave island with its outer ring using an island vertex", () => {
  const outer = [{ lat: 0.01, lon: 0.01 }, { lat: 0.01, lon: 0.12 }, { lat: 0.04, lon: 0.12 },
    { lat: 0.04, lon: 0.04 }, { lat: 0.12, lon: 0.04 }, { lat: 0.12, lon: 0.01 }, { lat: 0.01, lon: 0.01 }];
  const inner = [{ lat: 0.02, lon: 0.02 }, { lat: 0.02, lon: 0.11 }, { lat: 0.03, lon: 0.11 },
    { lat: 0.03, lon: 0.03 }, { lat: 0.11, lon: 0.03 }, { lat: 0.11, lon: 0.02 }, { lat: 0.02, lon: 0.02 }];
  const parsed = parseAirportSurfaceElements([{ id: 90, type: "relation", tags: { natural: "water" }, members: [
    { type: "way", role: "outer", geometry: outer }, { type: "way", role: "inner", geometry: inner },
  ] }], "KORD", 123, { lat: 0, lon: 0 });
  assert.equal(parsed.geography?.water[0]?.holes?.length, 1);
  assert.equal(airportGeographyIsWater(parsed.geography!, { lat: 0.025, lon: 0.08 }), false);
});

test("airport point remains dry when runway geometry is unavailable", () => {
  const parsed = parseAirportSurfaceElements([square(1, -0.1, -0.1, 0.1, 0.1, { natural: "water" })],
    "KORD", 123, { lat: 0, lon: 0 });
  assert.equal(parsed.geography?.fallbackReason, "water-covers-runways");
});

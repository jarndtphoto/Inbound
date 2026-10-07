import { test } from "node:test";
import assert from "node:assert/strict";
import { AIRPORT_BY_ICAO } from "../airports";
import { destPoint, haversineNm } from "../geo";
import { AREA_IDS, CHICAGO_COLLECTION, areaDefinition, rankingViewKey, resolveNearbyRequest } from "./areas";
import { cropToView, statuteMilesFromNm, viewProximity } from "./geography";
import { FIXTURE_NOW } from "./fixtures";

test("All approved aliases resolve inside Inbound with exact defaults", () => {
  for (const nameOrId of ["Chicago", "Chicago area", "chicago", "preset:chicago", "  CHICAGO  "]) {
    const r = resolveNearbyRequest({ area: { kind: "preset", nameOrId } }, FIXTURE_NOW);
    assert.ok(r.ok); assert.equal(r.area.id, "preset:chicago"); assert.equal(r.area.radiusNm, 38); assert.equal(r.limit, 4); assert.equal(r.includePosition, false);
  }
  for (const [names, id] of [[["ORD", "KORD", "O'Hare", "Ohare", "Chicago O'Hare"], "airport:KORD"], [["MDW", "KMDW", "Midway", "Chicago Midway"], "airport:KMDW"]] as const) for (const code of names) {
    const r = resolveNearbyRequest({ area: { kind: "airport", code } }, FIXTURE_NOW); assert.ok(r.ok); assert.equal(r.area.id, id); assert.equal(r.area.radiusNm, 25);
  }
  assert.equal(areaDefinition("airport:KORD").reference.latitude, AIRPORT_BY_ICAO.KORD!.lat);
  assert.equal(areaDefinition("airport:KMDW").reference.longitude, AIRPORT_BY_ICAO.KMDW!.lon);
});
test("Unsupported aliases/radii/limits/point input fail safely without clamping", () => {
  for (const [input, code] of [[{ area: { kind: "airport", code: "JFK" } }, "unsupported_area"], [{ area: null }, "area_required"], [{ area: null, radiusNm: 24 }, "invalid_radius"], [{ area: null, limit: 6 }, "invalid_limit"], [{ area: { kind: "point", latitude: 41.9, longitude: -87.8 } }, "invalid_input"]] as const) {
    const r = resolveNearbyRequest(input, FIXTURE_NOW); assert.ok(!r.ok); assert.equal(r.response.error!.code, code); assert.equal(r.response.areaChoices.length, 3);
  }
});
test("Nine views fit the proposed Chicago covering circle and re-crop independently", () => {
  for (const id of AREA_IDS) for (const radiusNm of [12, 25, 38] as const) {
    const area = { ...areaDefinition(id), radiusNm };
    const reference = { lat: area.reference.latitude, lon: area.reference.longitude };
    assert.ok(haversineNm({ lat: CHICAGO_COLLECTION.latitude, lon: CHICAGO_COLLECTION.longitude }, reference) + radiusNm < 50);
    const inside = destPoint(reference, 60, radiusNm - 0.0001);
    const outside = destPoint(reference, 60, radiusNm + 0.0001);
    const rows = [{ latitude: inside.lat, longitude: inside.lon, dst: 999, dir: 270 }, { latitude: outside.lat, longitude: outside.lon, dst: 0, dir: 0 }, { latitude: 40.64, longitude: -73.78, dst: 0, dir: 0 }, { latitude: NaN, longitude: 0, dst: 0, dir: 0 }];
    const cropped = cropToView(area, rows); assert.equal(cropped.length, 1); assert.ok(Math.abs(cropped[0]!.distanceNm - (radiusNm - 0.0001)) < 1e-8); assert.ok(Math.abs(cropped[0]!.bearingDeg - 60) < 1e-8);
  }
});
test("Distance is nautical miles from area reference; statute conversion is display-only", () => {
  const chicago = areaDefinition("preset:chicago");
  const p = destPoint({ lat: 41.9, lon: -87.8 }, 90, 3.56);
  const proximity = viewProximity(chicago, { latitude: p.lat, longitude: p.lon });
  assert.ok(Math.abs(proximity.distanceNm - 3.56) < 1e-8); assert.ok(Math.abs(statuteMilesFromNm(proximity.distanceNm) - 4.09677) < 0.0001);
  assert.notEqual(viewProximity(areaDefinition("airport:KORD"), { latitude: p.lat, longitude: p.lon }).distanceNm, proximity.distanceNm);
  assert.throws(() => viewProximity(chicago, { latitude: 91, longitude: 0 }), RangeError);
});
test("View key excludes per-viewer limit, identity and position options", () => {
  const a = resolveNearbyRequest({ area: { kind: "airport", code: "ORD" }, limit: 1 }, FIXTURE_NOW);
  const b = resolveNearbyRequest({ area: { kind: "airport", code: "KORD" }, limit: 5, includePosition: true }, FIXTURE_NOW);
  assert.ok(a.ok && b.ok); assert.equal(rankingViewKey(a.area), rankingViewKey(b.area));
});

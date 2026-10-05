import assert from "node:assert/strict";
import { test } from "node:test";
import { initialBearing } from "./geo.ts";

const mco = { lat: 28.4312, lon: -81.3081 };

function closeTo(actual: number, expected: number, tolerance = 0.2) {
  const delta = Math.abs(((actual - expected + 540) % 360) - 180);
  assert.ok(delta <= tolerance, `expected ${expected}° ± ${tolerance}°, got ${actual}°`);
}

test("initialBearing returns the four cardinal directions at MCO", () => {
  closeTo(initialBearing(mco, { lat: mco.lat + 0.01, lon: mco.lon }), 0);
  closeTo(initialBearing(mco, { lat: mco.lat, lon: mco.lon + 0.01 }), 90);
  closeTo(initialBearing(mco, { lat: mco.lat - 0.01, lon: mco.lon }), 180);
  closeTo(initialBearing(mco, { lat: mco.lat, lon: mco.lon - 0.01 }), 270);
});

test("initialBearing matches the ORD to DEN great-circle heading", () => {
  const ord = { lat: 41.9786, lon: -87.9048 };
  const den = { lat: 39.8561, lon: -104.6737 };
  closeTo(initialBearing(ord, den), 266.07, 0.2);
});

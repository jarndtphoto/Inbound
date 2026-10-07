import test from "node:test";
import assert from "node:assert/strict";
import { airportRunwayFallbackFeatures } from "./airport-runway-fallback.ts";

test("static runway fallback pairs known ORD runway ends into runway lines", () => {
  const features = airportRunwayFallbackFeatures("KORD");
  assert.equal(features.length, 8);
  assert.ok(features.every((feature) => feature.kind === "runway" && feature.points.length === 2));
  const refs = new Set(features.map((feature) => feature.ref));
  assert.ok(refs.has("04L/22R"));
  assert.ok(refs.has("10R/28L"));
});

test("static runway fallback covers MDW without any network request", () => {
  const features = airportRunwayFallbackFeatures("KMDW");
  assert.equal(features.length, 4);
  assert.ok(features.some((feature) => feature.ref === "04R/22L"));
});

test("unknown airports fail closed without invented geometry", () => {
  assert.deepEqual(airportRunwayFallbackFeatures("ZZZZ"), []);
});

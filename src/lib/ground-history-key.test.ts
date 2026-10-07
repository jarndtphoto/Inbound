import test from "node:test";
import assert from "node:assert/strict";
import { groundHistoryKey } from "./ground-history-key.ts";
import type { FlightStory } from "./types.ts";

const story = {
  stateKey: "leg:v1:UAL219|2026-10-07|MCO|HNL", iata: "UA219",
  origin: { iata: "MCO" }, dest: { iata: "HNL" }, aircraft: { registration: "N123UA", hex: "a12345" },
} as FlightStory;
test("saved ground history is scoped to service date, route, and tail assignment", () => {
  const original = groundHistoryKey(story);
  assert.ok(original);
  assert.notEqual(groundHistoryKey({ ...story, stateKey: story.stateKey!.replace("10-07", "10-08") }), original);
  assert.notEqual(groundHistoryKey({ ...story, dest: { ...story.dest, iata: "ORD" } }), original);
  assert.notEqual(groundHistoryKey({ ...story, aircraft: { ...story.aircraft!, registration: "N456UA" } }), original);
  assert.equal(groundHistoryKey({ ...story, aircraft: { ...story.aircraft!, registration: "n-123ua", hex: "" } }), original);
});
test("unresolved flight numbers cannot load a previous day's stored ground snapshot", () => {
  assert.equal(groundHistoryKey({ ...story, stateKey: null }), null);
  assert.ok(groundHistoryKey({ ...story, stateKey: null, schedule: { status: "current", confirmedAt: 1, serviceDate: "2026-10-07" } }));
});

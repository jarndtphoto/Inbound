import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FLIGHT_STAGES, flightStageId, stageStepId, statusProgressIndex } from "./flight-stage.ts";

test("every server/wrapper stage has an explicit progress and pager mapping", () => {
  const server = readFileSync(new URL("./story.server.ts", import.meta.url), "utf8");
  const classifier = server.slice(server.indexOf("function baseCurrentStageOf"), server.indexOf("export function postLandingState"));
  const wrapper = readFileSync(new URL("./story.ts", import.meta.url), "utf8");
  const emitted = new Set([...classifier.matchAll(/return "([a-z_]+)"/g)].map(m => m[1]));
  for (const m of wrapper.matchAll(/currentStage: "([a-z_]+)"|TAKEOFF_ROLL_STAGE = "([a-z_]+)"/g)) emitted.add(m[1] ?? m[2]);
  assert(emitted.has("takeoff_roll"));
  for (const value of emitted) {
    assert.equal(flightStageId(value), value, `unknown emitted stage: ${value}`);
    assert(FLIGHT_STAGES.some(s => s.id === stageStepId(value)), `no pager step: ${value}`);
    assert(Number.isInteger(statusProgressIndex(flightStageId(value))));
    if (!["inbound", "origin_gate"].includes(value)) assert(statusProgressIndex(flightStageId(value)) > 0);
  }
  assert.equal(statusProgressIndex("takeoff_roll"), 2);
  assert.equal(stageStepId("takeoff_roll"), "taxi");
  assert.equal(flightStageId("Takeoff roll"), "takeoff_roll", "older device cache remains readable");
});

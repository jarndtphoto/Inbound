import { test } from "node:test";
import assert from "node:assert/strict";
import { phaseOf, verticalTrend, createPhaseHistory, destinationContext } from "./aircraft-phase.ts";
const origin = { lat: 0, lon: -10, elevationFt: 500 }, dest = { lat: 0, lon: 0, elevationFt: 600 };
const ac = { lat: 0, lon: -1, altFt: 20000, onGround: false, vertFpm: -1000, seenAt: 1000, seenSec: 1 };

test("single cruise jitter cannot confirm climb/descent; a 30-second altitude trend can", () => {
  for (const vertFpm of [-500, -400, 300, 400, 500]) assert.equal(phaseOf({ ...ac, vertFpm }), "cruise");
  assert.equal(phaseOf(ac, { origin, dest, history: [{ ...ac, seenAt: 970, altFt: 20500 }] }), "descent");
  assert.equal(verticalTrend(ac, [{ ...ac, seenAt: 971, altFt: 20500 }]).phaseVertFpm, null);
});
test("cruise jitter, repeated timestamps, stale fixes and missing evidence remain unconfirmed", () => {
  const observe = createPhaseHistory();
  for (let i = 0; i < 12; i++) {
    const result = observe("leg", { ...ac, seenAt: 1000 + i * 10, vertFpm: i % 2 ? 400 : -400, altFt: i % 2 ? 20030 : 20000 });
    assert.equal(result.phase, "cruise");
  }
  assert.equal(verticalTrend(ac, [{ ...ac }]).phaseVertFpm, null);
  assert.equal(verticalTrend({ ...ac, extrapolated: true }, [{ ...ac, seenAt: 960, altFt: 21000 }]).phaseVertFpm, null);
  assert.equal(verticalTrend({ ...ac, seenSec: 61 }, [{ ...ac, seenAt: 960, altFt: 21000 }]).phaseVertFpm, null);
});
test("provider-only rates need a sustained window, and opposing altitude evidence wins", () => {
  const bare = { ...ac, altFt: null };
  assert.equal(verticalTrend(bare, [{ ...bare, seenAt: 960 }]).phaseVertFpm, -1000);
  assert.equal(verticalTrend(bare, [{ ...bare, seenAt: 960, vertFpm: 400 }]).phaseVertFpm, null);
  assert.equal(verticalTrend(ac, [{ ...ac, seenAt: 960, altFt: ac.altFt }]).phaseVertFpm, null);
});
test("AGL and destination geometry distinguish approach from departure level-off", () => {
  assert.equal(phaseOf({ ...ac, altFt: 8500, phaseVertFpm: -600 }, { origin, dest }), "approach");
  const departing = { ...ac, lon: -9.9, altFt: 6000, vertFpm: -400 };
  assert.equal(phaseOf(departing, { origin, dest }), "climb");
  assert.equal(destinationContext(departing, { origin, dest }), false);
});
test("warm evidence is isolated by dated leg/route and ignores reordered samples", () => {
  const observe = createPhaseHistory(); observe("today:routeA", { ...ac, seenAt: 960, altFt: 21000 });
  assert.equal(observe("today:routeA", ac).phase, "descent");
  assert.equal(observe("tomorrow:routeA", ac).phase, "cruise");
  assert.equal(observe("today:routeB", ac).phase, "cruise");
});

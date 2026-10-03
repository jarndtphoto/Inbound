import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmTakeoff, takeoffFloorStage } from "./confirmed-takeoff.ts";
const now = 1790983661;
const schedule = { ident: "UAL219", gateOut: { scheduled: 1790952900 }, takeoff: { actual: 1790957520 } };
const args = { schedule, key: "leg:v1:UAL219|2026-10-02|ORD|HNL", reason: null,
  now, groundElevationFt: 680, expected: { callsigns: ["UAL219", "UA219"], registration: "N219UA", hex: "a21900" } };
const position = { callsign: "UAL219", registration: "N219UA", hex: "a21900", lat: 42, lon: -87,
  onGround: false, altFt: 1300, gsKt: 70, seenSec: 1 };
test("validated actual takeoff confirms; scheduled, estimated and Departed alone do not", () => {
  assert.deepEqual(confirmTakeoff(args), { time: 1790957520, source: "provider_actual", confirmedAt: now });
  for (const takeoff of [{ scheduled: now - 100 }, { estimated: now - 100 }, {}])
    assert.equal(confirmTakeoff({ ...args, schedule: { ...schedule, takeoff } }), undefined);
});
test("fresh compatible airborne AGL or speed confirms without inventing an event time", () => {
  const base = { ...args, schedule: { ...schedule, takeoff: {} } };
  assert.equal(confirmTakeoff({ ...base, position })?.time, null);
  assert.equal(confirmTakeoff({ ...base, position: { ...position, altFt: 700, gsKt: 81 } })?.source, "observed_airborne");
  for (const patch of [{ onGround: true }, { seenSec: 46 }, { seenSec: -1 }, { extrapolated: true }, { altFt: 1180, gsKt: 80 }])
    assert.equal(confirmTakeoff({ ...base, position: { ...position, ...patch } }), undefined);
});
test("reject future clocks, wrong service dates/routes, conflicting identity, and device claims", () => {
  assert.equal(confirmTakeoff({ ...args, schedule: { ...schedule, takeoff: { actual: now + 1 } } }), undefined);
  assert.equal(confirmTakeoff({ ...args, schedule: { ...schedule, takeoff: { actual: 1790952900 - 86400 } } }), undefined);
  for (const reason of ["service_date_mismatch", "route_mismatch", "no_ident"] as const)
    assert.equal(confirmTakeoff({ ...args, reason, position }), undefined);
  assert.equal(confirmTakeoff({ ...args, deviceOnly: true, position }), undefined);
  const base = { ...args, schedule: { ...schedule, takeoff: {} } };
  for (const patch of [{ registration: "N000XX" }, { hex: "ffffff" }, { callsign: "DAL219", registration: null, hex: null }])
    assert.equal(confirmTakeoff({ ...base, position: { ...position, ...patch } }), undefined);
});
test("floor raises every pre-departure stage, preserves arrival stages and a go-around ride", () => {
  const c = confirmTakeoff(args);
  for (const stage of ["inbound", "origin_gate", "push", "taxi", "takeoff_roll", "Takeoff roll"]) {
    assert.equal(takeoffFloorStage(stage, c), "ride"); assert.equal(takeoffFloorStage(stage), stage);
  }
  for (const stage of ["ride", "arrival", "final_approach", "taxi_in", "gate"])
    assert.equal(takeoffFloorStage(stage, c), stage);
});

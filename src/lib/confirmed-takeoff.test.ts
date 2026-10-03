import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmTakeoff, reconcileTakeoff, hasOriginSurfaceFix, takeoffFloorStage } from "./confirmed-takeoff.ts";
import { activeConfirmedTakeoff, mergeConfirmedTakeoff } from "./flight-phase-state-logic.ts";
const now = 1790983661;
const schedule = { ident: "UAL219", gateOut: { scheduled: 1790952900 }, takeoff: { actual: 1790957520 } };
const args = { schedule, key: "leg:v1:UAL219|2026-10-02|ORD|HNL", reason: null,
  now, origin: { lat: 41.9786, lon: -87.9048 }, groundElevationFt: 680, expected: { callsigns: ["UAL219", "UA219"], registration: "N219UA", hex: "a21900" } };
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

const surface = { ...position, lat: 41.9786, lon: -87.9048, onGround: true, altFt: 680, gsKt: 14 };
const early = { ...args, schedule: { ...schedule, takeoff: { actual: now - 30 } } };
test("premature provider stamp with a fresh matched origin surface fix has no active latch", () => {
  assert.equal(confirmTakeoff({ ...early, position: surface }), undefined);
  const rejected = reconcileTakeoff(undefined, { ...early, position: surface });
  assert.equal(activeConfirmedTakeoff(rejected), undefined);
  assert.deepEqual(rejected?.revocations, [{ time: now - 30, at: now }]);
  assert.equal(activeConfirmedTakeoff(reconcileTakeoff(rejected, { ...early, position: null })), undefined,
    "missing position must not relatch the rejected stamp");
});
test("provider stamp without any position latches immediately", () => {
  assert.equal(activeConfirmedTakeoff(reconcileTakeoff(undefined, { ...early, position: null }))?.source, "provider_actual");
});
test("early origin surface fix revokes provider-only proof through the ten-minute boundary", () => {
  const provider = confirmTakeoff(early)!;
  for (const elapsed of [30, 600]) {
    const next = reconcileTakeoff(provider, { ...early, now: provider.time! + elapsed, position: surface });
    assert.equal(activeConfirmedTakeoff(next), undefined);
  }
  assert.equal(activeConfirmedTakeoff(reconcileTakeoff(provider,
    { ...early, now: provider.time! + 601, position: surface }))?.source, "provider_actual");
  assert.equal(confirmTakeoff({ ...args, position: surface }), undefined,
    "an old stamp is still blocked on its initial confirmation when current surface evidence contradicts it");
});
test("observed airborne proof survives surface conflict, including provider actual upgrades", () => {
  const observed = confirmTakeoff({ ...early, schedule: { ...schedule, takeoff: {} }, position })!;
  const afterSurface = reconcileTakeoff(observed, { ...early, position: surface });
  assert.equal(activeConfirmedTakeoff(afterSurface)?.source, "observed_airborne");
  const upgraded = mergeConfirmedTakeoff(observed, confirmTakeoff(early));
  assert.equal(upgraded?.observedAt, now);
  assert.equal(activeConfirmedTakeoff(reconcileTakeoff(upgraded, { ...early, position: surface }))?.source, "provider_actual");
  const immediate = confirmTakeoff({ ...early, position });
  assert.equal(immediate?.observedAt, now, "provider and observed evidence in the same poll retain both provenances");
});
test("only real, fresh, positively matched origin surface fixes contradict a provider clock", () => {
  assert.equal(hasOriginSurfaceFix({ ...early, position: { ...surface, seenSec: 60 } }), true);
  for (const patch of [{ seenSec: 61 }, { seenSec: -1 }, { extrapolated: true }, { lat: 42.5 },
    { callsign: "DAL219", hex: null, registration: null }, { callsign: null, hex: null, registration: null },
    { hex: "ffffff" }, { registration: "N000XX" }]) {
    const position = { ...surface, ...patch };
    assert.equal(hasOriginSurfaceFix({ ...early, position }), false);
    assert.equal(confirmTakeoff({ ...early, position })?.source, "provider_actual");
  }
  assert.equal(hasOriginSurfaceFix({ ...early, position: { ...surface, seenAt: now - 61, seenSec: 1 } }), false);
});

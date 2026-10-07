import test from "node:test";
import assert from "node:assert/strict";
import { compatibleGroundContinuity, retainedGroundFix, retainNewestGroundFix, type GroundContinuity } from "./ground-continuity.ts";

const observedAt = Date.parse("2026-10-07T14:09:12Z") / 1000;
const entry: GroundContinuity = {
  legKey: "leg:v1:SWA3300|2026-10-07|RIC|MDW:RIC:MDW", airportIata: "MDW", movementKind: "arrival",
  registration: "N8305E", hex: "ab5b66",
  fix: { lat: 41.788742, lon: -87.74259, altFt: 0, gsKt: 1.4, track: null, onGround: true,
    seenAt: observedAt, registration: "N8305E", callsign: "SWA3300", provider: "adsb" },
};
const scope = { legKey: entry.legKey, airportIata: "MDW", movementKind: "arrival" as const,
  lat: 41.7868, lon: -87.7522, identity: { registration: "N8305E", hex: "ab5b66" } };

test("WN3300's real observation survives a tab remount at76seconds without changing its timestamp", () => {
  const cached = compatibleGroundContinuity(structuredClone(entry), scope);
  assert.equal(retainedGroundFix(cached, (observedAt + 76) * 1000)?.seenAt, observedAt);
  assert.equal(retainedGroundFix(cached, (observedAt + 120) * 1000)?.seenAt, observedAt);
  assert.equal(retainedGroundFix(cached, (observedAt + 120.001) * 1000), null);
});
test("temporary missing identity may use same-leg history, explicit reassignment may not", () => {
  assert.ok(compatibleGroundContinuity(entry, { ...scope, identity: {} }));
  assert.ok(compatibleGroundContinuity(entry, { ...scope, identity: { registration: "n-8305e" } }));
  assert.equal(compatibleGroundContinuity(entry, { ...scope, identity: { registration: "N999WN" } }), null);
  assert.equal(compatibleGroundContinuity(entry, { ...scope, identity: { hex: "abcdef" } }), null);
});
test("observation continuity never crosses date, route, airport, or movement", () => {
  for (const patch of [
    { legKey: entry.legKey.replace("10-07", "10-08") },
    { legKey: entry.legKey.replace("RIC", "ORD") },
    { airportIata: "ORD" }, { movementKind: "departure" as const },
    { lat: 28.4312, lon: -81.3081 },
  ]) assert.equal(compatibleGroundContinuity(entry, { ...scope, ...patch }), null);
});
test("a delayed older observation cannot overwrite the held newest fix", () => {
  const older = { ...entry, fix: { ...entry.fix, seenAt: observedAt - 20, lat: 41.79 } };
  assert.equal(retainNewestGroundFix(entry, older), entry);
  const newer = { ...entry, fix: { ...entry.fix, seenAt: observedAt + 20, lat: 41.79 } };
  assert.equal(retainNewestGroundFix(entry, newer), newer);
});
test("invalid or far-future observation times do not revive a retained point", () => {
  for (const seenAt of [NaN, Infinity, -1, observedAt + 600]) {
    assert.equal(retainedGroundFix({ ...entry, fix: { ...entry.fix, seenAt } }, observedAt * 1000), null);
  }
});

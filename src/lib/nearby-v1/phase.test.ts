import { test } from "node:test";
import assert from "node:assert/strict";
import { createPhaseHistory } from "../aircraft-phase";
import { fuseProviderLists, resetFusion, type AdsbRaw, type ProviderAcquisitionPack } from "../adsb-fusion";
import { areaDefinition } from "../plugin-v1/areas";
import { scoreCandidate } from "../plugin-v1/ranking";
import { NEARBY_POLICY, type AcceptedNearbyObservation } from "./model";
import { normalizeAcceptedNearby } from "./normalize";

const T0 = Date.parse("2026-10-03T22:00:00Z");
const area = areaDefinition("preset:chicago");
const raw = (changes: Partial<AdsbRaw> = {}): AdsbRaw => ({ hex: "abc123", flight: "UAL123", r: "N12345", lat: 41.91, lon: -87.81,
  alt_baro: 20000, gs: 210, track: 93, baro_rate: -650, seen: 0, seen_pos: 0, t: "B738", ...changes });
function poll(previous: AcceptedNearbyObservation[], seconds: number, changes: Partial<AdsbRaw> = {}) {
  return pollRows(previous, seconds, [raw(changes)])[0]!;
}
function pollRows(previous: AcceptedNearbyObservation[], seconds: number, aircraft: AdsbRaw[]) {
  resetFusion(); // Every poll is a cold instance; only persisted accepted JSON remains.
  const nowMs = T0 + seconds * 1000;
  const packs: ProviderAcquisitionPack[] = [{ provider: "fi", ac: aircraft, receivedAt: nowMs, status: "ok", attempted: true }];
  const fused = fuseProviderLists(packs, { now: nowMs, airside: true, preferObserved: true });
  return normalizeAcceptedNearby(packs, fused, JSON.parse(JSON.stringify(previous)), nowMs);
}
function phase(observation: AcceptedNearbyObservation, seconds: number) {
  const ranked = scoreCandidate(observation, area, T0 + seconds * 1000); assert.ok(ranked); return ranked.motion;
}
test("Cold Nearby polls agree with main on one-sample jitter and sustained altitude movement", () => {
  const main = createPhaseHistory();
  let previous: AcceptedNearbyObservation[] = [];
  for (const [seconds, altitudeFt, expected] of [[0, 20000, "cruise"], [20, 19800, "cruise"], [40, 19600, "descent"], [60, 19400, "descent"]] as const) {
    const observation = poll(previous, seconds, { alt_baro: altitudeFt });
    const shared = main(observation.sessionKey, { seenAt: Date.parse(observation.observedAt) / 1000, lat: observation.latitude, lon: observation.longitude,
      altFt: observation.altitudeFt, vertFpm: observation.verticalRateFpm, onGround: observation.onGround, gsKt: observation.groundspeedKt });
    assert.equal(phase(observation, seconds).phase, expected);
    assert.equal(phase(observation, seconds).phase, shared.phase);
    assert.equal(phase(observation, seconds).verticalTrend, "falling");
    assert.equal(observation.verticalRateFpm, -650);
    previous = [observation];
  }
});
test("Cold jitter evidence is bounded and flat altitude overrides instantaneous provider rates", () => {
  const main = createPhaseHistory();
  let previous: AcceptedNearbyObservation[] = [];
  for (let i = 0; i < 20; i++) {
    const seconds = i * 20, altitudeFt = i % 2 ? 20030 : 20000, vertFpm = i % 2 ? 400 : -400;
    const before = structuredClone(previous);
    const observation = poll(previous, seconds, { alt_baro: altitudeFt, baro_rate: vertFpm });
    assert.deepEqual(previous, before);
    assert.equal(phase(observation, seconds).phase, "cruise");
    assert.equal(phase(observation, seconds).phase, main(observation.sessionKey,
      { seenAt: Date.parse(observation.observedAt) / 1000, lat: observation.latitude, lon: observation.longitude, altFt: altitudeFt, vertFpm, onGround: false }).phase);
    assert.ok((observation.phaseEvidence?.length ?? 0) <= NEARBY_POLICY.maxPhaseSamples);
    assert.ok((observation.phaseEvidence ?? []).every(([at]) => seconds + T0 / 1000 - at <= 120));
    previous = [observation];
  }
  assert.equal(previous[0].phaseEvidence?.length, NEARBY_POLICY.maxPhaseSamples);
});
test("Repeated authoritative timestamps retain old proof without manufacturing new proof", () => {
  const initial = poll([], 0);
  const repeated = poll([initial], 20, { seen_pos: 20 });
  assert.equal(repeated.observedAt, initial.observedAt); assert.deepEqual(repeated.phaseEvidence, []);
  assert.equal(phase(repeated, 20).phase, "cruise");
  const next = poll([repeated], 40, { alt_baro: 19600 });
  assert.equal(phase(next, 40).phase, "descent");
  const same = poll([next], 60, { seen_pos: 20, alt_baro: 19600 });
  assert.equal(same.observedAt, next.observedAt); assert.deepEqual(same.phaseEvidence, next.phaseEvidence);
  assert.equal(phase(same, 60).phase, "descent");
});
test("Session change or expired continuity drops phase evidence; identity omissions preserve it", () => {
  const first = poll([], 0), second = poll([first], 40, { alt_baro: 19600 });
  assert.equal(phase(second, 40).phase, "descent");
  const omitted = poll([second], 60, { flight: undefined, r: undefined, alt_baro: 19400 });
  assert.equal(omitted.sessionKey, second.sessionKey); assert.ok(omitted.phaseEvidence!.length >= 1);
  // Radar uses this neutral ident for accepted aircraft without current identity.
  assert.equal(phase({ ...omitted, observedCallsign: "AIRCRAFT" }, 60).phase, "descent");
  const changed = poll([second], 60, { flight: "AAL777", alt_baro: 19400 });
  assert.notEqual(changed.sessionKey, second.sessionKey); assert.equal(changed.phaseEvidence, undefined);
  assert.equal(phase(changed, 60).phase, "cruise");
  const expired = poll([second], 200, { alt_baro: 18000 });
  assert.notEqual(expired.sessionKey, second.sessionKey); assert.equal(expired.phaseEvidence, undefined);
  assert.equal(phase(expired, 200).phase, "cruise");
});
test("Geometric provider rates are preserved when barometric rates are unavailable", () => {
  for (const baro_rate of [undefined, NaN]) {
    const observation = poll([], 0, { baro_rate, geom_rate: 500 });
    assert.equal(observation.verticalRateFpm, 500); assert.equal(phase(observation, 0).verticalTrend, "rising");
    assert.equal(phase(observation, 0).phase, "cruise");
  }
  assert.equal(poll([], 0, { baro_rate: -650, geom_rate: 500 }).verticalRateFpm, -650);
});
test("Dense accepted collections with phase evidence stay within the existing durable byte cap", () => {
  const rows = Array.from({ length: NEARBY_POLICY.maxAccepted }, (_, i) => raw({ hex: i.toString(16).padStart(6, "0") }));
  const previous = pollRows([], 0, rows);
  for (const observation of previous) observation.phaseEvidence = Array.from({ length: NEARBY_POLICY.maxPhaseSamples }, (_, i) =>
    [T0 / 1000 - (NEARBY_POLICY.maxPhaseSamples - i) * 20, 20000, -650, false, observation.latitude, observation.longitude]);
  const accepted = pollRows(previous, 20, rows);
  assert.ok(accepted.length > 0 && accepted.length < previous.length);
  assert.ok(Buffer.byteLength(JSON.stringify(accepted), "utf8") <= NEARBY_POLICY.maxAcceptedBytes);
  assert.ok(accepted.every(o => o.phaseEvidence?.length === NEARBY_POLICY.maxPhaseSamples));
});

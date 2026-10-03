import { test } from "node:test";
import assert from "node:assert/strict";
import { destPoint } from "../geo";
import { areaDefinition, CHICAGO_COLLECTION } from "../plugin-v1/areas";
import { viewProximity } from "../plugin-v1/geography";
import { rankNearbyCandidates } from "../plugin-v1/ranking";
import { NEARBY_POLICY, type AcceptedNearbyObservation, type SharedCollection } from "./model";
import { deriveNearbyDisplayPosition } from "./motion";
import { buildNearbyView } from "./views";

const NOW = Date.UTC(2026, 9, 3, 22, 42);
const id = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
function observation(index: number, overrides: Partial<AcceptedNearbyObservation> = {}): AcceptedNearbyObservation {
  return {
    radarId: id(index + 10_000), cardId: id(index), privateAircraftIdentity: `private-aircraft-${index}`, sessionKey: `private-session-${index}`,
    observedCallsign: `UAL${index}`, registration: null, latitude: 41.9, longitude: -87.8,
    altitudeFt: 6_000, groundspeedKt: 240, groundTrackDeg: 90, verticalRateFpm: -500, onGround: false,
    observedAt: new Date(NOW - 5_000).toISOString(), positionKind: "observed", acceptedPosition: true, identityConflict: false,
    typeCode: "B738", category: null, operator: "United", interesting: false,
    route: { originIata: null, destinationIata: null, verification: "unknown", checkedAt: null }, datedBinding: null,
    freshness: { ageSeconds: 5, state: "fresh" }, provenance: { source: "private-test-source", receivedAt: new Date(NOW).toISOString(), positionAgeSeconds: 5, acceptance: "inbound-fusion" },
    ...overrides,
  };
}
function collection(observations: AcceptedNearbyObservation[], overrides: Partial<SharedCollection> = {}): SharedCollection {
  return {
    collectionKey: CHICAGO_COLLECTION.id, collectionVersion: 1, acceptedSnapshotAtMs: NOW, observations,
    metadata: { providerCalls: 2, rawCount: observations.length, fusedCount: observations.length, rejectedCount: 0, successfulProviders: 2, failedProviders: 0 },
    partial: false, lastAttemptFailed: false, leaseOwner: null, leaseUntilMs: null, fencingGeneration: 1,
    nextAttemptAtMs: NOW + 20_000, failureBackoffSeconds: 0, activeUntilMs: NOW + 60_000, inactiveExpiresAtMs: NOW + 3_600_000, ...overrides,
  };
}
const chicago = areaDefinition("preset:chicago");
test("Radar can contain 100 accepted symbols while featured remains the same four/five prefix", () => {
  const shared = collection(Array.from({ length: 130 }, (_, i) => observation(i + 1)));
  const four = buildNearbyView(shared, chicago, NOW); const five = buildNearbyView(shared, chicago, NOW, { limit: 5, previousStability: four.stability });
  assert.equal(four.radar.length, 100); assert.equal(five.radar.length, 100); assert.equal(four.ranked.length, 130);
  assert.equal(four.featured.length, 4); assert.equal(five.featured.length, 5);
  assert.deepEqual(four.featured.map(r => r.candidate.cardId), five.featured.slice(0, 4).map(r => r.candidate.cardId));
  assert.equal(four.radar.filter(r => r.featured).length, 4); assert.equal(five.radar.filter(r => r.featured).length, 5);
  assert.ok(new TextEncoder().encode(JSON.stringify(four.radar)).length <= NEARBY_POLICY.maxRadarBytes);
  for (const limit of [0, 6, 1.1]) assert.throws(() => buildNearbyView(shared, chicago, NOW, { limit }), RangeError);
});
test("Renderer boundary preserves accepted anchors and telemetry while omitting private/provider/token data", () => {
  const o = observation(1, { verticalRateFpm: null, groundTrackDeg: null, typeCode: "B738",
    phaseEvidence: [[NOW / 1000 - 45, 6500, -500, false, 41.9, -87.8]] });
  const radar = buildNearbyView(collection([o]), chicago, NOW).radar[0]!;
  assert.equal(radar.latitude, o.latitude); assert.equal(radar.longitude, o.longitude); assert.equal(radar.observedAt, o.observedAt);
  assert.equal(radar.altitudeFt, o.altitudeFt); assert.equal(radar.verticalRateFpm, null); assert.equal(radar.groundTrackDeg, null);
  assert.equal(radar.motion.verticalTrend, "unknown"); assert.equal(radar.typeCode, "B738");
  const serialized = JSON.stringify(radar);
  for (const privateField of [o.privateAircraftIdentity, o.sessionKey, o.provenance.source, "privateAircraftIdentity", "phaseEvidence", "registration", "provenance", "selection", "token", "cardId"]) assert.equal(serialized.includes(privateField), false, privateField);
  assert.equal(buildNearbyView(collection([observation(2, { typeCode: "<raw-provider-data>" })]), chicago, NOW).radar[0]!.typeCode, undefined);
});
test("Unidentified accepted aircraft populate Radar with a neutral ident and no invented track", () => {
  const o = observation(1, { observedCallsign: null, registration: null, groundTrackDeg: null });
  const view = buildNearbyView(collection([o]), chicago, NOW);
  assert.equal(view.radar.length, 1); assert.equal(view.featured.length, 0); assert.equal(view.ranked.length, 0);
  assert.equal(view.radar[0]!.displayIdent, "AIRCRAFT"); assert.equal(view.radar[0]!.groundTrackDeg, null);
  assert.equal(JSON.stringify(view.radar).includes(o.privateAircraftIdentity), false);
  assert.equal(deriveNearbyDisplayPosition(o, NOW + 10_000)!.kind, "accepted");
});
test("Existing ranking eligibility rejects vehicles, ground aircraft, unsafe positions and conflicts", () => {
  const invalid: Partial<AcceptedNearbyObservation>[] = [
    { typeCode: "SERV" }, { category: "C1" }, { operator: "Airport service" }, { onGround: true },
    { acceptedPosition: false }, { identityConflict: true }, { positionKind: "synthetic" }, { latitude: NaN }, { altitudeFt: 499 }, { groundspeedKt: 39 },
  ];
  const shared = collection([observation(1), ...invalid.map((override, i) => observation(i + 2, override))]);
  const view = buildNearbyView(shared, chicago, NOW);
  assert.deepEqual(view.featured.map(r => r.candidate.cardId), [id(1)]); assert.deepEqual(view.radar.map(r => r.radarId), [id(10_001)]);
});
test("Ranking deduplication selects the newest telemetry for Radar as well as featured cards", () => {
  const older = observation(1, { latitude: 41.91, groundTrackDeg: 180, observedAt: new Date(NOW - 15_000).toISOString() });
  const newer = { ...older, latitude: 41.92, groundTrackDeg: 90, observedAt: new Date(NOW - 2_000).toISOString() };
  for (const observations of [[older, newer], [newer, older]]) {
    const view = buildNearbyView(collection(observations), chicago, NOW);
    assert.equal(view.radar.length, 1); assert.equal(view.featured.length, 1);
    assert.equal(view.radar[0]!.latitude, newer.latitude); assert.equal(view.radar[0]!.groundTrackDeg, newer.groundTrackDeg);
    assert.equal(view.radar[0]!.observedAt, newer.observedAt); assert.equal(view.radar[0]!.freshness.ageSeconds, 2);
  }
});
test("Chicago, ORD and MDW reuse one collection but independently calculate proximity, crop and ranking", () => {
  const ord = areaDefinition("airport:KORD"); const mdw = areaDefinition("airport:KMDW");
  const nearOrd = observation(1, { latitude: ord.reference.latitude + .01, longitude: ord.reference.longitude });
  const nearMdw = observation(2, { latitude: mdw.reference.latitude + .01, longitude: mdw.reference.longitude });
  const shared = collection([nearOrd, nearMdw]);
  const views = [chicago, ord, mdw].map(area => buildNearbyView(shared, area, NOW));
  assert.deepEqual(views.map(v => v.collectionKey), Array(3).fill(CHICAGO_COLLECTION.id));
  for (const [index, area] of [chicago, ord, mdw].entries()) {
    const view = views[index]!;
    assert.deepEqual(view.ranked.map(r => r.candidate.cardId), rankNearbyCandidates(shared.observations, area, NOW).map(r => r.candidate.cardId));
    const row = view.ranked.find(r => r.candidate.cardId === nearOrd.cardId)!; const geometry = viewProximity(area, nearOrd);
    assert.equal(row.distanceNm, geometry.distanceNm); assert.equal(row.bearingDeg, geometry.bearingDeg);
    assert.equal(view.radar.find(r => r.radarId === nearOrd.radarId)!.distanceNm, geometry.distanceNm);
  }
  assert.equal(views[1]!.featured[0]!.candidate.cardId, nearOrd.cardId); assert.equal(views[2]!.featured[0]!.candidate.cardId, nearMdw.cardId);
  assert.notEqual(views[1]!.ranked[0]!.distanceNm, views[0]!.ranked.find(r => r.candidate.cardId === nearOrd.cardId)!.distanceNm);
  const narrowOrd = { ...ord, radiusNm: 12 as const }; const edge = destPoint({ lat: ord.reference.latitude, lon: ord.reference.longitude }, 270, 13);
  const outsideOrd = observation(3, { latitude: edge.lat, longitude: edge.lon }); const cropCollection = collection([outsideOrd]);
  assert.equal(buildNearbyView(cropCollection, narrowOrd, NOW).radar.length, 0);
  assert.equal(buildNearbyView(cropCollection, ord, NOW).radar.length, 1);
});
test("Last-safe stale reads preserve featured order and report actual age without advancing accepted positions", () => {
  const shared = collection([1, 2, 3, 4, 5, 6].map(i => observation(i)));
  const first = buildNearbyView(shared, chicago, NOW); const failed = { ...shared, lastAttemptFailed: true };
  const stale = buildNearbyView(failed, chicago, NOW + 60_000, { previousStability: first.stability });
  assert.deepEqual(stale.featured.map(r => r.candidate.cardId), first.featured.map(r => r.candidate.cardId));
  assert.deepEqual(stale.stability!.slots, first.stability!.slots);
  assert.ok(stale.radar.every(r => r.freshness.state === "stale" && r.freshness.ageSeconds === 65));
  assert.ok(stale.featured.every(r => r.ageSeconds === 65));
  assert.ok(stale.featured.every(r => (r.candidate as AcceptedNearbyObservation).freshness.state === "stale" && (r.candidate as AcceptedNearbyObservation).freshness.ageSeconds === 65));
  assert.equal(stale.radar[0]!.latitude, shared.observations[0]!.latitude);
  const coldOrd = buildNearbyView(failed, areaDefinition("airport:KORD"), NOW + 60_000);
  assert.equal(coldOrd.featured.length, 4); assert.equal(coldOrd.stability!.collectionVersion, shared.collectionVersion);
});
test("Telemetry and publication hard cutoffs remove old aircraft even when cached ranking state remains", () => {
  const shared = collection([observation(1)]); const first = buildNearbyView(shared, chicago, NOW);
  assert.equal(buildNearbyView(shared, chicago, NOW + 115_000, { previousStability: first.stability }).radar.length, 1);
  const expired = buildNearbyView(shared, chicago, NOW + 115_001, { previousStability: first.stability });
  assert.equal(expired.radar.length, 0); assert.equal(expired.featured.length, 0); assert.equal(expired.ranked.length, 0);
  const oldPublication = collection([observation(2, { observedAt: new Date(NOW + 120_000).toISOString() })]);
  assert.equal(buildNearbyView(oldPublication, chicago, NOW + 120_001).radar.length, 0);
  assert.equal(buildNearbyView(collection([], { collectionVersion: 0, acceptedSnapshotAtMs: null }), chicago, NOW).featured.length, 0);
});
test("View assembly is pure and byte-bounded even when a private radar identifier is unexpectedly oversized", () => {
  const shared = collection([observation(1, { radarId: "x".repeat(NEARBY_POLICY.maxRadarBytes) }), observation(2)]);
  const original = structuredClone(shared); const view = buildNearbyView(shared, chicago, NOW);
  assert.deepEqual(shared, original); assert.equal(view.radar.length, 1); assert.equal(view.radar[0]!.radarId, id(10_002));
  assert.ok(new TextEncoder().encode(JSON.stringify(view.radar)).length <= NEARBY_POLICY.maxRadarBytes);
  assert.throws(() => buildNearbyView({ ...shared, collectionKey: "nearby:other" }, chicago, NOW));
  assert.throws(() => buildNearbyView(shared, chicago, NaN));
});

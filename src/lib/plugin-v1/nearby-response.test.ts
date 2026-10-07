import { test } from "node:test";
import assert from "node:assert/strict";
import { areaDefinition, CHICAGO_COLLECTION } from "./areas";
import { type ResolvedAreaV1 } from "./contracts";
import { type AcceptedNearbyObservation, type SharedCollection, NEARBY_POLICY } from "../nearby-v1/model";
import { buildNearbyView } from "../nearby-v1/views";
import { deriveNearbyDisplayPosition } from "../nearby-v1/motion";
import { InboundNearbyResponseSchema, NearbyTransportRequestSchema, PUBLIC_NEARBY_PAYLOAD_BYTES,
  PUBLIC_RADAR_PAYLOAD_BYTES, PublicRadarTargetSchema, publicNearbyResponseBytes, serializeNearbyResponse } from "./nearby-response";

const NOW = Date.UTC(2030, 0, 15, 18);
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const iso = (at = NOW) => new Date(at).toISOString();
const chicago = areaDefinition("preset:chicago");
function observation(n: number, overrides: Partial<AcceptedNearbyObservation> = {}): AcceptedNearbyObservation {
  return { radarId: id(n + 10000), cardId: id(n), privateAircraftIdentity: `PRIVATE-AIRCRAFT-${n}`, sessionKey: `PRIVATE-SESSION-${n}`,
    observedCallsign: `TEST${n}`, registration: null, latitude: 41.9 + n * .00001, longitude: -87.8,
    altitudeFt: 8000, groundspeedKt: 240, groundTrackDeg: 90, verticalRateFpm: 500, onGround: false,
    observedAt: iso(NOW - 5000), positionKind: "observed", acceptedPosition: true, identityConflict: false,
    typeCode: "B738", category: null, operator: "PRIVATE-OPERATOR", interesting: false,
    route: { originIata: null, destinationIata: null, verification: "unknown", checkedAt: null }, datedBinding: null,
    phaseEvidence: [[NOW / 1000 - 40, 7650, 500, false, 41.9, -87.8]],
    freshness: { ageSeconds: 5, state: "fresh" },
    provenance: { source: "PRIVATE-PROVIDER", receivedAt: iso(), positionAgeSeconds: 5, acceptance: "inbound-fusion" }, ...overrides };
}
function collection(observations: AcceptedNearbyObservation[]): SharedCollection {
  return { collectionKey: CHICAGO_COLLECTION.id, collectionVersion: 7, acceptedSnapshotAtMs: NOW, observations,
    metadata: { providerCalls: 0, rawCount: observations.length, fusedCount: observations.length, rejectedCount: 0, successfulProviders: 1, failedProviders: 0 },
    partial: false, lastAttemptFailed: false, leaseOwner: null, leaseUntilMs: null, fencingGeneration: 3,
    nextAttemptAtMs: NOW + 20000, failureBackoffSeconds: 0, activeUntilMs: NOW + 60000, inactiveExpiresAtMs: NOW + 3600000 };
}
function response(count = 8, limit = 4, area: ResolvedAreaV1 = chicago) {
  const view = buildNearbyView(collection(Array.from({ length: count }, (_, i) => observation(i + 1))), area, NOW, { limit });
  return serializeNearbyResponse({ health: "ok", view }, area, NOW);
}

test("Public response keeps 100 Radar targets independent from Featured four/five", () => {
  for (const limit of [4, 5]) {
    const value = response(125, limit);
    assert.equal(value.radarTargets.length, 100); assert.equal(value.featuredFlights.length, limit);
    assert.equal(value.radarTargets.filter(target => target.featured).length, limit);
    assert.equal(value.collectionVersion, 7); assert.equal(value.generatedAt, iso());
    assert.ok(publicNearbyResponseBytes(value) <= PUBLIC_NEARBY_PAYLOAD_BYTES);
    assert.ok(publicNearbyResponseBytes(value.radarTargets) <= 60 * 1024);
  }
  const hundred = response(125);
  assert.equal(InboundNearbyResponseSchema.safeParse({ ...hundred, radarTargets: [...hundred.radarTargets, { ...hundred.radarTargets[0], radarId: id(50000) }] }).success, false);
  assert.equal(InboundNearbyResponseSchema.safeParse({ ...hundred, featuredFlights: Array(6).fill(hundred.featuredFlights[0]) }).success, false);
});

test("worst-case opaque selection handles trim only non-Featured tail within both public envelopes", () => {
  const source = collection(Array.from({ length: 125 }, (_, i) => observation(i + 1)));
  const view = buildNearbyView(source, chicago, NOW, { limit: 5 });
  const selections = new Map(view.radar.map((target, index) => [target.radarId, {
    state: "unresolved" as const, token: `${String(index).padStart(3, "0")}${"A".repeat(40)}`,
    expiresAt: iso(NOW + 60_000), flightInstanceId: null,
  }]));
  const value = serializeNearbyResponse({ health: "ok", view }, chicago, NOW, selections);
  assert.ok(value.radarTargets.length > value.featuredFlights.length);
  assert.ok(value.radarTargets.length <= 100);
  assert.ok(publicNearbyResponseBytes(value) <= PUBLIC_NEARBY_PAYLOAD_BYTES);
  assert.ok(publicNearbyResponseBytes(value.radarTargets) <= PUBLIC_RADAR_PAYLOAD_BYTES);
  const retained = new Set(value.radarTargets.map(target => target.radarId));
  for (const featured of value.featuredFlights) assert.ok(retained.has(featured.radarId));
});

test("Explicit allowlists omit private engine/session/provider/selection fields without mutating the source", () => {
  const original = collection([observation(1)]);
  const view = buildNearbyView(original, chicago, NOW);
  Object.assign(view, { providerEndpoint: "PRIVATE-ENDPOINT", routeCacheKey: "PRIVATE-CACHE", dbRowId: "PRIVATE-ROW", occurrenceId: "PRIVATE-OCCURRENCE" });
  Object.assign(view.radar[0]!, { sessionKey: "PRIVATE-SESSION", selectionToken: "PRIVATE-TOKEN", providerId: "PRIVATE-ID", rawProviderPayload: { secret: true } });
  const before = structuredClone(view);
  const value = serializeNearbyResponse({ health: "ok", view }, chicago, NOW);
  assert.deepEqual(view, before);
  const json = JSON.stringify(value);
  for (const excluded of ["PRIVATE-", "privateAircraftIdentity", "sessionKey", "phaseEvidence", "provenance", "provider", "routeCacheKey", "dbRowId", "occurrenceId", "datedBinding", "collectionKey", "viewKey", "fencingGeneration", "ranked", "stability", "registration"])
    assert.equal(json.includes(excluded), false, excluded);
  for (const field of ["providerId", "rawProviderPayload", "phaseEvidence", "sessionKey", "selectionToken"])
    assert.equal(InboundNearbyResponseSchema.safeParse({ ...value, radarTargets: [{ ...value.radarTargets[0], [field]: "forbidden" }] }).success, false);
  assert.equal(InboundNearbyResponseSchema.safeParse({ ...value, constructionBudget: {} }).success, false);
  assert.equal(InboundNearbyResponseSchema.safeParse({ ...value, featuredFlights: [{ ...value.featuredFlights[0], route: { ...value.featuredFlights[0]!.route, providerUrl: "forbidden" } }] }).success, false);
});

test("Registration fallback never crosses the new public display boundary", () => {
  const view = buildNearbyView(collection([observation(1, { observedCallsign: null, registration: "N12345" })]), chicago, NOW);
  assert.equal(view.featured[0]!.displayIdent, "N12345");
  const value = serializeNearbyResponse({ health: "ok", view }, chicago, NOW);
  assert.equal(value.radarTargets[0]!.displayIdent, "AIRCRAFT"); assert.equal(value.featuredFlights[0]!.displayIdent, "AIRCRAFT");
  assert.equal(JSON.stringify(value).includes("N12345"), false);
});

test("Accepted track/null and projected-position guard survive serialization; phase is not reinvented", () => {
  const observations = [observation(1), observation(2, { groundTrackDeg: null }), observation(3, { positionKind: "extrapolated" })];
  const view = buildNearbyView(collection(observations), chicago, NOW);
  const value = serializeNearbyResponse({ health: "ok", view }, chicago, NOW);
  for (const source of view.radar) {
    const target = value.radarTargets.find(target => target.radarId === source.radarId)!;
    assert.equal(target.latitude, source.latitude); assert.equal(target.longitude, source.longitude);
    assert.equal(target.observedAt, source.observedAt); assert.equal(target.groundTrackDeg, source.groundTrackDeg);
    assert.deepEqual(target.motion, source.motion); assert.deepEqual(target.freshness, source.freshness);
  }
  const missing = value.radarTargets.find(target => target.radarId === id(10002))!;
  assert.equal(missing.groundTrackDeg, null);
  const projected = value.radarTargets.find(target => target.radarId === id(10003))!;
  assert.equal(projected.positionKind, "extrapolated");
  assert.equal(deriveNearbyDisplayPosition({ ...projected, acceptedPosition: true, onGround: false }, NOW + 20000)!.extrapolatedSeconds, 0);
});

test("Public accepted fixes reuse certified 25-second motion and stale ages stop", () => {
  const target = response().radarTargets[0]!;
  const anchor = { ...target, acceptedPosition: true, onGround: false };
  const before = structuredClone(target);
  assert.equal(deriveNearbyDisplayPosition(anchor, NOW + 20000)!.extrapolatedSeconds, 25);
  assert.equal(deriveNearbyDisplayPosition(anchor, NOW + 60000)!.extrapolatedSeconds, 25);
  assert.equal(deriveNearbyDisplayPosition(anchor, NOW + 60000)!.stopped, true);
  assert.deepEqual(target, before);
  const shared = collection([observation(1)]);
  const view = buildNearbyView({ ...shared, lastAttemptFailed: true }, chicago, NOW + 60000);
  const stale = serializeNearbyResponse({ health: "stale", view }, chicago, NOW + 60000);
  assert.equal(stale.radarTargets[0]!.freshness.ageSeconds, 65); assert.equal(stale.radarTargets[0]!.freshness.state, "stale");
  assert.equal(stale.radarTargets[0]!.latitude, shared.observations[0]!.latitude);
});

test("Unknown and generic routes never become confirmed; only current accepted dated evidence does", () => {
  const route = { originIata: "ORD", destinationIata: "BOS", verification: "confirmed" as const, checkedAt: iso() };
  const bound = { sessionKey: "PRIVATE-SESSION-3", observedCallsign: "TEST3", serviceDate: "2030-01-15", confirmedAt: iso() };
  const observations = [observation(1), observation(2, { route }), observation(3, { route, datedBinding: bound }),
    observation(4, { route: { ...route, verification: "hint" } })];
  const view = buildNearbyView(collection(observations), chicago, NOW);
  const value = serializeNearbyResponse({ health: "ok", view }, chicago, NOW);
  const byIdent = new Map(value.featuredFlights.map(flight => [flight.displayIdent, flight]));
  assert.equal(byIdent.get("TEST1")!.route.verification, "unknown");
  assert.equal(byIdent.get("TEST2")!.route.verification, "hint");
  assert.equal(byIdent.get("TEST3")!.route.verification, "confirmed");
  assert.equal(byIdent.get("TEST4")!.route.verification, "hint");
  // A later serialization reuses the existing rule instead of trusting an old ranked row.
  const futureView = buildNearbyView({ ...collection([observation(3, { route, datedBinding: bound, observedAt: iso(NOW + 2000) })]), acceptedSnapshotAtMs: NOW + 2000 }, chicago, NOW + 2000);
  const late = serializeNearbyResponse({ health: "stale", view: futureView }, chicago, NOW + 120001);
  assert.equal(late.featuredFlights[0]!.route.verification, "hint");
  const mismatch = { ...bound, observedCallsign: "TEST999" };
  const mismatchedView = buildNearbyView(collection([observation(3, { route, datedBinding: mismatch })]), chicago, NOW);
  assert.equal(serializeNearbyResponse({ health: "ok", view: mismatchedView }, chicago, NOW).featuredFlights[0]!.route.verification, "hint");
});

test("Public response measures full UTF-8 JSON including Unicode and punctuation", () => {
  const value = { ...response(), status: "Invented aircraft — 航空 ✈ (test), 'quoted'." };
  assert.ok(publicNearbyResponseBytes(value) > JSON.stringify(value).length);
  assert.equal(publicNearbyResponseBytes(value), Buffer.byteLength(JSON.stringify(value), "utf8"));
  assert.equal(InboundNearbyResponseSchema.safeParse(value).success, true);
  const enormous = { ...value, status: "航空".repeat(PUBLIC_NEARBY_PAYLOAD_BYTES) };
  const parsed = InboundNearbyResponseSchema.safeParse(enormous);
  assert.equal(parsed.success, false);
  if (!parsed.success) assert.ok(parsed.error.issues.some(issue => issue.message.includes("64 KiB")));
});

test("Strict public input supports only three areas, fixed radii, and one-to-five Featured limit", () => {
  for (const area of ["preset:chicago", "airport:KORD", "airport:KMDW"]) for (const radiusNm of [12, 25, 38])
    assert.equal(NearbyTransportRequestSchema.safeParse({ area, radiusNm, limit: 5 }).success, true);
  for (const invalid of [{ area: "airport:KJFK" }, { area: "ORD" }, { area: "preset:chicago", radiusNm: 10 },
    { area: "preset:chicago", limit: 6 }, { area: "preset:chicago", limit: 0 }, { area: "preset:chicago", limit: 1.5 },
    { area: "preset:chicago", latitude: 41.9 }, {}, { area: "preset:chicago", userId: "private" }])
    assert.equal(NearbyTransportRequestSchema.safeParse(invalid).success, false);
});

test("Chicago ORD and MDW change their public geometry while preserving collection version", () => {
  const shared = collection([observation(1), observation(2)]);
  const values = ["preset:chicago", "airport:KORD", "airport:KMDW"].map(id => {
    const area = areaDefinition(id as ResolvedAreaV1["id"]);
    return serializeNearbyResponse({ health: "ok", view: buildNearbyView(shared, area, NOW) }, area, NOW);
  });
  assert.deepEqual(values.map(value => value.collectionVersion), [7, 7, 7]);
  assert.notEqual(values[0]!.featuredFlights[0]!.distanceNm, values[1]!.featuredFlights[0]!.distanceNm);
  assert.notEqual(values[1]!.area.reference.latitude, values[2]!.area.reference.latitude);
  assert.throws(() => serializeNearbyResponse({ health: "ok", view: buildNearbyView(shared, chicago, NOW) }, areaDefinition("airport:KORD"), NOW), RangeError);
  assert.throws(() => serializeNearbyResponse({ health: "ok", view: buildNearbyView(shared, chicago, NOW) },
    { ...chicago, reference: { ...chicago.reference, latitude: 0 } }, NOW));
});

test("Health states explain lost coverage without depicting unavailable as empty sky", () => {
  const view = buildNearbyView(collection([observation(1)]), chicago, NOW);
  for (const health of ["ok", "partial", "stale"] as const) {
    const value = serializeNearbyResponse({ health, view }, chicago, NOW);
    assert.equal(value.health, health); assert.equal(value.radarTargets.length, 1);
    assert.equal(Boolean(value.warning), health !== "ok");
  }
  for (const health of ["ok", "unavailable"] as const) {
    const unavailable = serializeNearbyResponse({ health, view: null }, chicago, NOW);
    assert.equal(unavailable.health, "unavailable"); assert.equal(unavailable.collectionVersion, null);
    assert.equal(unavailable.radarTargets.length, 0); assert.equal(unavailable.featuredFlights.length, 0);
    assert.match(unavailable.status!, /unavailable/); assert.ok(unavailable.warning);
  }
  const empty = serializeNearbyResponse({ health: "ok", view: buildNearbyView(collection([]), chicago, NOW) }, chicago, NOW);
  assert.equal(empty.health, "ok"); assert.equal(empty.collectionVersion, 7); assert.equal(empty.warning, undefined);
  assert.throws(() => serializeNearbyResponse({ health: "ok", view }, chicago, NaN), RangeError);
});

test("Strict schema rejects invalid telemetry, invented future age, duplicates and private nested data", () => {
  const value = response(); const target = value.radarTargets[0]!;
  for (const patch of [{ latitude: 100 }, { longitude: -181 }, { groundTrackDeg: 360 }, { groundTrackDeg: NaN },
    { positionKind: "synthetic" }, { observedAt: "invalid" }, { motion: { ...target.motion, label: "Invented" } },
    { freshness: { ageSeconds: 5, state: "stale" } }, { motion: { ...target.motion, phaseEvidence: [] } }])
    assert.equal(PublicRadarTargetSchema.safeParse({ ...target, ...patch }).success, false);
  assert.equal(InboundNearbyResponseSchema.safeParse({ ...value, radarTargets: [target, target] }).success, false);
  assert.equal(InboundNearbyResponseSchema.safeParse({ ...value, radarTargets: [{ ...target, observedAt: iso(NOW + 2000), freshness: { ageSeconds: 0, state: "fresh" } }] }).success, false);
  assert.equal(InboundNearbyResponseSchema.safeParse({ ...value, radarTargets: [{ ...target, latitude: 0 }] }).success, false);
  assert.equal(InboundNearbyResponseSchema.safeParse({ ...value, featuredFlights: [{ ...value.featuredFlights[0], route: { originIata: "ORD", destinationIata: "BOS", verification: "unknown", checkedAt: iso() } }] }).success, false);
  assert.equal(InboundNearbyResponseSchema.safeParse({ ...value, featuredFlights: [{ ...value.featuredFlights[0], airlineName: "https://provider.invalid" }] }).success, false);
});

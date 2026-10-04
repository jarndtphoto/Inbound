import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { destPoint } from "../geo";
import { areaDefinition, CHICAGO_COLLECTION } from "../plugin-v1/areas";
import { FIXTURE_NOW } from "../plugin-v1/fixtures";
import { currentRoute, rankNearbyCandidates } from "../plugin-v1/ranking";
import { INCUMBENT_HOLD_MS, REPLACEMENT_MARGIN, updateStableView, type NearbyStabilityState } from "../plugin-v1/stability";
import { NEARBY_POLICY, type AcceptedNearbyObservation, type SharedCollection } from "./model";
import { deriveNearbyDisplayPosition } from "./motion";
import { applyRouteHints, createRouteEnrichmentService, featuredRouteDisplay, routeEnrichmentPool } from "./route-enrichment";
import { ROUTE_HINT_POLICY, routeHintFromLookup, routeHintUsable, type NearbyRouteHint, type NearbyRouteHintLease, type NearbyRouteHintStore } from "./route-hints";
import { buildNearbyView } from "./views";

const NOW = Date.parse(FIXTURE_NOW);
const area = areaDefinition("preset:chicago");
const id = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const iso = (at: number) => new Date(at).toISOString();
const unknown = () => ({ originIata: null, destinationIata: null, verification: "unknown" as const, checkedAt: null });
function observation(index: number, overrides: Partial<AcceptedNearbyObservation> = {}): AcceptedNearbyObservation {
  const point = destPoint({ lat: area.reference.latitude, lon: area.reference.longitude }, 90, 1 + index / 10);
  return {
    cardId: id(index), radarId: id(index + 10_000), privateAircraftIdentity: `invented-aircraft-${index}`, sessionKey: `invented-session-${index}`,
    observedCallsign: `UAL${index}`, registration: null, latitude: point.lat, longitude: point.lon, altitudeFt: 20_000,
    groundspeedKt: 240, groundTrackDeg: 90, verticalRateFpm: 0, onGround: false, observedAt: iso(NOW),
    positionKind: "observed", acceptedPosition: true, identityConflict: false, typeCode: "B738", category: null, operator: "Invented Air",
    interesting: false, route: unknown(), datedBinding: null, freshness: { ageSeconds: 0, state: "fresh" },
    provenance: { source: "private-invented-telemetry", receivedAt: iso(NOW), positionAgeSeconds: 0, acceptance: "inbound-fusion" },
    ...overrides,
  };
}
function collection(observations: AcceptedNearbyObservation[], overrides: Partial<SharedCollection> = {}): SharedCollection {
  return {
    collectionKey: CHICAGO_COLLECTION.id, collectionVersion: 1, acceptedSnapshotAtMs: NOW, observations,
    metadata: { providerCalls: 0, rawCount: observations.length, fusedCount: observations.length, rejectedCount: 0, successfulProviders: 1, failedProviders: 0 },
    partial: false, lastAttemptFailed: false, leaseOwner: null, leaseUntilMs: null, fencingGeneration: 1,
    nextAttemptAtMs: NOW + NEARBY_POLICY.cadenceMs, failureBackoffSeconds: 0, activeUntilMs: NOW + NEARBY_POLICY.activeForMs,
    inactiveExpiresAtMs: NOW + NEARBY_POLICY.inactiveRetentionMs, ...overrides,
  };
}
function positive(observedCallsign: string, at = NOW, overrides: Partial<NearbyRouteHint> = {}): NearbyRouteHint {
  return { ...routeHintFromLookup({ observedCallsign, originIata: "SEA", destinationIata: "ORD", airlineLabel: "Invented Air",
    outcome: "positive", sourceClass: "private_fake_route", verification: "hint" }, at), ...overrides };
}
function negative(observedCallsign: string, at = NOW): NearbyRouteHint {
  return routeHintFromLookup({ observedCallsign, originIata: null, destinationIata: null, airlineLabel: null,
    outcome: "negative", sourceClass: "private_fake_route", verification: "unknown" }, at);
}
function confirmed(o: AcceptedNearbyObservation, overrides: Partial<AcceptedNearbyObservation> = {}): AcceptedNearbyObservation {
  return { ...o, route: { originIata: "SEA", destinationIata: "ORD", verification: "confirmed", checkedAt: iso(NOW) },
    datedBinding: { sessionKey: o.sessionKey, observedCallsign: o.observedCallsign!, serviceDate: "2030-01-15", confirmedAt: iso(NOW) }, ...overrides };
}
const input = (shared: SharedCollection, nowMs = NOW, previousStability?: NearbyStabilityState | null) => ({ collection: shared, area, nowMs, previousStability });

test("Route-neutral construction selects twelve eligible aircraft and retains all five current incumbents", () => {
  const observations = Array.from({ length: 25 }, (_, i) => observation(i + 1));
  const shared = collection(observations);
  const first = routeEnrichmentPool(input(shared));
  assert.equal(first.length, 12);
  const prior: NearbyStabilityState = { viewKey: "preset:chicago:38:ranking-v1", collectionVersion: 1,
    slots: observations.slice(20).map(o => ({ cardId: o.cardId, pickedAtMs: NOW })), inactiveExpiresAtMs: NOW + 3_600_000 };
  const pool = routeEnrichmentPool(input(shared, NOW, prior));
  assert.equal(pool.length, 12);
  assert.deepEqual(pool.slice(0, 5).map(o => o.cardId), observations.slice(20).map(o => o.cardId));
  assert.deepEqual(pool.slice(5).map(o => o.cardId), first.slice(0, 7).map(o => o.cardId));
  assert.equal(new Set(pool.map(o => o.cardId)).size, 12);
  assert.equal(ROUTE_HINT_POLICY.enrichmentPool, 12);
});

test("Enrichment pool ignores existing route weights and excludes old, conflicting and ineligible observations", () => {
  const observations = Array.from({ length: 16 }, (_, i) => observation(i + 1));
  const ordinary = routeEnrichmentPool(input(collection(observations))).map(o => o.cardId);
  const routed = observations.map((o, i) => i >= 12 ? confirmed(o) : o);
  assert.deepEqual(routeEnrichmentPool(input(collection(routed))).map(o => o.cardId), ordinary);
  const invalid = [observation(50, { onGround: true }), observation(51, { identityConflict: true }), observation(52, { observedAt: iso(NOW - 121_000) })];
  assert.deepEqual(routeEnrichmentPool(input(collection([observations[0], ...invalid]))).map(o => o.cardId), [observations[0].cardId]);
  for (const overrides of [{ collectionVersion: 0 }, { acceptedSnapshotAtMs: null }, { acceptedSnapshotAtMs: NOW + 1001 }, { acceptedSnapshotAtMs: NOW - 120001 }]) {
    assert.deepEqual(routeEnrichmentPool(input(collection(observations, overrides))), []);
  }
  assert.deepEqual(routeEnrichmentPool(input(collection(observations), NaN)), []);
});

test("Positive cache overlays private copies only while negative, malformed and expired hints leave routes unknown", () => {
  const source = collection([observation(1), observation(2), observation(3), observation(4)]);
  const before = structuredClone(source);
  const overlaid = applyRouteHints(input(source), [positive("UAL1"), negative("UAL2"),
    positive("UAL3", NOW - ROUTE_HINT_POLICY.positiveTtlMs), positive("UAL4", NOW, { destinationIata: "BAD1" })]);
  assert.equal(overlaid.observations[0].route.verification, "hint");
  assert.deepEqual(overlaid.observations[0].route, { originIata: "SEA", destinationIata: "ORD", verification: "hint", checkedAt: iso(NOW) });
  assert.equal(overlaid.observations[0].datedBinding, null);
  assert.deepEqual(overlaid.observations.slice(1).map(o => o.route.verification), ["unknown", "unknown", "unknown"]);
  assert.deepEqual(source, before);
  assert.equal(overlaid.collectionVersion, source.collectionVersion);
  assert.equal(overlaid.acceptedSnapshotAtMs, source.acceptedSnapshotAtMs);
});

test("Only the bounded pool receives cache overlays; unknown routes remain eligible and populate Radar", () => {
  const shared = collection(Array.from({ length: 125 }, (_, i) => observation(i + 1)));
  const overlay = applyRouteHints(input(shared), shared.observations.map(o => positive(o.observedCallsign!)));
  assert.equal(overlay.observations.filter(o => o.route.verification === "hint").length, 12);
  const view = buildNearbyView(overlay, area, NOW);
  assert.equal(view.ranked.length, 125);
  assert.equal(view.radar.length, 100);
  assert.equal(view.featured.length, 4);
  assert.equal(buildNearbyView(overlay, area, NOW, { limit: 5 }).featured.length, 5);
  assert.ok(new TextEncoder().encode(JSON.stringify(view.radar)).length <= NEARBY_POLICY.maxRadarBytes);
  assert.ok(rankNearbyCandidates([observation(126)], area, NOW).length, "unknown route alone never disqualifies a valid aircraft");
});

test("Generic hint expiry is logical; a fresh telemetry snapshot needs fresh evidence after expiry", () => {
  const hint = positive("UAL1");
  const beforeExpiry = NOW + ROUTE_HINT_POLICY.positiveTtlMs - 1;
  const fresh = collection([observation(1, { observedAt: iso(beforeExpiry) })], { acceptedSnapshotAtMs: beforeExpiry });
  assert.equal(applyRouteHints(input(fresh, beforeExpiry), [hint]).observations[0].route.verification, "hint");
  const expiredAt = beforeExpiry + 1;
  const next = collection([observation(1, { observedAt: iso(expiredAt) })], { acceptedSnapshotAtMs: expiredAt, collectionVersion: 2 });
  assert.equal(applyRouteHints(input(next, expiredAt), [hint]).observations[0].route.verification, "unknown");
});

test("Existing Inbound confirmed or hint evidence wins a route disagreement without mutation", () => {
  const inboundConfirmed = confirmed(observation(1));
  const inboundHint = observation(2, { route: { originIata: "MSP", destinationIata: "MDW", verification: "hint", checkedAt: iso(NOW) } });
  const shared = collection([inboundConfirmed, inboundHint]);
  const disagreement = [positive("UAL1", NOW, { originIata: "LAX", destinationIata: "JFK" }), positive("UAL2")];
  const result = applyRouteHints(input(shared), disagreement);
  assert.deepEqual(result.observations, shared.observations);
  assert.equal(currentRoute(result.observations[0], NOW).verification, "confirmed");
  assert.equal(currentRoute(result.observations[1], NOW).verification, "hint");
});

test("Confirmed routes require every existing dated identity and freshness binding", () => {
  const o = confirmed(observation(1));
  assert.equal(currentRoute(o, NOW).verification, "confirmed");
  const invalidBindings = [null, { ...o.datedBinding!, sessionKey: "other-session" }, { ...o.datedBinding!, observedCallsign: "DAL1" },
    { ...o.datedBinding!, serviceDate: "2030-02-31" }, { ...o.datedBinding!, confirmedAt: "not-a-date" },
    { ...o.datedBinding!, confirmedAt: iso(NOW - 120001) }, { ...o.datedBinding!, confirmedAt: iso(NOW + 1001) }];
  for (const datedBinding of invalidBindings) assert.equal(currentRoute({ ...o, datedBinding }, NOW).verification, "hint");
  assert.equal(currentRoute({ ...o, route: { ...o.route, checkedAt: iso(NOW + 1001) } }, NOW).verification, "unknown");
  assert.equal(currentRoute({ ...o, route: { ...o.route, originIata: null, destinationIata: null } }, NOW).verification, "unknown");
  const generic = applyRouteHints(input(collection([observation(1)])), [positive("UAL1")]).observations[0];
  assert.equal(currentRoute(generic, NOW).verification, "hint");
  assert.equal(generic.datedBinding, null);
});

test("Callsign or session changes do not inherit cached aliases or confirmed dated bindings", () => {
  const operating = observation(1, { observedCallsign: "EDV123" });
  const marketing = { ...operating, observedCallsign: "DAL123" };
  const oldHint = positive("EDV123");
  assert.equal(applyRouteHints(input(collection([marketing])), [oldHint]).observations[0].route.verification, "unknown");
  const changedView = buildNearbyView(applyRouteHints(input(collection([marketing])), [oldHint]), area, NOW);
  assert.equal(changedView.radar[0].radarId, operating.radarId);
  assert.equal(changedView.radar[0].displayIdent, "DAL123");
  assert.equal(applyRouteHints(input(collection([marketing])), [positive("DAL123")]).observations[0].route.verification, "hint");
  assert.equal(applyRouteHints(input(collection([operating])), [positive("DAL123")]).observations[0].route.verification, "unknown");
  const bound = confirmed(operating);
  assert.equal(currentRoute({ ...bound, observedCallsign: "DAL123" }, NOW).verification, "hint");
  assert.equal(currentRoute({ ...bound, sessionKey: "new-aircraft-session" }, NOW).verification, "hint");
});

test("Existing hint and confirmed weights are exactly five/fifteen with association only for confirmation", () => {
  const o = observation(1, { latitude: area.reference.latitude, longitude: area.reference.longitude, altitudeFt: 30_000, verticalRateFpm: 0 });
  const score = (candidate: AcceptedNearbyObservation) => rankNearbyCandidates([candidate], area, NOW)[0];
  const neutral = score(o);
  const generic = score({ ...o, route: { originIata: "SEA", destinationIata: "ORD", verification: "hint", checkedAt: iso(NOW) } });
  const confirmedUnassociated = score(confirmed(o, { route: { originIata: "SEA", destinationIata: "LAX", verification: "confirmed", checkedAt: iso(NOW) } }));
  const confirmedAssociated = score(confirmed(o));
  assert.equal(generic.score - neutral.score, 5);
  assert.equal(confirmedUnassociated.score - neutral.score, 15);
  assert.equal(confirmedAssociated.score - confirmedUnassociated.score, 5);
  assert.equal(new Set([neutral, generic, confirmedUnassociated, confirmedAssociated].map(r => r.motion.phase)).size, 1,
    "high-altitude level telemetry isolates existing route/association weights from phase scoring");
});

test("Route transitions use the existing five-slot board, ninety-second hold and twenty-point margin", () => {
  assert.equal(INCUMBENT_HOLD_MS, 90_000);
  assert.equal(REPLACEMENT_MARGIN, 20);
  const ranked = rankNearbyCandidates(Array.from({ length: 8 }, (_, i) => observation(i + 1)), area, NOW);
  const seed = updateStableView(null, { viewKey: "test-view", collectionVersion: 1, nowMs: NOW, successfulCollection: true, ranked })!;
  assert.equal(seed.slots.length, 5);
  const challengerId = ranked[5].candidate.cardId;
  const routeBoost = ranked.map(r => ({ ...r, score: r.score + (r.candidate.cardId === challengerId ? 5 : 0) }));
  const hinted = updateStableView(seed, { viewKey: "test-view", collectionVersion: 2, nowMs: NOW + 90_000, successfulCollection: true, ranked: routeBoost })!;
  assert.deepEqual(hinted.slots, seed.slots, "an isolated generic-hint bonus cannot clear the replacement margin");
  const confirmedBoost = ranked.map(r => ({ ...r, score: r.score + (r.candidate.cardId === challengerId ? 20 : 0) }));
  const held = updateStableView(seed, { viewKey: "test-view", collectionVersion: 2, nowMs: NOW + 89_999, successfulCollection: true, ranked: confirmedBoost })!;
  assert.deepEqual(held.slots, seed.slots);
  const replaced = updateStableView(seed, { viewKey: "test-view", collectionVersion: 2, nowMs: NOW + 90_000, successfulCollection: true, ranked: confirmedBoost })!;
  assert.ok(replaced.slots.some(s => s.cardId === challengerId));
  assert.equal(replaced.slots.filter(s => !seed.slots.some(old => old.cardId === s.cardId)).length, 1);
  const sameVersion = updateStableView(replaced, { viewKey: "test-view", collectionVersion: 2, nowMs: NOW + 110_000,
    successfulCollection: true, ranked: [...confirmedBoost].reverse() })!;
  assert.deepEqual(sameVersion.slots, replaced.slots, "cache changes alone do not advance the accepted collection board");
  const outage = updateStableView(replaced, { viewKey: "test-view", collectionVersion: 3, nowMs: NOW + 120_000,
    successfulCollection: false, ranked: routeBoost })!;
  assert.deepEqual(outage.slots, replaced.slots);
});

test("At most one competitive replacement and deterministic ties survive concurrent-route score transitions", () => {
  const ranked = rankNearbyCandidates(Array.from({ length: 9 }, (_, i) => observation(i + 1)), area, NOW);
  const previous = updateStableView(null, { viewKey: "test-view", collectionVersion: 1, nowMs: NOW, successfulCollection: true, ranked })!;
  const boosted = ranked.map((r, i) => ({ ...r, score: i >= 5 ? 200 : 50 }));
  const update = (rows = boosted) => updateStableView(previous, { viewKey: "test-view", collectionVersion: 2,
    nowMs: NOW + 90_000, successfulCollection: true, ranked: rows })!;
  const first = update();
  assert.equal(first.slots.filter(s => !previous.slots.some(old => old.cardId === s.cardId)).length, 1);
  assert.deepEqual(update([...boosted].reverse()).slots, first.slots);
  const expiredHints = updateStableView(first, { viewKey: "test-view", collectionVersion: 3, nowMs: NOW + 110_000,
    successfulCollection: true, ranked })!;
  assert.equal(expiredHints.slots.length, 5);
  assert.ok(expiredHints.slots.some(s => s.cardId === first.slots.find(s => s.pickedAtMs === NOW + 90_000)!.cardId),
    "a newly selected incumbent is held even when route evidence disappears");
});

test("Featured route display uses only safe route fields and an optional matching generic airline label", () => {
  const hint = positive("UAL1");
  const overlaid = applyRouteHints(input(collection([observation(1)])), [hint]);
  const row = rankNearbyCandidates(overlaid.observations, area, NOW)[0];
  const dto = featuredRouteDisplay(row, hint, NOW);
  assert.deepEqual(dto, { originIata: "SEA", destinationIata: "ORD", verification: "hint", checkedAt: iso(NOW), airlineLabel: "Invented Air" });
  assert.deepEqual(Object.keys(dto).sort(), ["airlineLabel", "checkedAt", "destinationIata", "originIata", "verification"]);
  for (const other of [positive("UAL2"), positive("UAL1", NOW, { destinationIata: "JFK" }), negative("UAL1"),
    positive("UAL1", NOW - ROUTE_HINT_POLICY.positiveTtlMs)]) assert.equal(featuredRouteDisplay(row, other, NOW).airlineLabel, undefined);
  const boundRow = rankNearbyCandidates([confirmed(observation(1))], area, NOW)[0];
  assert.equal(featuredRouteDisplay(boundRow, hint, NOW).airlineLabel, undefined);
  const encoded = JSON.stringify(dto);
  for (const privateField of [hint.sourceClass, row.candidate.sessionKey, row.candidate.privateAircraftIdentity, "observedCallsign", "expiresAt", "sourceClass", "budget", "lease", "flightInstanceId"]) {
    assert.equal(encoded.includes(privateField), false, privateField);
  }
});

test("Enriched Radar retains accepted track, excludes all private route/evidence fields and stops motion at twenty-five seconds", () => {
  const o = observation(1, { phaseEvidence: [[NOW / 1000 - 40, 20000, 0, false, 41.9, -87.8]] });
  const shared = applyRouteHints(input(collection([o])), [positive("UAL1")]);
  const radar = buildNearbyView(shared, area, NOW).radar[0];
  assert.equal(radar.groundTrackDeg, 90);
  assert.equal(radar.observedAt, o.observedAt);
  const encoded = JSON.stringify(radar);
  for (const privateField of [o.sessionKey, o.privateAircraftIdentity, o.provenance.source, "phaseEvidence", "datedBinding", "route", "sourceClass", "cacheKey", "budget", "cardId"]) {
    assert.equal(encoded.includes(privateField), false, privateField);
  }
  const atLimit = deriveNearbyDisplayPosition(o, NOW + 25_000)!;
  assert.equal(atLimit.extrapolatedSeconds, 25);
  assert.equal(atLimit.stopped, true);
  assert.deepEqual(deriveNearbyDisplayPosition(o, NOW + 30_000), { ...atLimit, freshness: { ageSeconds: 30, state: "fresh" } });
  const noTrack = { ...o, groundTrackDeg: null };
  assert.equal(deriveNearbyDisplayPosition(noTrack, NOW + 10_000)!.kind, "accepted");
  assert.equal(buildNearbyView(collection([noTrack]), area, NOW).radar[0].groundTrackDeg, null);
});

function memoryStore(initial: NearbyRouteHint[] = []) {
  const cache = new Map(initial.map(h => [h.observedCallsign, h]));
  const leases = new Map<string, NearbyRouteHintLease>();
  let claims = 0, failures = 0;
  const store: NearbyRouteHintStore = {
    async read(keys, at) { return keys.flatMap(key => { const hint = cache.get(key); return hint && routeHintUsable(hint, at) ? [hint] : []; }); },
    async claim(request) {
      claims++;
      if (leases.has(request.observedCallsign)) return null;
      const lease = { observedCallsign: request.observedCallsign, owner: request.owner, generation: 1,
        claimedAtMs: request.nowMs, leaseUntilMs: request.nowMs + ROUTE_HINT_POLICY.leaseMs };
      leases.set(lease.observedCallsign, lease); return lease;
    },
    async publish(lease, hint) { cache.set(lease.observedCallsign, hint); leases.delete(lease.observedCallsign); return true; },
    async fail(lease, at) { failures++; cache.set(lease.observedCallsign, negative(lease.observedCallsign, at)); leases.delete(lease.observedCallsign); return true; },
    async cleanup() { return { hints: 0, budgets: 0 }; },
  };
  return { store, cache, counters: () => ({ claims, failures }) };
}

test("Viewer cache reads never call a fake provider; explicit construction consumes at most two missing keys", async () => {
  const memory = memoryStore([positive("UAL1"), negative("UAL2")]);
  let lookups = 0;
  const service = createRouteEnrichmentService({ store: memory.store, clock: () => NOW, leaseOwner: randomUUID,
    lookup: async observedCallsign => { lookups++; const { checkedAt: _checked, expiresAt: _expires, ...result } = positive(observedCallsign); return result; } });
  const shared = collection(Array.from({ length: 20 }, (_, i) => observation(i + 1)));
  for (let i = 0; i < 3; i++) await service.read(input(shared));
  assert.equal(lookups, 0);
  assert.equal(memory.counters().claims, 0);
  const result = await service.construct(input(shared));
  assert.deepEqual(result, { poolSize: 12, cacheHits: 2, lookupsStarted: 2, published: 2, failed: 0 });
  assert.equal(lookups, 2);
  const before = structuredClone(shared);
  const read = await service.read(input(shared));
  assert.equal(read.observations.filter(o => o.route.verification === "hint").length, 3);
  assert.deepEqual(shared, before);
});

test("Lookup failures and wrong callsigns publish negative retry protection without removing accepted aircraft", async () => {
  const memory = memoryStore();
  const requested: string[] = [];
  const service = createRouteEnrichmentService({ store: memory.store, clock: () => NOW,
    lookup: async observedCallsign => {
      requested.push(observedCallsign);
      if (requested.length === 1) throw new Error("invented route outage");
      const { checkedAt: _checked, expiresAt: _expires, ...result } = positive("DAL999"); return result;
    } });
  const shared = collection([observation(1), observation(2)]);
  assert.deepEqual(await service.construct(input(shared)), { poolSize: 2, cacheHits: 0, lookupsStarted: 2, published: 0, failed: 2 });
  assert.equal(memory.counters().failures, 2);
  assert.deepEqual(await service.construct(input(shared)), { poolSize: 2, cacheHits: 2, lookupsStarted: 0, published: 0, failed: 0 });
  assert.equal(requested.length, 2);
  const read = await service.read(input(shared));
  assert.deepEqual(read.observations, shared.observations);
  assert.equal(buildNearbyView(read, area, NOW).radar.length, 2);
  assert.equal(buildNearbyView(read, area, NOW).featured.length, 2);
});

test("Cache outage and stale or failed aircraft snapshots do no provider work", async () => {
  let lookups = 0, claims = 0;
  const memory = memoryStore();
  const store = { ...memory.store, read: async () => { throw new Error("invented cache outage"); },
    claim: async () => { claims++; return null; } };
  const service = createRouteEnrichmentService({ store, clock: () => NOW,
    lookup: async callsign => { lookups++; const { checkedAt: _checked, expiresAt: _expires, ...result } = positive(callsign); return result; } });
  const shared = collection([observation(1)]);
  assert.equal(await service.read(input(shared)), shared);
  assert.equal((await service.construct(input(shared))).lookupsStarted, 0);
  assert.equal((await service.construct(input({ ...shared, lastAttemptFailed: true }))).lookupsStarted, 0);
  assert.equal((await service.construct(input(shared, NOW + 45_001))).lookupsStarted, 0);
  assert.equal(lookups, 0); assert.equal(claims, 0);
});

test("Negative expiry can become a positive hint, then accepted dated confirmation, while the incumbent board stays stable", async () => {
  let at = NOW, lookups = 0;
  const memory = memoryStore([negative("UAL1")]);
  const service = createRouteEnrichmentService({ store: memory.store, clock: () => at,
    lookup: async key => { lookups++; const { checkedAt: _checked, expiresAt: _expires, ...result } = positive(key, at); return result; } });
  const first = collection([observation(1), observation(2, { route: { originIata: "LAX", destinationIata: "JFK", verification: "hint", checkedAt: iso(NOW) } })]);
  const seeded = buildNearbyView(await service.read(input(first)), area, at);
  assert.equal(seeded.ranked.find(row => row.candidate.observedCallsign === "UAL1")!.route.verification, "unknown");
  assert.equal(lookups, 0);
  at = NOW + 60_000;
  const fresh = collection(first.observations.map(o => ({ ...o, observedAt: iso(at) })), { acceptedSnapshotAtMs: at, collectionVersion: 2 });
  assert.equal((await service.construct(input(fresh, at, seeded.stability))).lookupsStarted, 1);
  assert.equal(lookups, 1);
  const hinted = buildNearbyView(await service.read(input(fresh, at, seeded.stability)), area, at, { previousStability: seeded.stability });
  assert.equal(hinted.ranked.find(row => row.candidate.observedCallsign === "UAL1")!.route.verification, "hint");
  assert.deepEqual(hinted.stability!.slots, seeded.stability!.slots);
  at += 20_000;
  const inbound = confirmed({ ...fresh.observations[0], observedAt: iso(at) });
  inbound.route.checkedAt = iso(at);
  inbound.datedBinding!.confirmedAt = iso(at);
  const dated = collection([inbound, { ...fresh.observations[1], observedAt: iso(at) }], { acceptedSnapshotAtMs: at, collectionVersion: 3 });
  const accepted = buildNearbyView(await service.read(input(dated, at, hinted.stability)), area, at, { previousStability: hinted.stability });
  assert.equal(accepted.ranked.find(row => row.candidate.observedCallsign === "UAL1")!.route.verification, "confirmed");
  assert.deepEqual(accepted.stability!.slots, seeded.stability!.slots);
  assert.equal(lookups, 1, "confirmed evidence is reused from accepted Inbound state, never resolved by a full flight-story lookup");
});

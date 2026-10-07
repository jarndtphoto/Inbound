/** Verification helper only. It opens no connection and is never an app import. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Sql } from "../../../../src/lib/db.ts";
import { areaDefinition } from "../../../../src/lib/plugin-v1/areas.ts";
import { currentRoute, rankNearbyCandidates } from "../../../../src/lib/plugin-v1/ranking.ts";
import { INCUMBENT_HOLD_MS, REPLACEMENT_MARGIN } from "../../../../src/lib/plugin-v1/stability.ts";
import { createPrivateNearbyEngine } from "../../../../src/lib/nearby-v1/engine.server.ts";
import { NEARBY_POLICY, type AcceptedNearbyObservation, type AcquisitionResult } from "../../../../src/lib/nearby-v1/model.ts";
import { deriveNearbyDisplayPosition } from "../../../../src/lib/nearby-v1/motion.ts";
import { applyRouteHints, createRouteEnrichmentService, featuredRouteDisplay, type NearbyRouteEnrichmentService } from "../../../../src/lib/nearby-v1/route-enrichment.ts";
import { createNearbyRouteHintStore } from "../../../../src/lib/nearby-v1/route-hint-store.server.ts";
import { normalizeObservedCallsign, ROUTE_HINT_POLICY, routeHintFromLookup } from "../../../../src/lib/nearby-v1/route-hints.ts";
import { createNearbyCollectionStore } from "../../../../src/lib/nearby-v1/store.server.ts";
import { buildNearbyView } from "../../../../src/lib/nearby-v1/views.ts";

type IntegrationInput = { sqlProvider: () => Promise<Sql>; environment: string; nowMs: number; connectionCount: number };
const iso = (at: number) => new Date(at).toISOString();

/**
 * Read the main 100-viewer snapshot without changing its accepted state. A
 * separately scoped mutable snapshot is published only for stored dated-route
 * probes, then its collection, board, hints and budget are cleaned up.
 */
export async function verifyRouteIntegration(options: IntegrationInput) {
  const { environment, sqlProvider, nowMs } = options;
  assert.equal(options.connectionCount, 100);
  const area = areaDefinition("preset:chicago");
  const mainStore = createNearbyCollectionStore({ environment, sqlProvider, clock: "provided" });
  const mainBefore = await mainStore.read(nowMs);
  assert.ok(mainBefore);
  assert.equal(mainBefore.observations.length, 125);
  assert.equal(mainBefore.collectionVersion, 1);
  assert.ok(mainBefore.observations.every(o => o.route.verification === "unknown"));
  const rawFour = buildNearbyView(mainBefore, area, nowMs);
  const rawFive = buildNearbyView(mainBefore, area, nowMs, { limit: 5, previousStability: rawFour.stability });
  assert.equal(rawFour.radar.length, 100);
  assert.equal(rawFour.ranked.length, 125);
  assert.equal(rawFour.featured.length, 4);
  assert.equal(rawFive.featured.length, 5);
  assert.deepEqual(rawFour.featured.map(r => r.candidate.cardId), rawFive.featured.slice(0, 4).map(r => r.candidate.cardId));
  const radarBytes = new TextEncoder().encode(JSON.stringify(rawFour.radar)).length;
  assert.ok(radarBytes <= NEARBY_POLICY.maxRadarBytes);

  let forbiddenAcquisitions = 0, fakeRouteLookups = 0, blockedReads = 0, blockedConstructions = 0;
  const forbiddenAcquire = async (): Promise<AcquisitionResult> => { forbiddenAcquisitions++; throw new Error("Integration must use stored invented telemetry only"); };
  const blockedService: NearbyRouteEnrichmentService = {
    async read() { blockedReads++; return await new Promise<never>(() => {}); },
    async construct() { blockedConstructions++; throw new Error("Integration must never launch route construction"); },
    async cleanup() { return { hints: 0, budgets: 0 }; },
  };
  const radarEngine = createPrivateNearbyEngine({ environment, store: mainStore, acquire: forbiddenAcquire,
    clock: () => nowMs, routeEnrichment: blockedService });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const immediate = await Promise.race([radarEngine.requestRadar("preset:chicago"), new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("Radar waited for blocked route work")), 10_000);
    })]);
    assert.equal(immediate.radar.length, 100);
    assert.equal(blockedReads, 0);
    assert.equal(blockedConstructions, 0);
    assert.equal(forbiddenAcquisitions, 0);
  } finally { if (deadline) clearTimeout(deadline); }

  const anchor = mainBefore.observations[0];
  assert.equal(anchor.groundTrackDeg, 90);
  const limit = deriveNearbyDisplayPosition(anchor, Date.parse(anchor.observedAt) + 25_000)!;
  const later = deriveNearbyDisplayPosition(anchor, Date.parse(anchor.observedAt) + 30_000)!;
  assert.equal(limit.extrapolatedSeconds, 25);
  assert.equal(limit.stopped, true);
  assert.equal(later.latitude, limit.latitude);
  assert.equal(later.longitude, limit.longitude);
  assert.equal(later.extrapolatedSeconds, 25);
  const noTrack = deriveNearbyDisplayPosition({ ...anchor, groundTrackDeg: null }, nowMs + 10_000)!;
  assert.equal(noTrack.kind, "accepted");
  assert.equal(noTrack.extrapolatedSeconds, 0);

  const ownEnvironment = `${environment}_integration`;
  assert.match(ownEnvironment, /^[a-zA-Z0-9_-]{1,32}$/);
  const ownStore = createNearbyCollectionStore({ environment: ownEnvironment, sqlProvider, clock: "provided" });
  const ownHints = createNearbyRouteHintStore({ environment: ownEnvironment, sqlProvider, clock: "provided" });
  const source = structuredClone(mainBefore.observations);
  // Equal geometry, type, motion and freshness isolate route weights from the
  // current phase classifier and all other existing scoring components.
  for (const o of source) {
    o.latitude = anchor.latitude; o.longitude = anchor.longitude; o.altitudeFt = 30_000;
    o.verticalRateFpm = 0; o.phaseEvidence = []; o.interesting = false; o.operator = null;
  }
  const confirmed = (o: AcceptedNearbyObservation, originIata = "SEA", destinationIata = "ORD") => {
    o.route = { originIata, destinationIata, verification: "confirmed", checkedAt: iso(nowMs) };
    o.datedBinding = { sessionKey: o.sessionKey, observedCallsign: o.observedCallsign!, serviceDate: iso(nowMs).slice(0, 10), confirmedAt: iso(nowMs) };
  };
  source[1].route = { originIata: "SEA", destinationIata: "ORD", verification: "hint", checkedAt: iso(nowMs) };
  confirmed(source[2], "SEA", "LAX");
  confirmed(source[3]);
  confirmed(source[4]); source[4].datedBinding!.confirmedAt = iso(nowMs - 120_001);
  confirmed(source[5]); source[5].datedBinding!.sessionKey = "mismatched-invented-session";
  confirmed(source[6]); source[6].datedBinding!.observedCallsign = "DAL999";
  confirmed(source[7]); source[7].datedBinding!.serviceDate = "2030-02-31";
  confirmed(source[8]); source[8].datedBinding!.confirmedAt = "not-a-timestamp";
  confirmed(source[9]); source[9].datedBinding!.confirmedAt = iso(nowMs + 1001);
  source[10].observedCallsign = "DAL123"; confirmed(source[10]); source[10].datedBinding!.observedCallsign = "EDV123";
  source[11].observedCallsign = "EDV123";
  let seededCollectionPublications = 0, seededRouteHintPublications = 0;
  let cleanup = { collections: 0, hints: 0, budgets: 0 };
  let storedResult: Record<string, unknown> = {};
  try {
    await ownStore.touch(nowMs);
    const lease = await ownStore.claim(randomUUID(), nowMs);
    assert.ok(lease);
    assert.equal(await ownStore.publish(lease, { observations: source, partial: false,
      metadata: { providerCalls: 0, rawCount: source.length, fusedCount: source.length, rejectedCount: 0, successfulProviders: 1, failedProviders: 0 } }, nowMs), true);
    seededCollectionPublications++;
    // A newly constructed store must deserialize the actual SQL JSONB snapshot.
    const coldStore = createNearbyCollectionStore({ environment: ownEnvironment, sqlProvider, clock: "provided" });
    const cold = await coldStore.read(nowMs);
    assert.ok(cold);
    assert.deepEqual(cold.observations, source);
    const score = (index: number) => rankNearbyCandidates([cold.observations[index]], area, nowMs)[0];
    const unknown = score(0), hint = score(1), datedUnassociated = score(2), datedAssociated = score(3);
    assert.equal(hint.score - unknown.score, 5);
    assert.equal(datedUnassociated.score - unknown.score, 15);
    assert.equal(datedAssociated.score - datedUnassociated.score, 5);
    assert.ok([unknown, hint, datedUnassociated, datedAssociated].every(r => r.motion.phase === unknown.motion.phase));
    assert.equal(unknown.route.verification, "unknown");
    assert.equal(hint.route.verification, "hint");
    assert.equal(datedUnassociated.route.verification, "confirmed");
    assert.equal(datedAssociated.route.verification, "confirmed");
    for (const index of [4, 5, 6, 7, 8, 9, 10]) assert.equal(currentRoute(cold.observations[index], nowMs).verification, "hint");
    assert.equal(normalizeObservedCallsign("EDV123"), "EDV123");
    assert.equal(normalizeObservedCallsign("DAL123"), "DAL123");
    assert.notEqual(normalizeObservedCallsign("EDV123"), normalizeObservedCallsign("DAL123"));

    const plainEngine = createPrivateNearbyEngine({ environment: ownEnvironment, store: coldStore, acquire: forbiddenAcquire, clock: () => nowMs });
    const baseline = await plainEngine.request("preset:chicago", { limit: 5 });
    assert.ok(baseline.view);
    const sql = await sqlProvider();
    const beforeBoard = await sql.query<{ revision: number | string; applied_collection_version: number | string; slots: unknown }>(
      "select revision,applied_collection_version,slots from inbound_plugin_v1.ranked_view where environment=$1", [ownEnvironment]);
    assert.equal(beforeBoard.length, 1);
    const positive = routeHintFromLookup({ observedCallsign: source[0].observedCallsign!, originIata: "SEA", destinationIata: "ORD", airlineLabel: "Invented Air",
      outcome: "positive", sourceClass: "certification_fixture", verification: "hint" }, nowMs);
    const oldOperating = { ...positive, observedCallsign: "EDV123" };
    // Seed only bounded private fixture values through the approved SQL lease
    // and publication interfaces; no lookup function/provider is invoked.
    for (const value of [positive, oldOperating]) {
      const hintLease = await ownHints.claim({ observedCallsign: value.observedCallsign, collectionVersion: 1, owner: randomUUID(), nowMs });
      assert.ok(hintLease);
      assert.equal(await ownHints.publish(hintLease, value, nowMs), true);
      seededRouteHintPublications++;
    }
    const cachedHints = await createNearbyRouteHintStore({ environment: ownEnvironment, sqlProvider, clock: "provided" }).read(
      [positive.observedCallsign, "EDV123", "DAL123"], nowMs);
    assert.equal(cachedHints.length, 2);
    const overlay = applyRouteHints({ collection: cold, area, nowMs }, cachedHints);
    assert.equal(currentRoute(overlay.observations[0], nowMs).verification, "hint");
    assert.equal(currentRoute(overlay.observations[10], nowMs).verification, "hint", "old operating callsign cannot restore mismatched confirmation");
    const marketing = { ...cold.observations[11], observedCallsign: "DAL123" };
    const changed = applyRouteHints({ collection: { ...cold, observations: [marketing] }, area, nowMs }, cachedHints);
    assert.equal(changed.observations[0].route.verification, "unknown", "generic EDV cache entry cannot transfer to a new DAL key");
    assert.equal(changed.observations[0].radarId, cold.observations[11].radarId);
    assert.equal(changed.observations[0].cardId, cold.observations[11].cardId);
    const routeService = createRouteEnrichmentService({ store: ownHints, clock: () => nowMs,
      lookup: async () => { fakeRouteLookups++; throw new Error("Integration renderer reads must not invoke lookup"); } });
    const enrichedEngine = createPrivateNearbyEngine({ environment: ownEnvironment, store: coldStore, acquire: forbiddenAcquire,
      clock: () => nowMs, routeEnrichment: routeService });
    const four = await enrichedEngine.request("preset:chicago");
    const five = await enrichedEngine.request("preset:chicago", { limit: 5 });
    assert.ok(four.view && five.view);
    assert.equal(four.view.featured.length, 4);
    assert.equal(five.view.featured.length, 5);
    assert.deepEqual(five.view.featured.map(r => r.candidate.cardId), baseline.view.featured.map(r => r.candidate.cardId));
    assert.deepEqual(four.view.featured.map(r => r.candidate.cardId), five.view.featured.slice(0, 4).map(r => r.candidate.cardId));
    assert.deepEqual(four.view.radar, buildNearbyView(cold, area, nowMs, { previousStability: four.view.stability }).radar);
    assert.equal(four.view.radar.length, 100);
    const afterBoard = await sql.query<typeof beforeBoard[number]>("select revision,applied_collection_version,slots from inbound_plugin_v1.ranked_view where environment=$1", [ownEnvironment]);
    assert.deepEqual(afterBoard, beforeBoard, "same-version cache changes cannot advance the SQL CAS board or reorder slots");
    const overlaidRow = four.view.ranked.find(row => row.candidate.cardId === cold.observations[0].cardId)!;
    assert.equal(overlaidRow.route.verification, "hint");
    const display = featuredRouteDisplay(overlaidRow, cachedHints.find(value => value.observedCallsign === positive.observedCallsign), nowMs);
    assert.deepEqual(Object.keys(display).sort(), ["airlineLabel", "checkedAt", "destinationIata", "originIata", "verification"]);
    const serialized = JSON.stringify({ radar: four.view.radar, display });
    const radarFields = new Set(["radarId", "displayIdent", "latitude", "longitude", "observedAt", "altitudeFt", "groundspeedKt",
      "groundTrackDeg", "verticalRateFpm", "positionKind", "freshness", "motion", "distanceNm", "bearingDeg", "featured", "typeCode"]);
    for (const radar of four.view.radar) assert.ok(Object.keys(radar).every(key => radarFields.has(key)), "Radar DTO uses only the existing renderer allowlist");
    for (const privateField of ["certification_fixture", "invented-aircraft", "invented-session", "invented_telemetry", "sourceClass", "phaseEvidence", "datedBinding", "cacheKey", "databaseId", "budgetState", "flightInstanceId", "providerEndpoint"]) {
      assert.equal(serialized.includes(privateField), false, privateField);
    }
    const acceptedAfter = await coldStore.read(nowMs);
    assert.deepEqual(acceptedAfter!.observations, source, "route-cache display overlay never overwrites accepted telemetry");
    assert.equal(acceptedAfter!.collectionVersion, 1);
    storedResult = {
      storedObservationCount: cold.observations.length, datedBindingRoundTrip: true,
      hintWeightDelta: hint.score - unknown.score, confirmedWeightDelta: datedUnassociated.score - unknown.score,
      confirmedOnlyAirportAssociationDelta: datedAssociated.score - datedUnassociated.score,
      datedDowngradeCases: 7, genericRouteNeverConfirmed: true, edvDalAliasesSeparated: true,
      changedCallsignKeyCannotInheritHintAndOverlayPreservesSuppliedIds: true, sameVersionBoardRevisionUnchanged: true,
      rendererAllowedFields: Object.keys(display).sort(), routeAndProviderPrivateFieldsExcluded: true,
      acceptedSnapshotUnchangedAfterOverlay: true, incumbentHoldMs: INCUMBENT_HOLD_MS, challengerMargin: REPLACEMENT_MARGIN,
    };
  } finally {
    const expiredAt = nowMs + NEARBY_POLICY.inactiveRetentionMs + 1;
    cleanup.collections = await ownStore.cleanup(expiredAt);
    const removed = await ownHints.cleanup(expiredAt);
    cleanup = { ...cleanup, ...removed };
  }
  assert.deepEqual(cleanup, { collections: 1, hints: 2, budgets: 1 });
  assert.equal(forbiddenAcquisitions, 0);
  assert.equal(fakeRouteLookups, 0);
  const mainAfter = await mainStore.read(nowMs);
  assert.ok(mainAfter);
  assert.equal(mainAfter.collectionVersion, mainBefore.collectionVersion);
  assert.deepEqual(mainAfter.observations, mainBefore.observations);
  const sql = await sqlProvider();
  const remaining = await sql.query<{ total: number | string }>(
    "select (select count(*) from inbound_plugin_v1.current_collection where environment=$1)+(select count(*) from inbound_plugin_v1.ranked_view where environment=$1)+(select count(*) from inbound_plugin_v1.route_hint where environment=$1)+(select count(*) from inbound_plugin_v1.route_construction_budget where environment=$1) as total", [ownEnvironment]);
  assert.equal(Number(remaining[0].total), 0);
  return {
    acceptedObservationCount: mainBefore.observations.length, radarCount: rawFour.radar.length, radarBytes,
    radarMaximumBytes: NEARBY_POLICY.maxRadarBytes, featuredDefault: rawFour.featured.length, featuredMaximum: rawFive.featured.length,
    blockedRouteCacheReadCount: blockedReads, blockedRouteConstructionCount: blockedConstructions,
    radarIndependentOfRouteWork: true, motionExtrapolationSeconds: limit.extrapolatedSeconds,
    motionStopsAt25Seconds: true, missingTrackNotInvented: true, mainSnapshotAndVersionUnchanged: true,
    acquisitionHookCalls: forbiddenAcquisitions, fakeRouteLookupCalls: fakeRouteLookups, externalProviderCalls: 0,
    seededCollectionPublications, seededRouteHintPublications, positiveHintTtlMs: ROUTE_HINT_POLICY.positiveTtlMs,
    ownEnvironmentRowsRemaining: Number(remaining[0].total), cleanup, ...storedResult,
  };
}

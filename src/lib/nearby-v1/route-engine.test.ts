import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db";
import { areaDefinition } from "../plugin-v1/areas";
import { FIXTURE_NOW } from "../plugin-v1/fixtures";
import { createPrivateNearbyEngine } from "./engine.server";
import type { AcceptedNearbyObservation, AcquisitionResult } from "./model";
import { createRouteEnrichmentService, type NearbyRouteEnrichmentService } from "./route-enrichment";
import { createNearbyRouteHintStore } from "./route-hint-store.server";
import { ROUTE_HINT_POLICY, type NearbyRouteLookup } from "./route-hints";
import { createNearbyCollectionStore } from "./store.server";
import { buildNearbyView } from "./views";

const NOW = Date.parse(FIXTURE_NOW);
const iso = (at: number) => new Date(at).toISOString();
const id = (index: number) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
const area = areaDefinition("preset:chicago");
let pg: PGlite;
let sql: Sql;
before(async () => {
  pg = new PGlite();
  await pg.exec(readFileSync(new URL("../../../docs/plugin-v1/migrations/0006_nearby_collection.sql", import.meta.url), "utf8"));
  await pg.exec(readFileSync(new URL("../../../docs/plugin-v1/migrations/0007_route_hint.sql", import.meta.url), "utf8"));
  sql = Object.assign(async () => [], {
    query: async <T>(query: string, values: unknown[] = []) => (await pg.query<T>(query, values)).rows,
  }) as Sql;
});
after(async () => { await pg.close(); });

function acquisition(at: number, count = 125): AcquisitionResult {
  const observations: AcceptedNearbyObservation[] = Array.from({ length: count }, (_, i) => ({
    cardId: id(i + 1), radarId: id(i + 10_001), privateAircraftIdentity: `invented-aircraft-${i + 1}`,
    sessionKey: `invented-session-${i + 1}`, observedCallsign: `UAL${i + 1}`, registration: null,
    latitude: area.reference.latitude + i / 100_000, longitude: area.reference.longitude,
    altitudeFt: 20_000, groundspeedKt: 240, groundTrackDeg: 90, verticalRateFpm: 0, onGround: false,
    observedAt: iso(at), positionKind: "observed", acceptedPosition: true, identityConflict: false,
    typeCode: "B738", category: null, operator: "Invented Air", interesting: false,
    route: { originIata: null, destinationIata: null, verification: "unknown", checkedAt: null }, datedBinding: null,
    freshness: { ageSeconds: 0, state: "fresh" },
    provenance: { source: "invented_telemetry", receivedAt: iso(at), positionAgeSeconds: 0, acceptance: "inbound-fusion" },
  }));
  return { observations, partial: false,
    metadata: { providerCalls: 0, rawCount: count, fusedCount: count, rejectedCount: 0, successfulProviders: 1, failedProviders: 0 } };
}
function engines(options: { environment: string; count?: number; clock: () => number; acquire: () => Promise<AcquisitionResult>; lookup?: NearbyRouteLookup; service?: NearbyRouteEnrichmentService }) {
  return Array.from({ length: options.count ?? 100 }, () => {
    // Every viewer has its own engine and stores; only disposable SQL is shared.
    const store = createNearbyCollectionStore({ environment: options.environment, sqlProvider: async () => sql, clock: "provided" });
    const routeStore = createNearbyRouteHintStore({ environment: options.environment, sqlProvider: async () => sql, clock: "provided" });
    const routeEnrichment = options.service ?? (options.lookup ? createRouteEnrichmentService({ store: routeStore, lookup: options.lookup, clock: options.clock }) : undefined);
    return createPrivateNearbyEngine({ environment: options.environment, store, acquire: options.acquire, clock: options.clock, routeEnrichment });
  });
}
function routeResult(observedCallsign: string, outcome: "positive" | "negative" = "positive") {
  return { observedCallsign, originIata: outcome === "positive" ? "SEA" : null, destinationIata: outcome === "positive" ? "ORD" : null,
    airlineLabel: outcome === "positive" ? "Invented Air" : null, outcome, sourceClass: "invented_route", verification: outcome === "positive" ? "hint" as const : "unknown" as const };
}

test("100 independent engines share one cold aircraft acquisition and zero viewer-triggered route lookups", async () => {
  const environment = "route_engine_cold";
  let acquisitions = 0, routeLookups = 0, finishedCold = 0;
  let releaseAcquisition!: () => void, finishContenders!: () => void;
  const gate = new Promise<void>(resolve => { releaseAcquisition = resolve; });
  const contenders = new Promise<void>(resolve => { finishContenders = resolve; });
  const viewers = engines({ environment, clock: () => NOW,
    acquire: async () => { acquisitions++; await gate; return acquisition(NOW); },
    lookup: async key => { routeLookups++; return routeResult(key); } });
  const cold = viewers.map(async viewer => {
    const response = await viewer.request("preset:chicago");
    if (response.view === null && ++finishedCold === 99) finishContenders();
    return response;
  });
  await contenders;
  assert.equal(acquisitions, 1);
  assert.equal(finishedCold, 99);
  assert.equal(routeLookups, 0);
  releaseAcquisition();
  const initial = await Promise.all(cold);
  assert.equal(initial.filter(r => r.view !== null).length, 1);
  assert.equal(initial.find(r => r.view)!.view!.radar.length, 100);
  const warm = await Promise.all(viewers.map(viewer => viewer.request("preset:chicago")));
  assert.equal(acquisitions, 1);
  assert.equal(routeLookups, 0, "viewer cache overlays never invoke construction or a route provider");
  assert.ok(warm.every(r => r.view!.radar.length === 100 && r.view!.featured.length === 4));
  const board = warm[0].view!.featured.map(r => r.candidate.cardId);
  assert.ok(warm.every(r => JSON.stringify(r.view!.featured.map(row => row.candidate.cardId)) === JSON.stringify(board)));
  const rows = await sql.query<{ total: number }>("select count(*)::integer as total from inbound_plugin_v1.current_collection where environment=$1", [environment]);
  assert.equal(rows[0].total, 1);
});

test("100 explicit route workers collapse callsigns and share two-per-collection/six-per-rolling-minute SQL budgets", async () => {
  const environment = "route_engine_budget";
  let at = NOW, acquisitions = 0;
  const starts: { key: string; at: number }[] = [];
  const viewers = engines({ environment, clock: () => at,
    acquire: async () => { acquisitions++; return acquisition(at); },
    lookup: async key => { starts.push({ key, at }); return routeResult(key, key === "UAL2" ? "negative" : "positive"); } });
  await viewers[0].request("preset:chicago");
  const coldBoard = (await viewers[0].request("preset:chicago")).view!.featured.map(r => r.candidate.cardId);
  const construct = async () => Promise.all(viewers.map(viewer => viewer.constructRouteHints("preset:chicago")));
  const first = await construct();
  assert.equal(first.reduce((total, result) => total + result.lookupsStarted, 0), 2);
  assert.equal(first.reduce((total, result) => total + result.published, 0), 2);
  assert.equal(starts.length, 2);
  assert.deepEqual(starts.map(start => start.key).sort(), ["UAL1", "UAL2"]);
  assert.equal(new Set(starts.map(start => start.key)).size, 2, "each observed callsign is looked up exactly once across one hundred workers");
  const subsequent = await Promise.all(viewers.map(viewer => viewer.request("preset:chicago")));
  const rawSnapshot = (await viewers[0].read()).collection!;
  assert.ok(rawSnapshot.observations.every(o => o.route.verification === "unknown"), "cache overlays never rewrite accepted telemetry or become aircraft route history");
  assert.equal(starts.length, 2);
  assert.equal(acquisitions, 1);
  for (const response of subsequent) {
    assert.deepEqual(response.view!.featured.map(r => r.candidate.cardId), coldBoard, "cache publication cannot rerank an already applied collection version");
    assert.equal(response.view!.ranked.find(r => r.candidate.observedCallsign === "UAL1")!.route.verification, "hint");
    assert.equal(response.view!.ranked.find(r => r.candidate.observedCallsign === "UAL2")!.route.verification, "unknown");
    assert.equal(response.view!.radar.length, 100);
    assert.deepEqual(response.view!.radar, buildNearbyView(rawSnapshot, area, at, { previousStability: response.view!.stability }).radar,
      "the combined view uses raw accepted telemetry for Radar independently of route-enriched scores");
  }
  for (const elapsed of [20_000, 40_000]) {
    at = NOW + elapsed;
    await viewers[0].requestRadar("preset:chicago");
    const batch = await construct();
    assert.equal(batch.reduce((total, result) => total + result.lookupsStarted, 0), 2);
    assert.ok(batch.every(result => result.cacheHits >= 2), "both valid positive and negative entries are reused across acquisition refresh");
  }
  assert.equal(starts.length, 6);
  assert.equal(new Set(starts.map(start => start.key)).size, 6);
  at = NOW + 59_000;
  await viewers[0].requestRadar("preset:chicago");
  const blocked = await construct();
  assert.equal(blocked.reduce((total, result) => total + result.lookupsStarted, 0), 0);
  assert.equal(starts.length, 6);
  // Refresh to a new accepted cycle at the strict minute boundary. The old
  // positive remains cached, while the expired negative is eligible again.
  at = NOW + 60_000;
  const snapshot = await viewers[0].read();
  await viewers[0].requestRadar("preset:chicago");
  assert.ok((await viewers[0].read()).collection!.collectionVersion > snapshot.collection!.collectionVersion);
  const refreshed = await construct();
  assert.equal(refreshed.reduce((total, result) => total + result.lookupsStarted, 0), 2);
  assert.equal(starts.length, 8);
  assert.equal(starts.filter(start => start.key === "UAL1").length, 1, "thirty-minute positive never re-queries on collection refresh");
  assert.equal(starts.filter(start => start.key === "UAL2").length, 2, "negative becomes eligible at sixty-second expiry");
  for (const start of starts) assert.ok(starts.filter(other => other.at > start.at - 60_000 && other.at <= start.at).length <= 6);
  const stored = await sql.query<{ outcomes: string[]; starts: number; cycles: number }>(
    "select (select array_agg(outcome order by observed_callsign) from inbound_plugin_v1.route_hint where environment=$1) as outcomes,cardinality(recent_starts) as starts,cycle_lookups as cycles from inbound_plugin_v1.route_construction_budget where environment=$1", [environment]);
  assert.equal(stored[0].starts, 6);
  assert.equal(stored[0].cycles, 2);
  assert.equal(stored[0].outcomes.length, 7, "refresh overwrites the existing callsign cache row instead of appending route history");
  assert.equal(stored[0].outcomes.filter(outcome => outcome === "negative").length, 1);
});

test("Concurrent provider outage uses shared negative retry protection and cannot remove or destabilize accepted aircraft", async () => {
  const environment = "route_engine_failure";
  let at = NOW, acquisitions = 0, failedLookups = 0;
  const viewers = engines({ environment, clock: () => at,
    acquire: async () => { acquisitions++; return acquisition(at, 2); },
    lookup: async () => { failedLookups++; throw new Error("invented route-provider outage"); } });
  const seed = await viewers[0].request("preset:chicago");
  const board = seed.view!.featured.map(r => r.candidate.cardId);
  const construct = async () => Promise.all(viewers.map(viewer => viewer.constructRouteHints("preset:chicago")));
  const first = await construct();
  assert.equal(first.reduce((total, result) => total + result.failed, 0), 2);
  assert.equal(failedLookups, 2);
  for (let i = 0; i < 2; i++) await construct();
  assert.equal(failedLookups, 2, "one hundred workers cannot immediately retry failed callsigns");
  const reads = await Promise.all(viewers.map(viewer => viewer.request("preset:chicago")));
  assert.ok(reads.every(r => r.view!.radar.length === 2));
  assert.ok(reads.every(r => JSON.stringify(r.view!.featured.map(row => row.candidate.cardId)) === JSON.stringify(board)));
  assert.equal(acquisitions, 1);
  at += 20_000;
  await viewers[0].requestRadar("preset:chicago");
  assert.equal((await construct()).reduce((total, result) => total + result.lookupsStarted, 0), 0);
  assert.equal(failedLookups, 2, "acquisition refresh keeps the valid failure retry cache");
  at = NOW + 60_000;
  await viewers[0].requestRadar("preset:chicago");
  assert.equal((await construct()).reduce((total, result) => total + result.lookupsStarted, 0), 2);
  assert.equal(failedLookups, 4);
  assert.deepEqual((await viewers[0].request("preset:chicago")).view!.featured.map(r => r.candidate.cardId), board);
});

test("Radar immediately returns accepted telemetry while optional route reads are blocked or failing", async () => {
  for (const blocked of [false, true]) {
    let routeReads = 0, construction = 0, acquisitions = 0;
    const service: NearbyRouteEnrichmentService = {
      async read() { routeReads++; if (blocked) return await new Promise<never>(() => {}); throw new Error("invented cache outage"); },
      async construct() { construction++; throw new Error("route worker must be explicit"); },
      async cleanup() { return { hints: 0, budgets: 0 }; },
    };
    const viewer = engines({ environment: `route_engine_fast_${blocked ? "blocked" : "failed"}`, count: 1, clock: () => NOW,
      acquire: async () => { acquisitions++; return acquisition(NOW); }, service })[0];
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await Promise.race([viewer.requestRadar("preset:chicago"), new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Radar waited for optional route work")), 1000);
      })]);
      assert.equal(response.radar.length, 100);
      assert.equal(response.radar[0].groundTrackDeg, 90);
      assert.equal(routeReads, 0);
      assert.equal(construction, 0);
      assert.equal(acquisitions, 1);
      const encoded = JSON.stringify(response.radar);
      for (const privateField of ["invented-aircraft", "invented-session", "invented_telemetry", "route", "sourceClass", "budget", "phaseEvidence", "cardId"]) assert.equal(encoded.includes(privateField), false);
    } finally { if (deadline) clearTimeout(deadline); }
    if (!blocked) {
      const featured = await viewer.request("preset:chicago");
      assert.equal(featured.view!.featured.length, 4);
      assert.equal(featured.view!.radar.length, 100);
      assert.equal(construction, 0);
      assert.equal(acquisitions, 1);
    }
  }
});

test("Chicago, ORD and MDW share route hints and one collection, without a worker configured by default", async () => {
  const environment = "route_engine_areas";
  let acquisitions = 0, lookups = 0;
  const viewer = engines({ environment, count: 1, clock: () => NOW,
    acquire: async () => { acquisitions++; return acquisition(NOW, 10); },
    lookup: async key => { lookups++; return routeResult(key); } })[0];
  await viewer.requestRadar("preset:chicago");
  const results = await Promise.all(["preset:chicago", "airport:KORD", "airport:KMDW"].map(areaId =>
    viewer.constructRouteHints(areaId as "preset:chicago" | "airport:KORD" | "airport:KMDW")));
  assert.equal(results.reduce((total, result) => total + result.lookupsStarted, 0), 2);
  assert.equal(lookups, 2);
  for (const areaId of ["preset:chicago", "airport:KORD", "airport:KMDW"] as const) {
    const response = await viewer.request(areaId);
    assert.equal(response.view!.collectionVersion, 1);
    assert.equal(response.view!.collectionKey, "nearby:telemetry:v1:chicago:50");
    assert.equal(response.view!.radar.length, 10);
  }
  assert.equal(acquisitions, 1);
  const noWorker = engines({ environment: "route_engine_no_worker", count: 1, clock: () => NOW,
    acquire: async () => acquisition(NOW, 1) })[0];
  assert.deepEqual(await noWorker.constructRouteHints("preset:chicago"), { poolSize: 0, cacheHits: 0, lookupsStarted: 0, published: 0, failed: 0 });
  assert.deepEqual(await noWorker.cleanupRouteHints(), { hints: 0, budgets: 0 });
  assert.equal(ROUTE_HINT_POLICY.newLookupsPerCollection, 2);
  assert.equal(ROUTE_HINT_POLICY.newLookupsPerMinute, 6);
});

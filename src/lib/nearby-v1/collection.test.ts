import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db";
import { CHICAGO_COLLECTION } from "../plugin-v1/areas";
import { fixtureRankingCandidate } from "../plugin-v1/fixtures";
import { createNearbyCollectionStore } from "./store.server";
import { createNearbyCollectionService, readCollectionHealth } from "./collection";
import { createPrivateNearbyEngine } from "./engine.server";
import { NEARBY_POLICY, type AcquisitionResult, type AcceptedNearbyObservation } from "./model";

const NOW = Date.parse("2030-01-15T18:00:00Z");
function result(nowMs = NOW): AcquisitionResult {
  const candidate = fixtureRankingCandidate();
  const observation: AcceptedNearbyObservation = { ...candidate, radarId: candidate.cardId, observedAt: new Date(nowMs).toISOString(),
    groundTrackDeg: 90, freshness: { ageSeconds: 0, state: "fresh" }, provenance: { source: "accepted-fixture", receivedAt: new Date(nowMs).toISOString(), positionAgeSeconds: 0, acceptance: "inbound-fusion" } };
  return { observations: [observation], partial: false, metadata: { providerCalls: 3, rawCount: 3, fusedCount: 1, rejectedCount: 0, successfulProviders: 3, failedProviders: 0 } };
}
function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
async function database() {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL("../../../docs/plugin-v1/migrations/0006_nearby_collection.sql", import.meta.url), "utf8"));
  const sql = Object.assign(async () => [], { query: async <T>(query: string, params: unknown[] = []) => (await pg.query<T>(query, params)).rows }) as Sql;
  const store = () => createNearbyCollectionStore({ environment: "test", sqlProvider: async () => sql, clock: "provided" });
  return { pg, sql, store };
}
test("100 independent viewers use one SQL lease and one three-call acquisition cycle", async () => {
  const db = await database();
  const started = barrier(), release = barrier(), contendersDone = barrier();
  let cycles = 0, providerCalls = 0, completions = 0;
  const acquire = async () => { cycles++; providerCalls += 3; started.resolve(); await release.promise; return result(); };
  try {
    const requests = Array.from({ length: 100 }, (_, i) => createNearbyCollectionService({ store: db.store(), acquire, clock: () => NOW,
      leaseOwner: () => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}` }).request().then(r => { if (++completions === 99) contendersDone.resolve(); return r; }));
    await started.promise;
    await contendersDone.promise;
    assert.equal(cycles, 1); assert.equal(providerCalls, 3);
    release.resolve();
    const reads = await Promise.all(requests);
    assert.equal(reads.filter(r => r.health === "unavailable").length, 99, "cold contenders do not block or claim invented empty sky");
    assert.equal(reads.filter(r => r.health === "ok").length, 1);
    const warm = await Promise.all(Array.from({ length: 100 }, (_, i) => createNearbyCollectionService({ store: db.store(), acquire, clock: () => NOW + 1_000,
      leaseOwner: () => `00000000-0000-4000-8001-${String(i + 1).padStart(12, "0")}` }).request()));
    assert.ok(warm.every(r => r.health === "ok" && r.observations.length === 1));
    assert.equal(cycles, 1); assert.equal(providerCalls, 3);
    assert.equal((await db.sql.query("select * from inbound_plugin_v1.current_collection")).length, 1);
  } finally { release.resolve(); await db.pg.close(); }
});
test("Failure preserves last-safe positions, advances backoff, and cannot stampede", async () => {
  const db = await database(); let now = NOW, calls = 0, fail = false;
  const store = db.store();
  const service = createNearbyCollectionService({ store, clock: () => now, leaseOwner: () => "00000000-0000-4000-8000-000000000001",
    acquire: async () => { calls++; if (fail) throw new Error("provider unavailable"); return result(now); } });
  try {
    const initial = await service.request(); assert.equal(initial.health, "ok");
    now += NEARBY_POLICY.cadenceMs; fail = true;
    const failed = await service.request(); assert.equal(failed.health, "stale"); assert.deepEqual(failed.collection?.observations, initial.collection?.observations);
    assert.equal(failed.collection?.collectionVersion, 1); assert.equal(calls, 2);
    await Promise.all(Array.from({ length: 100 }, () => service.request())); assert.equal(calls, 2);
    now = NOW + 45_001; assert.equal((await service.read()).health, "stale");
    now = NOW + 120_000; assert.equal((await service.read()).observations.length, 1);
    now++; assert.equal((await service.read()).health, "unavailable"); assert.equal((await service.read()).observations.length, 0);
  } finally { await db.pg.close(); }
});
test("Demand and private ticks stop at activity expiry, then reactivate; cleanup stays bounded", async () => {
  const db = await database(); let now = NOW, calls = 0;
  const service = createNearbyCollectionService({ store: db.store(), clock: () => now, leaseOwner: () => "00000000-0000-4000-8000-000000000001", acquire: async () => { calls++; return result(now); } });
  try {
    await service.request(); now += 20_000; await service.tick(); assert.equal(calls, 2);
    now = NOW + NEARBY_POLICY.activeForMs; await service.tick(); assert.equal(calls, 2, "tick never renews activity");
    await service.request(); assert.equal(calls, 3); assert.equal((await service.read()).collection?.collectionVersion, 3);
    now += NEARBY_POLICY.inactiveRetentionMs + 1;
    assert.equal((await service.read()).health, "unavailable"); assert.equal(await service.cleanup(), 1); assert.equal(await service.cleanup(), 0);
    await service.request(); assert.equal(calls, 4); assert.equal((await service.read()).collection?.collectionKey, CHICAGO_COLLECTION.id);
  } finally { await db.pg.close(); }
});
test("Successful empty and partial are distinct from failure; original fix age controls serving", async () => {
  const db = await database(); const store = db.store();
  try {
    await store.touch(NOW);
    const lease = await store.claim("00000000-0000-4000-8000-000000000001", NOW); assert.ok(lease);
    await store.publish(lease, { ...result(), observations: [] }, NOW);
    const empty = readCollectionHealth(await store.read(NOW), NOW); assert.equal(empty.health, "ok"); assert.deepEqual(empty.observations, []);
    assert.equal(readCollectionHealth(await store.read(NOW), NOW + 120_001).health, "unavailable");
    const row = await store.read(NOW); assert.ok(row);
    const partial = { ...row, observations: result(NOW - 30_000).observations, partial: true };
    assert.equal(readCollectionHealth(partial, NOW).health, "partial");
    assert.equal(readCollectionHealth(partial, NOW + 90_001).health, "unavailable", "receipt does not rejuvenate old fixes");
  } finally { await db.pg.close(); }
});
test("Database coordination errors stop acquisition rather than falling back per viewer", async () => {
  let calls = 0;
  const store = createNearbyCollectionStore({ environment: "test", sqlProvider: async () => { throw new Error("DB unavailable"); }, clock: "provided" });
  const service = createNearbyCollectionService({ store, clock: () => NOW, leaseOwner: () => "00000000-0000-4000-8000-000000000001", acquire: async () => { calls++; return result(); } });
  await assert.rejects(service.request(), /DB unavailable/); assert.equal(calls, 0);
});
test("Private Chicago, ORD and MDW entry points reuse the same accepted collection and recalculate their views", async () => {
  const db = await database(); let acquisitions = 0;
  const engine = createPrivateNearbyEngine({ environment: "test", store: db.store(), clock: () => NOW, acquire: async () => { acquisitions++; return result(); } });
  try {
    const chicago = await engine.request("preset:chicago");
    const ord = await engine.request("airport:KORD");
    const mdw = await engine.request("airport:KMDW");
    assert.equal(acquisitions, 1);
    for (const view of [chicago, ord, mdw]) {
      assert.equal(view.health, "ok"); assert.ok(view.view);
      assert.equal(view.view.collectionKey, CHICAGO_COLLECTION.id); assert.equal(view.view.collectionVersion, 1);
    }
    assert.notEqual(chicago.view!.ranked[0].distanceNm, ord.view!.ranked[0].distanceNm);
    assert.notEqual(ord.view!.ranked[0].distanceNm, mdw.view!.ranked[0].distanceNm);
    assert.notEqual(ord.view!.ranked[0].bearingDeg, mdw.view!.ranked[0].bearingDeg);
    assert.equal((await db.sql.query("select * from inbound_plugin_v1.current_collection")).length, 1);
    assert.equal((await db.sql.query("select * from inbound_plugin_v1.ranked_view")).length, 3);
    await assert.rejects(engine.request("preset:chicago", { limit: 6 }), /Featured limit/);
    assert.equal(acquisitions, 1, "invalid requests never acquire");
  } finally { await db.pg.close(); }
});
test("A publication racing view construction keeps shared incumbents and returns the new telemetry version", async () => {
  const db = await database(); let now = NOW, injectRace = false;
  const store = db.store();
  const original = result().observations[0];
  const oldIds = Array.from({ length: 5 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
  const observations = oldIds.map((cardId, i) => ({ ...original, cardId, radarId: cardId, sessionKey: cardId, privateAircraftIdentity: `private-${i}`,
    observedCallsign: `UAL${i + 1}`, registration: null, latitude: 41.9, longitude: -87.8, altitudeFt: 35_000, verticalRateFpm: 0, interesting: false,
    route: { originIata: null, destinationIata: null, verification: "unknown" as const, checkedAt: null }, datedBinding: null }));
  const initial = { ...result(), observations };
  const save = store.stableView.bind(store);
  store.stableView = async input => {
    const state = await save(input);
    if (injectRace) {
      injectRace = false; now = NOW + 20_000;
      const lease = await store.claim("00000000-0000-4000-8000-000000000099", now); assert.ok(lease);
      const updated = observations.map(o => ({ ...o, latitude: o.latitude + .001, observedAt: new Date(now).toISOString() }));
      const cardId = "00000000-0000-4000-8000-000000000100";
      const challenger = { ...updated[0], cardId, radarId: cardId, sessionKey: cardId, privateAircraftIdentity: "challenger", observedCallsign: "UAL100", altitudeFt: 6_000, verticalRateFpm: -500, interesting: true };
      assert.equal(await store.publish(lease, { ...initial, observations: [...updated, challenger] }, now), true);
    }
    return state;
  };
  const engine = createPrivateNearbyEngine({ environment: "test", store, clock: () => now, acquire: async () => initial });
  try {
    const first = await engine.request("preset:chicago"); assert.ok(first.view); const incumbentIds = first.view.featured.map(r => r.candidate.cardId);
    now = NOW + 1_000; injectRace = true;
    const raced = await engine.request("preset:chicago"); assert.ok(raced.view);
    assert.equal(raced.view.collectionVersion, 2);
    assert.deepEqual(raced.view.featured.map(r => r.candidate.cardId), incumbentIds);
    assert.ok(raced.view.featured.every(r => r.candidate.observedAt === new Date(now).toISOString()));
    assert.equal((await store.readStableView("preset:chicago", 38, now))?.collectionVersion, 2);
  } finally { await db.pg.close(); }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db";
import { areaDefinition } from "../plugin-v1/areas";
import { fixtureRankingCandidate, FIXTURE_NOW } from "../plugin-v1/fixtures";
import { rankNearbyCandidates } from "../plugin-v1/ranking";
import { NEARBY_POLICY, type AcceptedNearbyObservation, type AcquisitionResult } from "./model";
import { createNearbyCollectionStore } from "./store.server";

const ddl = readFileSync(new URL("../../../docs/plugin-v1/migrations/0001_nearby_collection.sql", import.meta.url), "utf8");
const now = Date.parse(FIXTURE_NOW);
function acquisition(at = now): AcquisitionResult {
  const observation: AcceptedNearbyObservation = {
    ...fixtureRankingCandidate(), observedAt: new Date(at).toISOString(), radarId: "nearby-radar-fixture-1", groundTrackDeg: 90,
    freshness: { ageSeconds: 0, state: "fresh" },
    provenance: { source: "fixture", receivedAt: new Date(at).toISOString(), positionAgeSeconds: 0, acceptance: "inbound-fusion" },
  };
  return { observations: [observation], partial: false, metadata: { providerCalls: 1, rawCount: 1, fusedCount: 1, rejectedCount: 0, successfulProviders: 1, failedProviders: 0 } };
}
async function database() {
  const pg = new PGlite();
  await pg.exec(ddl);
  const sql = Object.assign(async () => [], {
    query: async <T>(query: string, values: unknown[] = []) => (await pg.query<T>(query, values)).rows,
  }) as Sql;
  const store = (environment = "test") => createNearbyCollectionStore({ environment, sqlProvider: async () => sql, clock: "provided" });
  return { pg, sql, store };
}

test("Nearby migration applies only two bounded current-state tables to disposable PGlite", async () => {
  const { pg, sql, store } = await database();
  try {
    await pg.exec(ddl);
    const tables = await sql.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema='inbound_plugin_v1' order by table_name");
    assert.deepEqual(tables.map(row => row.table_name), ["current_collection", "ranked_view"]);
    assert.ok(!readdirSync(new URL("../../../migrations", import.meta.url)).some(name => /nearby|plugin/.test(name)));
    assert.doesNotMatch(ddl.replace(/^--.*$/gm, ""), /(?:alter|drop)\s+table|user_id|history|archive|occurrence_registry|selection_handle/i);
    await store().touch(now);
    await assert.rejects(sql.query("update inbound_plugin_v1.current_collection set accepted_snapshot_at=$1,accepted_collection=$2::jsonb", [new Date(now), JSON.stringify(Array(1001).fill({}))]), /check constraint/);
    await assert.rejects(sql.query("update inbound_plugin_v1.current_collection set accepted_snapshot_at=$1,accepted_collection=$2::jsonb", [new Date(now), JSON.stringify([{ large: "x".repeat(1048576) }])]), /check constraint/);
    await assert.rejects(sql.query("update inbound_plugin_v1.current_collection set collection_key='viewer:123'"), /check constraint/);
  } finally { await pg.close(); }
});

test("100 independent cold stores share one SQL lease and one gated provider acquisition", async () => {
  const { pg, sql, store } = await database();
  try {
    let providerCalls = 0, completedLosers = 0;
    let release!: () => void, losersFinished!: () => void;
    const providerGate = new Promise<void>(resolve => { release = resolve; });
    const allLosers = new Promise<void>(resolve => { losersFinished = resolve; });
    const requests = Array.from({ length: 100 }, async () => {
      const instance = store();
      await instance.touch(now);
      const lease = await instance.claim(randomUUID(), now);
      if (!lease) {
        completedLosers++;
        if (completedLosers === 99) losersFinished();
        return instance.read(now);
      }
      providerCalls++;
      await providerGate;
      assert.equal(await instance.publish(lease, acquisition(), now), true);
      return instance.read(now);
    });
    await allLosers; // Explicit barrier proves all contenders tried before release.
    assert.equal(providerCalls, 1);
    release(); await Promise.all(requests);
    const snapshot = await store().read(now);
    assert.equal(snapshot!.collectionVersion, 1); assert.equal(snapshot!.fencingGeneration, 1);
    assert.equal((await sql.query("select * from inbound_plugin_v1.current_collection")).length, 1);
    assert.equal(await store().claim(randomUUID(), now + NEARBY_POLICY.cadenceMs - 1), null);
    assert.ok(await store().claim(randomUUID(), now + NEARBY_POLICY.cadenceMs));
  } finally { await pg.close(); }
});

test("lease fencing rejects late writers, duplicate publication, failure and owner ABA", async () => {
  const { pg, store } = await database();
  try {
    const first = store(), second = store();
    await first.touch(now);
    const lease = (await first.claim(randomUUID(), now))!;
    assert.equal(await second.claim(randomUUID(), now + NEARBY_POLICY.leaseMs - 1), null);
    assert.equal(await first.publish(lease, acquisition(), now + NEARBY_POLICY.leaseMs), false, "expired writer fails even before replacement");
    assert.equal(await second.claim(randomUUID(), now + NEARBY_POLICY.leaseMs), null, "crashed writer cannot increase provider cadence at lease expiry");
    const replacementAt = now + NEARBY_POLICY.cadenceMs;
    const replacement = (await second.claim(randomUUID(), replacementAt))!;
    assert.equal(replacement.generation, 2);
    assert.equal(await second.publish(replacement, acquisition(replacementAt), replacementAt), true);
    assert.equal(await first.publish(lease, acquisition(), replacementAt), false);
    assert.equal(await first.fail(lease, replacementAt), false);
    assert.equal(await second.publish(replacement, acquisition(), replacementAt), false);
    assert.equal((await first.read(replacementAt))!.collectionVersion, 1);
    const expired = now + NEARBY_POLICY.inactiveRetentionMs;
    assert.equal(await first.cleanup(expired), 1);
    await first.touch(expired);
    const recreated = (await first.claim(randomUUID(), expired))!;
    assert.equal(recreated.generation, 1);
    assert.equal(await first.publish(lease, acquisition(expired), expired), false, "owner UUID fences recreated row generation reset");
    assert.equal(await first.publish(recreated, acquisition(expired), expired), true);
  } finally { await pg.close(); }
});

test("failure preserves last-safe data/version, backs off 20/40/80/120 and resets on success", async () => {
  const { pg, sql, store } = await database();
  try {
    const instance = store();
    await instance.touch(now);
    assert.equal(await instance.publish((await instance.claim(randomUUID(), now))!, acquisition(), now), true);
    let at = now + NEARBY_POLICY.cadenceMs;
    for (const delay of [20, 40, 80, 120, 120]) {
      await instance.touch(at);
      const claim = (await instance.claim(randomUUID(), at))!;
      assert.equal(await instance.fail(claim, at), true);
      const snapshot = (await instance.read(at))!;
      assert.equal(snapshot.collectionVersion, 1);
      assert.equal(snapshot.acceptedSnapshotAtMs, now);
      assert.deepEqual(snapshot.observations, acquisition().observations);
      assert.deepEqual(snapshot.metadata, acquisition().metadata);
      assert.equal(snapshot.lastAttemptFailed, true);
      assert.equal(snapshot.nextAttemptAtMs, at + delay * 1000);
      assert.equal(await instance.claim(randomUUID(), snapshot.nextAttemptAtMs - 1), null);
      at = snapshot.nextAttemptAtMs;
    }
    await instance.touch(at);
    assert.equal(await instance.publish((await instance.claim(randomUUID(), at))!, acquisition(at), at), true);
    const recovered = (await instance.read(at))!;
    assert.equal(recovered.collectionVersion, 2); assert.equal(recovered.failureBackoffSeconds, 20);
    assert.equal(recovered.lastAttemptFailed, false);
    assert.equal((await sql.query("select * from inbound_plugin_v1.current_collection")).length, 1, "all polls overwrite one current row");
  } finally { await pg.close(); }
});

test("activity expires, requests reactivate, logical expiry precedes scoped cleanup", async () => {
  const { pg, store } = await database();
  try {
    const instance = store();
    await instance.touch(now); await store("other").touch(now);
    assert.equal(await instance.claim(randomUUID(), now + NEARBY_POLICY.activeForMs), null);
    await instance.touch(now + NEARBY_POLICY.activeForMs);
    assert.ok(await instance.claim(randomUUID(), now + NEARBY_POLICY.activeForMs));
    assert.equal(await instance.read(now + NEARBY_POLICY.activeForMs + NEARBY_POLICY.inactiveRetentionMs), null);
    assert.equal(await instance.cleanup(now + NEARBY_POLICY.activeForMs + NEARBY_POLICY.inactiveRetentionMs), 1);
    assert.equal(await store("other").cleanup(now + NEARBY_POLICY.inactiveRetentionMs), 1, "cleanup never touches another environment");
    assert.equal(await instance.read(now + NEARBY_POLICY.activeForMs + NEARBY_POLICY.inactiveRetentionMs), null);
  } finally { await pg.close(); }
});

test("shared ranked views use collection/version CAS and preserve outage slots", async () => {
  const { pg, sql, store } = await database();
  try {
    const instance = store();
    await instance.touch(now);
    await instance.publish((await instance.claim(randomUUID(), now))!, acquisition(), now);
    const ranked = rankNearbyCandidates(acquisition().observations, areaDefinition("preset:chicago"), now);
    const input = { areaId: "preset:chicago" as const, radiusNm: 38 as const, collectionVersion: 1, nowMs: now, successfulCollection: true, ranked };
    const views = await Promise.all(Array.from({ length: 20 }, () => store().stableView(input)));
    assert.ok(views[0]); for (const view of views) assert.deepEqual(view!.slots, views[0]!.slots);
    assert.equal((await sql.query("select revision from inbound_plugin_v1.ranked_view"))[0].revision, 1, "same collection version is applied once across stores");
    assert.deepEqual((await instance.stableView({ ...input, successfulCollection: false, ranked: [] }))!.slots, views[0]!.slots);
    const ord = await instance.stableView({ ...input, areaId: "airport:KORD", radiusNm: 25, successfulCollection: false });
    assert.equal(ord!.collectionVersion, 1, "cold outage view seeds accepted-time ranking");
    const stale = await instance.stableView({ ...input, collectionVersion: 2 });
    assert.equal(stale!.collectionVersion, 1, "cannot publish a view for unpublished collection version");
    await sql.query("update inbound_plugin_v1.ranked_view set inactive_expires_at=$1 where area_id='preset:chicago'", [new Date(now)]);
    assert.equal(await instance.readStableView("preset:chicago", 38, now), null);
    assert.ok(await instance.stableView(input), "expired row can be replaced even before physical cleanup");
    await assert.rejects(sql.query("update inbound_plugin_v1.ranked_view set slots=$1::jsonb", [JSON.stringify(Array(6).fill({}))]), /check constraint/);
    assert.equal(await instance.cleanup(now + NEARBY_POLICY.inactiveRetentionMs), 1);
    assert.equal((await sql.query("select * from inbound_plugin_v1.ranked_view")).length, 0, "collection cleanup cascades its bounded views");
  } finally { await pg.close(); }
});

test("invalid publication and unavailable shared DB never bypass coordination", async () => {
  const { pg, store } = await database();
  try {
    const instance = store(); await instance.touch(now);
    const lease = (await instance.claim(randomUUID(), now))!;
    await assert.rejects(instance.publish(lease, { ...acquisition(), observations: [{ ...acquisition().observations[0], acceptedPosition: false }] }, now), /Invalid accepted/);
    await assert.rejects(instance.publish(lease, { ...acquisition(), observations: [{ ...acquisition().observations[0], groundTrackDeg: 360 }] }, now), /Invalid accepted/);
    await assert.rejects(instance.publish(lease, { ...acquisition(), observations: [acquisition().observations[0], acquisition().observations[0]] }, now), /Invalid accepted/);
    await assert.rejects(instance.publish(lease, { ...acquisition(), observations: [{ ...acquisition().observations[0], rawProviderPayload: {} } as AcceptedNearbyObservation] }, now), /Invalid accepted/);
    assert.equal((await instance.read(now))!.collectionVersion, 0);
  } finally { await pg.close(); }
  const unavailable = createNearbyCollectionStore({ environment: "test", sqlProvider: async () => { throw new Error("Shared DB unavailable"); }, clock: "provided" });
  await assert.rejects(unavailable.touch(now), /Shared DB unavailable/);
  await assert.rejects(unavailable.claim(randomUUID(), now), /Shared DB unavailable/);
  assert.throws(() => createNearbyCollectionStore({ environment: "viewer:bad" }), /Invalid Nearby environment/);
  const savedDatabase = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    await assert.rejects(createNearbyCollectionStore({ environment: "test" }).touch(now), /requires the shared Inbound Postgres database/);
  } finally {
    if (savedDatabase === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = savedDatabase;
  }
});

test("default coordination uses the database clock even when callers supply a future clock", async () => {
  const { pg, sql } = await database();
  try {
    const instance = createNearbyCollectionStore({ environment: "test", sqlProvider: async () => sql });
    const touched = await instance.touch(now);
    assert.notEqual(touched.nextAttemptAtMs, now, "explicit fake clock is ignored without provided-clock opt-in");
    assert.ok(await instance.claim(randomUUID(), now));
    assert.equal(await instance.claim(randomUUID(), now + NEARBY_POLICY.inactiveRetentionMs), null, "caller clock cannot expire the live lease early");
    assert.equal(await instance.cleanup(now + NEARBY_POLICY.inactiveRetentionMs), 0, "caller clock cannot clean up a current collection");
    assert.ok(await instance.read(now + NEARBY_POLICY.inactiveRetentionMs));
  } finally { await pg.close(); }
});

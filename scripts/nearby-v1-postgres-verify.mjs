#!/usr/bin/env node
/**
 * Part 3B.1.5: real PostgreSQL coordination proof with invented aircraft only.
 *
 * Run with Node's TypeScript strip/import hook, for example:
 *   NEARBY_VERIFY_DATABASE_URL=<dedicated direct Neon URL> node \
 *     --experimental-strip-types --import ./scripts/test-imports.mjs \
 *     scripts/nearby-v1-postgres-verify.mjs \
 *     --metadata <control-plane-proof.json> --output <proof.json>
 *
 * The URL is intentionally never taken from DATABASE_URL. The metadata is an
 * operator-provided proof from the Neon control plane, not a branch identity
 * that can be inferred from SQL. No provider adapters are imported or called.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import pg from "pg";

const ENVIRONMENT = "verify315";
const CLIENT_COUNT = 100;
const EXPECTED_TABLES = ["current_collection", "ranked_view"];
const migrationUrl = new URL("../docs/plugin-v1/migrations/0001_nearby_collection.sql", import.meta.url);
const args = process.argv.slice(2);
function argument(name) {
  const index = args.indexOf(name);
  if (index < 0) return null;
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`${name} needs a value`);
  return args[index + 1];
}
const metadataPath = argument("--metadata");
const outputPath = argument("--output");
const driverModulePath = argument("--driver-module");
const report = {
  stage: "Part 3B.1.5", status: "running", startedAt: new Date().toISOString(),
  fakeDataOnly: true, aviationProviderCalls: 0, productionTableContentQueries: 0,
  fixtureChanges: false, deployments: 0, publicRealAircraftEndpoints: 0,
  tests: [],
};
let control;
const clients = [];
let pendingAcquisitionRelease = () => {};

function barrier() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Test barriers can be rejected while the orchestration is still awaiting a
  // different barrier. Keep that deliberate failure from becoming unhandled.
  promise.catch(() => {});
  return { promise, resolve, reject };
}
async function deadline(promise, label, timeoutMs = 30_000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}
async function test(name, run) {
  const began = performance.now();
  try {
    const details = await run();
    report.tests.push({ name, status: "passed", elapsedMs: Math.round(performance.now() - began), ...details });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    report.tests.push({ name, status: "failed", elapsedMs: Math.round(performance.now() - began),
      error: { name: error.name, code: error.code ?? null, message: error.message } });
    throw error;
  }
}
function validateConfiguration(metadata, connectionString) {
  assert.equal(metadata.isolated, true, "control-plane proof must mark the branch isolated");
  assert.equal(metadata.createdForVerification, true, "reuse of an unrelated database is forbidden");
  assert.equal(metadata.noProductionDataCopied, true, "use an empty database or schema-only branch");
  for (const key of ["projectId", "branchId", "branchName", "endpointHost", "databaseName", "productionBranchId"]) {
    assert.equal(typeof metadata[key], "string", `control-plane proof needs ${key}`);
    assert.ok(metadata[key].length > 0, `control-plane proof needs ${key}`);
  }
  assert.notEqual(metadata.branchId, metadata.productionBranchId, "production branch is forbidden");
  assert.doesNotMatch(metadata.branchName, /^(?:main|production|prod)$/i, "production branch is forbidden");
  assert.match(metadata.branchName, /preview|development|nearby|verif|part.?3b|test/i, "branch name must identify development verification");
  const url = new URL(connectionString);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "expected a PostgreSQL URL");
  assert.match(url.hostname, /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/i, "dedicated Neon endpoint required");
  assert.doesNotMatch(url.hostname, /-pooler\./, "100 distinct sessions require the direct Neon endpoint");
  assert.equal(url.hostname, metadata.endpointHost, "URL must match verified branch endpoint exactly");
  assert.equal(decodeURIComponent(url.pathname.slice(1)), metadata.databaseName, "URL must match verified empty database exactly");
  return url;
}

async function main() {
  assert.ok(metadataPath, "--metadata is required; inspect the isolated Neon branch in the control plane first");
  const connectionString = process.env.NEARBY_VERIFY_DATABASE_URL?.trim();
  assert.ok(connectionString, "NEARBY_VERIFY_DATABASE_URL is required; generic DATABASE_URL is never used");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  validateConfiguration(metadata, connectionString);
  if (driverModulePath) assert.ok(isAbsolute(driverModulePath), "--driver-module must be an absolute path");
  const driver = driverModulePath ? await import(pathToFileURL(driverModulePath).href) : pg;
  assert.equal(typeof driver.Client, "function", "driver module must export Client");
  const { Client } = driver;
  report.transport = driverModulePath ? "injected-driver-module" : "pg-tcp";
  report.neon = { projectId: metadata.projectId, branchId: metadata.branchId, branchName: metadata.branchName,
    databaseName: metadata.databaseName, productionBranchId: metadata.productionBranchId,
    isolated: true, createdForVerification: true, noProductionDataCopied: true,
    proofSource: metadata.proofSource ?? "operator-verified Neon control-plane metadata" };

  // Imports only the approved private SQL store, pure collection/ranking/view
  // logic, and static fixtures. acquisition.server.ts / engine.server.ts are
  // intentionally excluded, so no aviation network path can run here.
  const [storeModule, collectionModule, model, fixtures, areas, ranking, views] = await Promise.all([
    import("../src/lib/nearby-v1/store.server.ts"), import("../src/lib/nearby-v1/collection.ts"),
    import("../src/lib/nearby-v1/model.ts"), import("../src/lib/plugin-v1/fixtures.ts"),
    import("../src/lib/plugin-v1/areas.ts"), import("../src/lib/plugin-v1/ranking.ts"),
    import("../src/lib/nearby-v1/views.ts"),
  ]);
  const { createNearbyCollectionStore } = storeModule;
  const { createNearbyCollectionService, readCollectionHealth } = collectionModule;
  const { NEARBY_POLICY } = model;
  const NOW = Date.parse("2030-01-15T18:00:00Z");
  const fakeResult = (at = NOW, count = 125) => {
    const base = fixtures.fixtureRankingCandidate();
    const observations = Array.from({ length: count }, (_, index) => {
      const cardId = fixtures.fixtureId(index + 1);
      return { ...base, cardId, radarId: cardId, sessionKey: `fake-session-${index}`,
        privateAircraftIdentity: `invented-verification-aircraft-${index}`, observedCallsign: `TST${index + 1}`,
        registration: null, latitude: 41.90 + (index % 25) * 0.001,
        longitude: -87.80 + Math.floor(index / 25) * 0.001,
        route: { originIata: null, destinationIata: null, verification: "unknown", checkedAt: null }, datedBinding: null,
        observedAt: new Date(at).toISOString(), groundTrackDeg: 90,
        freshness: { ageSeconds: 0, state: "fresh" },
        provenance: { source: "invented-postgres-verification", receivedAt: new Date(at).toISOString(),
          positionAgeSeconds: 0, acceptance: "inbound-fusion" } };
    });
    return { observations, partial: false, metadata: { providerCalls: 0, rawCount: count, fusedCount: count,
      rejectedCount: 0, successfulProviders: 0, failedProviders: 0 } };
  };

  const makeClient = (suffix) => new Client({ connectionString,
    application_name: `inbound-nearby-315-${suffix}`, connectionTimeoutMillis: 20_000,
    statement_timeout: 20_000, lock_timeout: 15_000, idle_in_transaction_session_timeout: 20_000 });
  control = makeClient("control");
  await control.connect();
  const identity = (await control.query("select current_database() as database, current_setting('server_version') as server_version, pg_backend_pid() as pid")).rows[0];
  assert.equal(identity.database, metadata.databaseName);
  report.database = { name: identity.database, serverVersion: identity.server_version };
  const catalog = async () => (await control.query(`select table_schema, table_name from information_schema.tables
    where table_type='BASE TABLE' and table_schema not in ('pg_catalog','information_schema')
    order by table_schema, table_name`)).rows;
  const beforeCatalog = await catalog();
  const existingPlugin = beforeCatalog.filter(row => row.table_schema === "inbound_plugin_v1").map(row => row.table_name);
  assert.ok(existingPlugin.length === 0 || JSON.stringify(existingPlugin) === JSON.stringify(EXPECTED_TABLES),
    "isolated schema must be absent or contain only this verification migration's two tables");
  const ddl = await readFile(migrationUrl, "utf8");
  assert.doesNotMatch(ddl.replace(/^--.*$/gm, ""), /(?:alter|drop)\s+table|flight_phase_state|arrival_|user_id|history|archive/i);
  assert.equal((ddl.match(/create table if not exists/g) ?? []).length, 2);
  await control.query("begin");
  try { await control.query(ddl); await control.query("commit"); }
  catch (error) { await control.query("rollback"); throw error; }
  const afterCatalog = await catalog();
  const pluginTables = afterCatalog.filter(row => row.table_schema === "inbound_plugin_v1").map(row => row.table_name);
  assert.deepEqual(pluginTables, EXPECTED_TABLES);
  assert.deepEqual(afterCatalog.filter(row => row.table_schema !== "inbound_plugin_v1"),
    beforeCatalog.filter(row => row.table_schema !== "inbound_plugin_v1"), "migration changes no other table catalog");
  const columns = (await control.query(`select table_name, column_name from information_schema.columns
    where table_schema='inbound_plugin_v1' order by table_name, ordinal_position`)).rows;
  assert.ok(columns.every(row => !/user|viewer|history|archive/i.test(row.column_name)));
  const triggers = (await control.query(`select count(*)::int as count from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid=t.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='inbound_plugin_v1' and not t.tgisinternal`)).rows[0].count;
  assert.equal(triggers, 0, "no user-defined triggers may mutate other schemas");
  const foreignEnvironments = (await control.query("select count(*)::int as count from inbound_plugin_v1.current_collection where environment<>$1", [ENVIRONMENT])).rows[0].count;
  assert.equal(foreignEnvironments, 0, "do not overwrite unrelated plugin rows");
  report.migration = { file: "docs/plugin-v1/migrations/0001_nearby_collection.sql",
    sha256: createHash("sha256").update(ddl).digest("hex"), applied: true,
    tables: pluginTables.map(name => `inbound_plugin_v1.${name}`),
    otherTableCatalogUnchanged: true, oldStagedMigrationApplied: false, automaticMigrationsRun: false };
  process.stdout.write("PASS isolated two-table migration\n");

  // Connect in bounded batches to avoid a connection-establishment burst. All
  // 100 sessions stay simultaneously open for the concurrent request test.
  for (let offset = 0; offset < CLIENT_COUNT; offset += 10) {
    const batch = Array.from({ length: Math.min(10, CLIENT_COUNT - offset) }, (_, i) => makeClient(String(offset + i)));
    clients.push(...batch);
    await Promise.all(batch.map(client => client.connect()));
  }
  const pids = await Promise.all(clients.map(async client => (await client.query("select pg_backend_pid() as pid")).rows[0].pid));
  assert.equal(new Set(pids).size, CLIENT_COUNT, "must be 100 independent live PostgreSQL backend sessions");
  assert.ok(!pids.includes(identity.pid), "control session is also independent");
  report.connections = { requested: CLIENT_COUNT, connected: clients.length, distinctBackendPids: new Set(pids).size,
    backendPids: pids, directEndpoint: true, separateControlConnection: true, transport: report.transport };
  let storeQueries = 0;
  const adaptor = (client, afterRead = null) => Object.assign(async () => [], { query: async (query, values = []) => {
    assert.ok(query.includes("inbound_plugin_v1."), "store queries must stay in the plugin schema");
    assert.doesNotMatch(query, /\b(?:public|flight_phase_state|arrival_projection_state|route_geometry_state)\b/i,
      "production-table SQL is forbidden");
    storeQueries++;
    const result = await client.query(query, values);
    if (afterRead && query.includes("select v.* from inbound_plugin_v1.ranked_view")) await afterRead();
    return result.rows;
  } });
  const store = (index = 0, options = {}) => createNearbyCollectionStore({ environment: ENVIRONMENT,
    sqlProvider: async () => adaptor(clients[index], options.afterRead), clock: options.clock ?? "provided" });
  const clear = async () => { await control.query("delete from inbound_plugin_v1.current_collection where environment=$1", [ENVIRONMENT]); };
  const countRows = async table => {
    assert.ok(EXPECTED_TABLES.includes(table));
    return (await control.query(`select count(*)::int as count from inbound_plugin_v1.${table}`)).rows[0].count;
  };
  const allClaims = at => Promise.all(clients.map((_, i) => store(i).claim(randomUUID(), at)));
  const publish = async (instance, at = NOW, count = 125) => {
    await instance.touch(at);
    const lease = await instance.claim(randomUUID(), at); assert.ok(lease);
    assert.equal(await instance.publish(lease, fakeResult(at, count), at), true);
    return lease;
  };
  await clear();

  await test("100 concurrent Chicago service requests on 100 independent sessions", async () => {
    const started = barrier(), release = barrier(), losersDone = barrier(), failed = barrier();
    pendingAcquisitionRelease = release.resolve;
    let acquisitions = 0, winners = 0, losers = 0;
    const acquire = async () => { acquisitions++; started.resolve(); await release.promise; return fakeResult(); };
    const stores = clients.map((_, i) => {
      const instance = store(i), originalClaim = instance.claim.bind(instance);
      instance.claim = async (...input) => { const lease = await originalClaim(...input); if (lease) winners++; return lease; };
      return instance;
    });
    const requests = stores.map(instance => createNearbyCollectionService({ store: instance, acquire,
      clock: () => NOW, leaseOwner: randomUUID }).request().then(result => {
      if (result.health === "unavailable" && ++losers === 99) losersDone.resolve();
      return result;
    }).catch(error => { failed.reject(error); throw error; }));
    const complete = Promise.all(requests); complete.catch(() => {});
    try {
      await deadline(Promise.race([started.promise, failed.promise]), "acquisition winner");
      await deadline(Promise.race([losersDone.promise, failed.promise]), "99 cold losers");
      assert.equal(acquisitions, 1); assert.equal(winners, 1); assert.equal(losers, 99);
      release.resolve();
      const reads = await deadline(complete, "100 service responses");
      assert.equal(reads.filter(row => row.health === "ok").length, 1);
      assert.equal(reads.filter(row => row.health === "unavailable").length, 99);
      const snapshot = await store().read(NOW); assert.ok(snapshot);
      assert.equal(snapshot.collectionVersion, 1); assert.equal(snapshot.fencingGeneration, 1);
      assert.equal(snapshot.observations.length, 125); assert.equal(snapshot.metadata.providerCalls, 0);
      const warm = await Promise.all(clients.map((_, i) => createNearbyCollectionService({ store: store(i), acquire,
        clock: () => NOW + 1000, leaseOwner: randomUUID }).request()));
      assert.ok(warm.every(row => row.health === "ok" && row.collection.collectionVersion === 1));
      assert.equal(acquisitions, 1); assert.equal(await countRows("current_collection"), 1);
      const view = views.buildNearbyView(snapshot, areas.areaDefinition("preset:chicago"), NOW);
      assert.ok(view.radar.length <= NEARBY_POLICY.maxRadar);
      assert.ok(Buffer.byteLength(JSON.stringify(view.radar)) <= NEARBY_POLICY.maxRadarBytes);
      assert.equal(view.featured.length, 4);
      assert.equal(await store(1).claim(randomUUID(), NOW + NEARBY_POLICY.cadenceMs - 1), null);
      const due = await store(2).claim(randomUUID(), NOW + NEARBY_POLICY.cadenceMs); assert.ok(due);
      assert.equal(due.generation, 2);
      report.concurrent100Acquisitions = acquisitions;
      return { concurrentRequests: 100, exactAcquisitionCount: acquisitions, exactAviationProviderCalls: 0,
        leaseWinners: winners, coldLosersCompletedBeforeAcquisitionRelease: losers,
        collectionVersion: snapshot.collectionVersion, fencingGeneration: snapshot.fencingGeneration,
        rawFakeObservations: 125, acceptedFakeObservations: snapshot.observations.length,
        radarObservations: view.radar.length, radarPayloadBytes: Buffer.byteLength(JSON.stringify(view.radar)),
        featuredFlights: view.featured.length, oneCurrentRow: true, minimumCadenceBoundaryPassed: true };
    } finally { release.resolve(); await complete.catch(() => {}); pendingAcquisitionRelease = () => {}; }
  });

  await test("lease fencing, stale/expired writers, duplicate publication and owner ABA", async () => {
    await clear();
    const first = store(0), second = store(1);
    await first.touch(NOW);
    const original = await first.claim(randomUUID(), NOW); assert.ok(original);
    assert.equal(await second.claim(randomUUID(), NOW + NEARBY_POLICY.leaseMs - 1), null);
    assert.equal(await first.publish(original, fakeResult(), NOW + NEARBY_POLICY.leaseMs), false);
    assert.equal(await first.fail(original, NOW + NEARBY_POLICY.leaseMs), false);
    assert.equal(await second.claim(randomUUID(), NOW + NEARBY_POLICY.leaseMs), null);
    const replacementAt = NOW + NEARBY_POLICY.cadenceMs;
    const replacement = await second.claim(randomUUID(), replacementAt); assert.ok(replacement);
    assert.equal(replacement.generation, original.generation + 1);
    assert.equal(await first.publish(original, fakeResult(), replacementAt), false);
    assert.equal(await first.fail(original, replacementAt), false);
    assert.equal(await second.publish(replacement, fakeResult(replacementAt), replacementAt), true);
    assert.equal(await second.publish(replacement, fakeResult(replacementAt), replacementAt), false);
    assert.equal(await first.publish(original, fakeResult(), replacementAt), false);
    assert.equal((await first.read(replacementAt)).collectionVersion, 1);
    const expiredAt = NOW + NEARBY_POLICY.inactiveRetentionMs;
    assert.equal(await second.cleanup(expiredAt), 1);
    await second.touch(expiredAt);
    const recreated = await second.claim(randomUUID(), expiredAt); assert.ok(recreated);
    assert.equal(recreated.generation, 1);
    assert.equal(await first.publish(original, fakeResult(expiredAt), expiredAt), false);
    assert.equal(await second.publish(recreated, fakeResult(expiredAt), expiredAt), true);
    return { firstGeneration: original.generation, replacementGeneration: replacement.generation,
      expiredWriterRejected: true, stalePublicationRejected: true, staleFailureRejected: true,
      duplicatePublicationRejected: true, collectionVersionIncrementedOnce: true,
      ownerAbaRejectedAfterCleanupAndRecreation: true, crashedLeaseCannotShortenCadence: true };
  });

  await test("ranked-view CAS with simultaneous cold and updated readers", async () => {
    await clear(); const instance = store(); await publish(instance);
    const rank = at => ranking.rankNearbyCandidates(fakeResult(at).observations, areas.areaDefinition("preset:chicago"), at);
    const input = { areaId: "preset:chicago", radiusNm: 38, collectionVersion: 1, nowMs: NOW,
      successfulCollection: true, ranked: rank(NOW) };
    const concurrentViews = async nextInput => {
      const allRead = barrier(); let firstReads = 0;
      const instances = Array.from({ length: 20 }, (_, i) => {
        let first = true;
        return store(i, { afterRead: async () => {
          if (!first) return; first = false;
          if (++firstReads === 20) allRead.resolve();
          await deadline(allRead.promise, "20 simultaneous ranked-view reads");
        } });
      });
      const result = await Promise.allSettled(instances.map(item => item.stableView(nextInput)));
      const failures = result.filter(row => row.status === "rejected");
      if (failures.length) {
        const error = new AggregateError(failures.map(row => row.reason), `${failures.length} real-Postgres ranked-view failures`);
        error.code = failures[0].reason.code;
        error.message += `: ${failures[0].reason.message}`;
        throw error;
      }
      const rows = result.map(row => row.value); assert.ok(rows[0]);
      for (const row of rows) assert.deepEqual(row, rows[0]);
      return rows;
    };
    const seeded = await concurrentViews(input);
    const readRevision = async () => (await control.query("select revision, applied_collection_version from inbound_plugin_v1.ranked_view where environment=$1 and area_id='preset:chicago'", [ENVIRONMENT])).rows[0];
    assert.equal(Number((await readRevision()).revision), 1);
    const nextAt = NOW + NEARBY_POLICY.cadenceMs; await publish(store(99), nextAt);
    const secondInput = { ...input, collectionVersion: 2, nowMs: nextAt, ranked: rank(nextAt) };
    const updated = await concurrentViews(secondInput);
    assert.equal(Number((await readRevision()).revision), 2);
    assert.equal(Number((await readRevision()).applied_collection_version), 2);
    assert.deepEqual(updated[0].slots, seeded[0].slots, "incumbent slots survive one new collection version");
    assert.equal((await store(98).stableView({ ...input, nowMs: nextAt })).collectionVersion, 2);
    assert.equal((await store(97).stableView({ ...secondInput, collectionVersion: 3 })).collectionVersion, 2);
    assert.deepEqual((await store(96).stableView({ ...secondInput, successfulCollection: false, ranked: [] })).slots, updated[0].slots);
    const ord = await store(95).stableView({ ...secondInput, areaId: "airport:KORD", radiusNm: 25,
      successfulCollection: false }); assert.equal(ord.collectionVersion, 2);
    await control.query("update inbound_plugin_v1.ranked_view set inactive_expires_at=$1 where environment=$2 and area_id='preset:chicago'", [new Date(nextAt), ENVIRONMENT]);
    assert.equal(await instance.readStableView("preset:chicago", 38, nextAt), null);
    assert.ok(await instance.stableView(secondInput));
    assert.equal(Number((await readRevision()).revision), 3);
    return { independentConcurrentViewConnections: 20, initialRevision: 1, updatedRevision: 2,
      appliedCollectionVersion: 2, staleVersionCannotOverwrite: true, unpublishedFutureVersionRejected: true,
      outageSlotsPreserved: true, coldOutageViewSeedsAcceptedSnapshot: true,
      expiredViewLogicallyHiddenAndReplaced: true, postExpiryRevision: 3 };
  });

  await test("failure backoff, one winner per retry and bounded last-safe serving", async () => {
    await clear(); const instance = store(); await publish(instance, NOW, 1);
    const initial = await instance.read(NOW); let at = NOW + NEARBY_POLICY.cadenceMs;
    const observedBackoff = [];
    for (const expectedDelay of [20, 40, 80, 120, 120]) {
      await Promise.all(clients.map((_, i) => store(i).touch(at)));
      const leases = await allClaims(at), winnerIndices = leases.flatMap((lease, i) => lease ? [i] : []);
      assert.equal(winnerIndices.length, 1);
      const winner = winnerIndices[0]; assert.equal(await store(winner).fail(leases[winner], at), true);
      assert.equal(await store((winner + 1) % 100).fail(leases[winner], at), false);
      const snapshot = await store(99).read(at); assert.ok(snapshot);
      assert.equal(snapshot.collectionVersion, 1); assert.equal(snapshot.acceptedSnapshotAtMs, NOW);
      assert.deepEqual(snapshot.observations, initial.observations); assert.deepEqual(snapshot.metadata, initial.metadata);
      assert.equal(snapshot.lastAttemptFailed, true); assert.equal(snapshot.nextAttemptAtMs, at + expectedDelay * 1000);
      assert.equal(await instance.claim(randomUUID(), snapshot.nextAttemptAtMs - 1), null);
      observedBackoff.push((snapshot.nextAttemptAtMs - at) / 1000);
      at = snapshot.nextAttemptAtMs;
    }
    const lastSafe = await instance.read(at); assert.ok(lastSafe);
    assert.equal(readCollectionHealth(lastSafe, NOW + 20_000).health, "stale");
    assert.equal(readCollectionHealth(lastSafe, NOW + NEARBY_POLICY.hardStaleMs).observations.length, 1);
    assert.equal(readCollectionHealth(lastSafe, NOW + NEARBY_POLICY.hardStaleMs + 1).health, "unavailable");
    assert.equal(readCollectionHealth(lastSafe, NOW + NEARBY_POLICY.hardStaleMs + 1).observations.length, 0);
    assert.equal(lastSafe.observations.length, 1, "stored last-safe snapshot stays current-state only");
    await publish(instance, at, 1); const recovered = await instance.read(at);
    assert.equal(recovered.collectionVersion, 2); assert.equal(recovered.failureBackoffSeconds, 20);
    assert.equal(recovered.lastAttemptFailed, false); assert.equal(readCollectionHealth(recovered, at).health, "ok");
    assert.equal(await countRows("current_collection"), 1);
    return { simultaneousClaimantsPerFailure: 100, leaseWinnersPerFailure: 1, observedBackoffSeconds: observedBackoff,
      failureDoesNotIncrementVersion: true, lastSafeSnapshotAndMetadataPreserved: true,
      lastSafeUsableAt120Seconds: true, lastSafeHiddenAfter120Seconds: true,
      successfulRecoveryVersion: 2, recoveryBackoffResetSeconds: 20, currentRowsAfterRetries: 1 };
  });

  await test("active/inactive demand, bounded shared views and cascade cleanup", async () => {
    await clear(); let now = NOW, acquisitions = 0;
    const instance = store();
    const service = createNearbyCollectionService({ store: instance, clock: () => now, leaseOwner: randomUUID,
      acquire: async () => { acquisitions++; return fakeResult(now, 1); } });
    await service.request(); now += NEARBY_POLICY.cadenceMs; await service.tick();
    assert.equal(acquisitions, 2);
    now = NOW + NEARBY_POLICY.activeForMs; await service.tick(); assert.equal(acquisitions, 2);
    await service.request(); assert.equal(acquisitions, 3);
    const snapshot = await instance.read(now); assert.equal(snapshot.collectionVersion, 3);
    for (const areaId of ["preset:chicago", "airport:KORD", "airport:KMDW"]) {
      for (const radiusNm of [12, 25, 38]) {
        await instance.stableView({ areaId, radiusNm, collectionVersion: 3, nowMs: now, successfulCollection: true,
          ranked: ranking.rankNearbyCandidates(snapshot.observations, areas.areaDefinition(areaId), now) });
      }
    }
    assert.equal(await countRows("current_collection"), 1); assert.equal(await countRows("ranked_view"), 9);
    now = snapshot.inactiveExpiresAtMs;
    assert.equal(await instance.read(now), null);
    assert.equal(await instance.readStableView("preset:chicago", 38, now), null);
    assert.equal(await countRows("current_collection"), 1, "logical expiry precedes physical cleanup");
    const cleanups = await Promise.all(clients.map((_, i) => store(i).cleanup(now)));
    assert.equal(cleanups.reduce((total, count) => total + count, 0), 1);
    assert.equal(cleanups.filter(count => count === 1).length, 1);
    assert.equal(await countRows("current_collection"), 0); assert.equal(await countRows("ranked_view"), 0);
    assert.equal(await service.cleanup(), 0);
    await service.request(); assert.equal(acquisitions, 4); assert.equal((await instance.read(now)).collectionVersion, 1);
    return { acquisitionsBeforeInactivity: 2, acquisitionsAfterInactiveTick: 2,
      acquisitionsAfterRequestReactivation: 3, boundedCollectionRows: 1, boundedPresetViewRows: 9,
      logicalExpiryPassed: true, simultaneousCleanupConnections: 100, exactDeletedCollectionRows: 1,
      rankedViewRowsAfterCascade: 0, repeatedCleanupDeletedRows: 0, recreatedCurrentVersion: 1,
      noUserSpecificCollectionRows: true, noAppendOnlyHistoryTables: true };
  });

  await test("database clock ignores forged future caller times", async () => {
    await clear(); const instance = store(99, { clock: "database" });
    const databaseBefore = Date.parse((await control.query("select clock_timestamp() as now")).rows[0].now.toISOString());
    const touched = await instance.touch(NOW);
    assert.ok(Math.abs(touched.nextAttemptAtMs - databaseBefore) < 5000);
    assert.notEqual(touched.nextAttemptAtMs, NOW);
    const lease = await instance.claim(randomUUID(), NOW); assert.ok(lease);
    assert.equal(await instance.claim(randomUUID(), NOW + NEARBY_POLICY.inactiveRetentionMs), null);
    assert.equal(await instance.cleanup(NOW + NEARBY_POLICY.inactiveRetentionMs), 0);
    assert.ok(await instance.read(NOW + NEARBY_POLICY.inactiveRetentionMs));
    const realAt = Date.parse((await control.query("select clock_timestamp() as now")).rows[0].now.toISOString());
    assert.equal(await instance.publish(lease, fakeResult(realAt, 1), realAt), true);
    const snapshot = await instance.read(realAt);
    assert.equal(snapshot.collectionVersion, 1); assert.ok(Math.abs(snapshot.acceptedSnapshotAtMs - realAt) < 5000);
    return { defaultDatabaseClockPassed: true, callerCannotExpireLeaseOrCollection: true,
      realClockPublicationVersion: 1, acceptedSnapshotUsesDatabaseClock: true };
  });

  await test("publication payload and database bounds", async () => {
    await clear(); const instance = store(); await instance.touch(NOW);
    const lease = await instance.claim(randomUUID(), NOW); assert.ok(lease);
    await assert.rejects(instance.publish(lease, fakeResult(NOW, NEARBY_POLICY.maxAccepted + 1), NOW), /Invalid Nearby publication/);
    const invalid = fakeResult(NOW, 1); invalid.observations[0].acceptedPosition = false;
    await assert.rejects(instance.publish(lease, invalid, NOW), /Invalid accepted Nearby observation/);
    await assert.rejects(control.query("update inbound_plugin_v1.current_collection set collection_key='viewer:123' where environment=$1", [ENVIRONMENT]), error => error.code === "23514");
    await assert.rejects(control.query("update inbound_plugin_v1.current_collection set accepted_snapshot_at=$1,accepted_collection=$2::jsonb where environment=$3", [new Date(NOW), JSON.stringify(Array(1001).fill({})), ENVIRONMENT]), error => error.code === "23514");
    assert.equal((await instance.read(NOW)).collectionVersion, 0);
    return { maxAcceptedObservations: NEARBY_POLICY.maxAccepted, oversizedPublicationRejected: true,
      unacceptedPositionRejected: true, perViewerCollectionKeyRejectedByPostgres: true,
      oversizedArrayRejectedByPostgres: true, invalidWritesDoNotIncrementVersion: true };
  });

  await clear();
  assert.equal(await countRows("current_collection"), 0); assert.equal(await countRows("ranked_view"), 0);
  assert.deepEqual((await catalog()).filter(row => row.table_schema !== "inbound_plugin_v1"),
    beforeCatalog.filter(row => row.table_schema !== "inbound_plugin_v1"));
  report.finalState = { currentCollectionRows: 0, rankedViewRows: 0, schemaRetainedForReview: true,
    removableWithIsolatedBranch: true, otherTableCatalogUnchanged: true, storeQueries,
    noProductionConnections: true, noProductionTableContentsReadOrWritten: true };
  report.status = "passed";
}

try { await main(); }
catch (error) {
  report.status = "failed";
  report.error = { name: error.name, code: error.code ?? null, message: error.message };
  if (error instanceof AggregateError) report.error.causes = error.errors.map(item => ({ code: item.code ?? null, message: item.message }));
  process.stderr.write(`FAIL ${error.message}\n`);
  process.exitCode = 1;
} finally {
  pendingAcquisitionRelease();
  await Promise.allSettled(clients.map(client => client.end()));
  if (control) await control.end().catch(() => {});
  report.finishedAt = new Date().toISOString();
  if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

/**
 * Verification only: production Nearby store, independent real PostgreSQL
 * sessions, synthetic observations, and run-scoped rows. This script never
 * migrates, acquires aircraft, deploys, or falls back to DATABASE_URL.
 *
 * Run with Node's TypeScript resolver:
 * node --experimental-strip-types --import ./scripts/test-imports.mjs \
 *   scripts/nearby-postgres-verify.mjs
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import pg from "pg";

const HELP = `Required isolated-target environment:
  NEARBY_VERIFY_DATABASE_URL       Unpooled plugin-v1-dev connection URL
  NEARBY_VERIFY_EXPECTED_HOST      Independently verified Neon endpoint host
  NEARBY_VERIFY_EXPECTED_DATABASE  Independently verified database name
  NEARBY_VERIFY_BRANCH_NAME        Must be plugin-v1-dev
  NEARBY_VERIFY_BRANCH_ID          Independently verified Neon branch ID
Optional:
  NEARBY_VERIFY_SESSIONS           Independent sessions, 2..100 (default 100)
  --driver-module /absolute/path   Temporary official Neon WebSocket driver

The branch-to-endpoint association must be verified in Neon before execution.
No default DATABASE_URL is used. No migration or provider code is imported.
`;

function configuration(env) {
  const required = ["NEARBY_VERIFY_DATABASE_URL", "NEARBY_VERIFY_EXPECTED_HOST", "NEARBY_VERIFY_EXPECTED_DATABASE", "NEARBY_VERIFY_BRANCH_NAME", "NEARBY_VERIFY_BRANCH_ID"];
  for (const key of required) assert.ok(env[key]?.trim(), `Missing explicit ${key}`);
  assert.equal(env.NEARBY_VERIFY_BRANCH_NAME, "plugin-v1-dev", "Only the authorized isolated branch is allowed");
  assert.match(env.NEARBY_VERIFY_BRANCH_ID, /^br-[a-z0-9-]+$/, "Invalid explicit Neon branch ID");
  const url = new URL(env.NEARBY_VERIFY_DATABASE_URL);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "Expected a PostgreSQL connection URL");
  assert.equal(url.hostname, env.NEARBY_VERIFY_EXPECTED_HOST, "Connection host differs from independently verified host");
  assert.match(url.hostname, /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/, "Only explicit Neon endpoint hosts are allowed");
  assert.ok(!url.hostname.split(".")[0].endsWith("-pooler"), "Use an unpooled endpoint for distinct real PostgreSQL sessions");
  assert.equal(decodeURIComponent(url.pathname.slice(1)), env.NEARBY_VERIFY_EXPECTED_DATABASE, "Connection database differs from independently verified database");
  assert.ok(url.username && url.password, "An explicitly authenticated verification connection is required");
  const sessions = Number(env.NEARBY_VERIFY_SESSIONS ?? 100);
  assert.ok(Number.isInteger(sessions) && sessions >= 2 && sessions <= 100, "NEARBY_VERIFY_SESSIONS must be an integer from 2 to 100");
  const driverIndex = process.argv.indexOf("--driver-module");
  const driverModule = driverIndex < 0 ? null : process.argv[driverIndex + 1];
  if (driverIndex >= 0) assert.ok(driverModule && isAbsolute(driverModule), "--driver-module requires an absolute path to the temporary official driver");
  // Do not let connection-string SSL options override certificate verification.
  for (const key of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(key);
  return { connectionString: url.toString(), host: url.hostname, database: env.NEARBY_VERIFY_EXPECTED_DATABASE,
    branchName: env.NEARBY_VERIFY_BRANCH_NAME, branchId: env.NEARBY_VERIFY_BRANCH_ID, sessions, driverModule };
}

function syntheticPublication(at) {
  const observedAt = new Date(at).toISOString();
  return {
    observations: [{
      cardId: "nearby-verify-card", privateAircraftIdentity: "synthetic-nearby-verify", sessionKey: "nearby-verify-session",
      observedCallsign: "TEST123", registration: null, latitude: 41.91, longitude: -87.81,
      altitudeFt: 10000, groundspeedKt: 220, verticalRateFpm: 0, onGround: false,
      observedAt, positionKind: "observed", acceptedPosition: true, identityConflict: false,
      typeCode: null, category: null, operator: null, interesting: false,
      route: { originIata: null, destinationIata: null, verification: "unknown", checkedAt: null }, datedBinding: null,
      radarId: "nearby-verify-radar", groundTrackDeg: 90, freshness: { ageSeconds: 0, state: "fresh" },
      provenance: { source: "synthetic-verification", receivedAt: observedAt, positionAgeSeconds: 0, acceptance: "inbound-fusion" },
    }],
    partial: false,
    metadata: { providerCalls: 0, rawCount: 0, fusedCount: 0, rejectedCount: 0, successfulProviders: 0, failedProviders: 0 },
  };
}

function sqlFor(client) {
  const query = async (text, values = []) => {
    assert.match(text, /inbound_plugin_v1\.(?:current_collection|ranked_view)/, "Store SQL must stay in the private plugin schema");
    assert.doesNotMatch(text, /\b(?:public|flight_phase_state|arrival_projection_state|route_geometry_state)\b/i, "Production flight-table SQL is forbidden");
    return (await client.query(text, values)).rows;
  };
  return Object.assign(async (strings, ...values) => {
    const text = strings.reduce((query, part, index) => query + (index ? `$${index}` : "") + part, "");
    return query(text, values);
  }, { query });
}

function publicError(error) {
  // Driver failures can include a connection URL. Never echo credentials.
  const message = String(error?.message ?? error).replace(/postgres(?:ql)?:\/\/\S+/gi, "[redacted connection]");
  return { name: error?.name ?? "Error", code: error?.code ?? null, message };
}

async function verify(config) {
  const driver = config.driverModule ? await import(pathToFileURL(config.driverModule).href) : pg;
  const Client = driver.Client ?? driver.default?.Client;
  assert.equal(typeof Client, "function", "The supplied PostgreSQL driver must export Client");
  // Type-only db imports in the store disappear; its default db bootstrap is
  // never used because every instance receives a session-specific Sql adapter.
  const { createNearbyCollectionStore } = await import("../src/lib/nearby-v1/store.server.ts");
  const { NEARBY_POLICY } = await import("../src/lib/nearby-v1/model.ts");
  const { CHICAGO_COLLECTION } = await import("../src/lib/plugin-v1/areas.ts");
  const runId = randomUUID();
  const environmentPrefix = `verify-${runId.slice(0, 8)}`;
  const environments = new Set();
  const clients = [];
  const tests = [];
  const report = { runId, source: "production createNearbyCollectionStore", target: { branchName: config.branchName,
    branchId: config.branchId, host: config.host, database: config.database }, independentConnections: config.sessions,
    distinctBackendPids: 0, aviationProviderCalls: 0, syntheticDataOnly: true,
    transport: config.driverModule ? "injected-official-driver" : "pg-tcp", tests, cleanup: null };
  const environment = (suffix) => {
    const value = `${environmentPrefix}-${suffix}`;
    assert.ok(value.length <= 32); environments.add(value); return value;
  };
  const store = (client, env, clock = "provided") => createNearbyCollectionStore({ environment: env, clock, sqlProvider: async () => sqlFor(client) });
  const test = async (name, body) => {
    const started = performance.now();
    try { const evidence = await body(); tests.push({ name, status: "passed", durationMs: Math.round(performance.now() - started), evidence }); }
    catch (error) { tests.push({ name, status: "failed", durationMs: Math.round(performance.now() - started), error: publicError(error) }); throw error; }
  };
  let failure;
  try {
    // Connect the first session and validate the explicitly selected target and
    // existing migration before opening the remaining independent sessions.
    const makeClient = () => new Client({ connectionString: config.connectionString, ssl: { rejectUnauthorized: true },
      application_name: `nearby-verify-${runId.slice(0, 8)}`, connectionTimeoutMillis: 20000, query_timeout: 30000,
      statement_timeout: 20000, lock_timeout: 15000, idle_in_transaction_session_timeout: 20000 });
    const first = makeClient();
    clients.push(first); await first.connect();
    const [{ database, collection, ranked }] = (await first.query("select current_database() as database, to_regclass('inbound_plugin_v1.current_collection')::text as collection, to_regclass('inbound_plugin_v1.ranked_view')::text as ranked")).rows;
    assert.equal(database, config.database, "Server database does not match the explicitly approved target");
    assert.equal(collection, "inbound_plugin_v1.current_collection", "0006 must already be applied by the operator to the isolated branch");
    assert.equal(ranked, "inbound_plugin_v1.ranked_view", "0006 must already be applied by the operator to the isolated branch");
    // A bounded connection-establishment burst still leaves every contender
    // simultaneously connected before the claim barrier.
    for (let remaining = config.sessions - 1; remaining > 0; remaining -= 10) {
      const batch = Array.from({ length: Math.min(10, remaining) }, makeClient);
      clients.push(...batch); await Promise.all(batch.map(client => client.connect()));
    }
    const identities = await Promise.all(clients.map(async client => (await client.query("select pg_backend_pid() as pid,current_database() as database")).rows[0]));
    assert.ok(identities.every(value => value.database === config.database));
    report.distinctBackendPids = new Set(identities.map(value => value.pid)).size;
    assert.equal(report.distinctBackendPids, config.sessions, "Each contender must use a distinct real PostgreSQL backend");

    await test("simultaneous database-clock claim has exactly one winner", async () => {
      const env = environment("claim");
      const stores = clients.map(client => store(client, env, "database"));
      const deliberatelyWrongCallerClock = Date.UTC(2099, 0, 1);
      const touched = await stores[0].touch(deliberatelyWrongCallerClock);
      assert.notEqual(touched.nextAttemptAtMs, deliberatelyWrongCallerClock, "Default store must use the PostgreSQL clock");
      const leases = await Promise.all(stores.map(instance => instance.claim(randomUUID(), deliberatelyWrongCallerClock)));
      const winners = leases.filter(Boolean);
      assert.equal(winners.length, 1);
      const winnerIndex = leases.findIndex(Boolean);
      assert.equal(winners[0].generation, 1);
      assert.equal(await stores[winnerIndex].publish(winners[0], syntheticPublication(Date.now()), Date.now()), true);
      const cold = await stores[(winnerIndex + 1) % stores.length].read(deliberatelyWrongCallerClock);
      assert.equal(cold.collectionVersion, 1); assert.equal(cold.fencingGeneration, 1);
      assert.equal(await stores[0].claim(randomUUID(), deliberatelyWrongCallerClock), null, "Caller future time cannot bypass live cadence");
      return { contenders: stores.length, distinctBackendPids: report.distinctBackendPids, winners: winners.length,
        collectionVersion: cold.collectionVersion, fencingGeneration: cold.fencingGeneration, databaseClockUsed: true };
    });

    const at = Date.UTC(2030, 0, 15, 18);
    await test("expired lease cannot publish even before a replacement claim", async () => {
      const env = environment("expired"), writer = store(clients[0], env), reader = store(clients[1], env);
      await writer.touch(at); const lease = await writer.claim(randomUUID(), at); assert.ok(lease);
      const expiredAt = at + NEARBY_POLICY.leaseMs;
      assert.equal(await writer.publish(lease, syntheticPublication(expiredAt), expiredAt), false);
      assert.equal(await writer.fail(lease, expiredAt), false);
      assert.equal(await reader.claim(randomUUID(), expiredAt), null, "Lease expiry must not bypass the 20-second cadence reservation");
      assert.equal((await reader.read(expiredAt)).collectionVersion, 0);
      return { leaseMs: NEARBY_POLICY.leaseMs, publishRejected: true, failRejected: true, cadencePreserved: true, collectionVersion: 0 };
    });

    await test("replacement after expiry fences stale writer and duplicate publication", async () => {
      const env = environment("fence"), first = store(clients[0], env), second = store(clients[1], env);
      await first.touch(at); const oldLease = await first.claim(randomUUID(), at); assert.ok(oldLease);
      const replacementAt = at + NEARBY_POLICY.cadenceMs;
      const replacement = await second.claim(randomUUID(), replacementAt); assert.ok(replacement);
      assert.equal(replacement.generation, oldLease.generation + 1);
      assert.equal(await first.publish(oldLease, syntheticPublication(replacementAt), replacementAt), false);
      assert.equal(await first.fail(oldLease, replacementAt), false);
      assert.equal(await second.publish(replacement, syntheticPublication(replacementAt), replacementAt), true);
      assert.equal(await second.publish(replacement, syntheticPublication(replacementAt), replacementAt), false);
      const cold = await first.read(replacementAt);
      assert.equal(cold.collectionVersion, 1); assert.equal(cold.fencingGeneration, 2);
      return { oldGeneration: oldLease.generation, replacementGeneration: replacement.generation,
        stalePublishRejected: true, staleFailRejected: true, duplicatePublishRejected: true, collectionVersion: 1 };
    });

    await test("failure backoff is 20/40/80/120 seconds and success resets it", async () => {
      const env = environment("backoff"), first = store(clients[0], env), second = store(clients[1], env);
      await first.touch(at); const initial = await first.claim(randomUUID(), at); assert.ok(initial);
      assert.equal(await first.publish(initial, syntheticPublication(at), at), true);
      let current = at + NEARBY_POLICY.cadenceMs;
      const observedDelays = [];
      for (const [index, expectedDelay] of [20, 40, 80, 120, 120].entries()) {
        const writer = index % 2 ? second : first, reader = index % 2 ? first : second;
        await writer.touch(current); const lease = await writer.claim(randomUUID(), current); assert.ok(lease);
        assert.equal(await writer.fail(lease, current), true);
        const saved = await reader.read(current);
        const delay = (saved.nextAttemptAtMs - current) / 1000; observedDelays.push(delay);
        assert.equal(delay, expectedDelay); assert.equal(saved.collectionVersion, 1);
        assert.equal(saved.acceptedSnapshotAtMs, at); assert.deepEqual(saved.observations, syntheticPublication(at).observations);
        assert.equal(saved.lastAttemptFailed, true);
        assert.equal(await reader.claim(randomUUID(), saved.nextAttemptAtMs - 1), null);
        current = saved.nextAttemptAtMs;
      }
      await second.touch(current); const recoveredLease = await second.claim(randomUUID(), current); assert.ok(recoveredLease);
      assert.equal(await second.publish(recoveredLease, syntheticPublication(current), current), true);
      const recovered = await first.read(current);
      assert.equal(recovered.collectionVersion, 2); assert.equal(recovered.failureBackoffSeconds, 20); assert.equal(recovered.lastAttemptFailed, false);
      return { observedDelaysSeconds: observedDelays, lastSafePreservedDuringFailures: true,
        recoveredVersion: recovered.collectionVersion, resetBackoffSeconds: recovered.failureBackoffSeconds };
    });

    await test("inactive retention cleanup is scoped and cascades only its ranked view", async () => {
      const env = environment("cleanup"), otherEnv = environment("sentinel");
      const first = store(clients[0], env), second = store(clients[1], env), sentinel = store(clients[1], otherEnv);
      await first.touch(at); await sentinel.touch(at + 1000);
      const lease = await first.claim(randomUUID(), at); assert.ok(lease);
      assert.equal(await first.publish(lease, syntheticPublication(at), at), true);
      const view = await first.stableView({ areaId: "preset:chicago", radiusNm: 38, collectionVersion: 1,
        nowMs: at, successfulCollection: true, ranked: [] }); assert.ok(view);
      const expiredAt = at + NEARBY_POLICY.inactiveRetentionMs;
      assert.equal(await second.cleanup(expiredAt - 1), 0); assert.ok(await second.read(expiredAt - 1));
      assert.equal(await second.read(expiredAt), null, "Logical expiry occurs before physical cleanup");
      assert.equal(await second.readStableView("preset:chicago", 38, expiredAt), null);
      assert.equal(await second.cleanup(expiredAt), 1);
      const [{ count }] = (await clients[0].query("select count(*)::int as count from inbound_plugin_v1.ranked_view where environment=$1 and collection_key=$2", [env, CHICAGO_COLLECTION.id])).rows;
      assert.equal(count, 0); assert.ok(await sentinel.read(expiredAt), "Another environment must remain intact");
      assert.equal(await second.cleanup(expiredAt), 0);
      return { inactiveRetentionMs: NEARBY_POLICY.inactiveRetentionMs, deletedCollections: 1, remainingRankedViews: count,
        logicalExpiryEnforced: true, otherEnvironmentUntouched: true, repeatCleanupDeleted: 0 };
    });
  } catch (error) { failure = error; }
  finally {
    if (clients[0] && environments.size) {
      try {
        const removed = await clients[0].query("delete from inbound_plugin_v1.current_collection where environment=any($1::text[]) and collection_key=$2 returning environment", [[...environments], CHICAGO_COLLECTION.id]);
        const [{ count }] = (await clients[0].query("select count(*)::int as count from inbound_plugin_v1.current_collection where environment=any($1::text[]) and collection_key=$2", [[...environments], CHICAGO_COLLECTION.id])).rows;
        assert.equal(count, 0); report.cleanup = { runScopedEnvironments: environments.size, removedCollections: removed.rowCount, remainingCollections: count };
      } catch (error) { report.cleanup = { error: publicError(error) }; failure ??= error; }
    }
    const closed = await Promise.allSettled(clients.map(client => client.end()));
    const closeFailure = closed.find(result => result.status === "rejected");
    if (closeFailure) failure ??= closeFailure.reason;
  }
  report.passed = tests.filter(value => value.status === "passed").length;
  report.failed = tests.filter(value => value.status === "failed").length;
  report.status = failure ? "failed" : "passed";
  if (failure) report.error = publicError(failure);
  return report;
}

if (process.argv.includes("--help")) console.log(HELP);
else {
  try {
    const report = await verify(configuration(process.env));
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "passed") process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ status: "refused", aviationProviderCalls: 0, error: publicError(error) }, null, 2));
    process.exitCode = 1;
  }
}

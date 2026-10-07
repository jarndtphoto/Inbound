#!/usr/bin/env node
/** Private real-Postgres verification only. All aircraft and routes are invented.
 * DATABASE_URL must remain unset. Run only after approved check/build gates:
 * NEARBY_VERIFY_DATABASE_URL=<fresh direct schema-only Neon URL> node
 * --experimental-strip-types --import ./scripts/test-imports.mjs
 * docs/plugin-v1/verification/part-3b2-1/harness.mjs
 * --metadata <branch.json> --gates <gates.json> --source-sha <exact HEAD>
 * --driver-module <absolute optional pg-compatible module> --output <result.json>
 * Only the known failed cleanup checkpoint may resume without any new DDL:
 * --resume-migrations <preserved failed-result.json>
 */
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import pg from "pg";

const ROOT = new URL("../../../../", import.meta.url);
const IMPLEMENTATION = "11abfb4896658f22525433a40d3e1ac637e2cecb";
const EXCLUDED_MAIN_BRANCH = "br-late-forest-au7csk9x";
const ENV = "verify321";
const NOW = Date.parse("2030-01-15T18:00:00Z");
const N = 100;
const TABLES = ["current_collection", "ranked_view", "route_construction_budget", "route_hint"];
const MIGRATIONS = ["docs/plugin-v1/migrations/0006_nearby_collection.sql", "docs/plugin-v1/migrations/0007_route_hint.sql"];
const RESUMABLE_CHECKPOINT_SUITES = [
  "100 independent normal viewers: one fake aircraft acquisition, zero route lookups",
  "real cold-snapshot route renderer/ranking/privacy integration",
  "100 explicit construction workers share two cycle winners and six rolling starts",
  "100 same-callsign claims collapse to one lease and charge; hits charge zero",
  "positive/negative TTL reuse, exact expiry and sixty-second failure cooldown",
  "expired/crashed leases, stale owners and duplicate route publications are fenced",
  "actual cycle identity and exact rolling-minute boundary enforced across independent sessions",
  "current/fresh/active/successful collection required; environment state isolated",
  "cleanup/recreation preserve quota; 100 concurrent cleanup and claim operations remain bounded",
];
const args = process.argv.slice(2);
function argument(name, required = false) {
  const index = args.indexOf(name);
  const value = index < 0 ? null : args[index + 1];
  assert.ok(!required || value && !value.startsWith("--"), `${name} is required`);
  assert.ok(index < 0 || value && !value.startsWith("--"), `${name} requires a value`);
  return value;
}
const outputPath = argument("--output");
const report = { stage: "Part 3B.2.1", status: "running", startedAt: new Date().toISOString(),
  implementationCommit: IMPLEMENTATION, fakeAircraftOnly: true, fakeRoutesOnly: true,
  fakeAcquisitionCalls: 0, fakeRouteLookupCalls: 0, routeClaimWinners: 0, directFixtureSeeds: 0,
  liveProviderCalls: 0, productionDataQueries: 0, deployments: 0, publicEndpoints: 0,
  unexpectedStoreSqlErrors: [], tests: [] };
const clients = [];
let control, releasePending = () => {};
const originalFetch = globalThis.fetch;
let allowedDatabaseHost = null;
globalThis.fetch = async function guardedFetch(input, ...rest) {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.hostname !== allowedDatabaseHost) {
    report.liveProviderCalls++;
    throw new Error("External/provider HTTP calls are forbidden during this verification");
  }
  return originalFetch.call(this, input, ...rest);
};
function barrier() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  promise.catch(() => {});
  return { promise, resolve, reject };
}
async function deadline(promise, label, milliseconds = 30000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds}ms`)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}
async function test(name, run) {
  const start = performance.now();
  const sqlErrorsBefore = report.unexpectedStoreSqlErrors.length;
  try {
    const details = await run();
    assert.equal(report.unexpectedStoreSqlErrors.length, sqlErrorsBefore,
      "unexpected store SQL failures must not be hidden by fail-closed application catches");
    report.tests.push({ name, status: "passed", elapsedMs: Math.round(performance.now() - start), ...details });
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    report.tests.push({ name, status: "failed", elapsedMs: Math.round(performance.now() - start),
      error: { name: error.name, code: error.code ?? null, message: error.message } });
    throw error;
  }
}
const iso = at => new Date(at).toISOString();
const uuid = index => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;

async function main() {
  const sourceSha = argument("--source-sha", true);
  const metadata = JSON.parse(await readFile(argument("--metadata", true), "utf8"));
  const gates = JSON.parse(await readFile(argument("--gates", true), "utf8"));
  const resumePath = argument("--resume-migrations");
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim(), sourceSha);
  execFileSync("git", ["merge-base", "--is-ancestor", IMPLEMENTATION, sourceSha], { cwd: ROOT });
  const runtimeFiles = execFileSync("git", ["ls-files", "src"], { cwd: ROOT, encoding: "utf8" }).trim().split("\n")
    .filter(path => !/(?:^|\/)(?:tests?|__tests__)(?:\/|[.-])|\.test\.[^.]+$|(?:^|\/)test-[^/]+\.[^.]+$/.test(path));
  execFileSync("git", ["diff", "--exit-code", IMPLEMENTATION, "--", ...runtimeFiles, ...MIGRATIONS], { cwd: ROOT });
  assert.equal(process.env.DATABASE_URL, undefined, "normal DATABASE_URL must remain unset");
  assert.equal(gates.sourceSha, sourceSha);
  assert.equal(gates.implementationSha, IMPLEMENTATION);
  assert.equal(gates.databaseUrlUnset, true); assert.equal(gates.sequential, true);
  assert.equal(gates.nearbyVerifyDatabaseUrlUnset, true);
  for (const name of ["check", "build"]) {
    assert.equal(gates[name]?.passed, true, `${name} must pass before a database connection`);
    assert.equal(gates[name]?.exitCode, 0);
  }
  for (const [path, sha256] of Object.entries({ ...gates.testOnlyFixSha256, ...gates.patchFileHashes })) {
    assert.equal(createHash("sha256").update(await readFile(new URL(path, ROOT))).digest("hex"), sha256,
      `gate-tested file changed: ${path}`);
  }
  for (const key of ["projectId", "branchId", "branchName", "endpointHost", "databaseName", "productionBranchId"])
    assert.equal(typeof metadata[key], "string", `missing branch control-plane evidence: ${key}`);
  assert.equal(metadata.creationMode, "schema-only"); assert.equal(metadata.isolated, true);
  assert.equal(metadata.createdForVerification, true); assert.equal(metadata.noProductionDataCopied, true);
  assert.equal(metadata.productionBranchId, EXCLUDED_MAIN_BRANCH, "known production main must be explicitly excluded");
  assert.notEqual(metadata.branchId, metadata.productionBranchId);
  assert.doesNotMatch(metadata.branchName, /^(main|prod|production)$/i);
  assert.match(metadata.branchName, /3b2[-_.]?1|3b[-_.]?2[-_.]?1|321/i);
  if (metadata.sourceCommit) assert.equal(metadata.sourceCommit, sourceSha);
  const connectionString = process.env.NEARBY_VERIFY_DATABASE_URL?.trim();
  assert.ok(connectionString, "only dedicated NEARBY_VERIFY_DATABASE_URL may be supplied");
  const url = new URL(connectionString);
  assert.ok(["postgres:", "postgresql:"].includes(url.protocol));
  assert.match(url.hostname, /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/i);
  assert.doesNotMatch(url.hostname, /-pooler\./); assert.equal(url.hostname, metadata.endpointHost);
  assert.equal(decodeURIComponent(url.pathname.slice(1)), metadata.databaseName);
  allowedDatabaseHost = url.hostname;
  report.certifiedSourceSha = sourceSha;
  report.runtimeUnchangedFromImplementation = true;
  report.applicationGates = gates;
  assert.doesNotMatch(JSON.stringify(metadata), /postgres(?:ql)?:\/\//i, "metadata must not contain a database connection URI");
  assert.ok(!Object.keys(metadata).some(key => /password|secret|token|credential|connectionstring|databaseurl/i.test(key)),
    "control-plane evidence must contain no credentials");
  report.neon = { projectName: metadata.projectName ?? null, projectId: metadata.projectId,
    branchName: metadata.branchName, branchId: metadata.branchId, endpointHost: metadata.endpointHost,
    endpointId: metadata.endpointId ?? null, databaseName: metadata.databaseName,
    productionBranchId: metadata.productionBranchId, creationMode: metadata.creationMode,
    isolated: metadata.isolated, noProductionDataCopied: metadata.noProductionDataCopied,
    createdForVerification: metadata.createdForVerification, createdAt: metadata.createdAt ?? null,
    automaticDeletionAt: metadata.automaticDeletionAt ?? null, sourceCommit: sourceSha,
    proofSource: metadata.proofSource ?? null };
  const migrationSources = await Promise.all(MIGRATIONS.map(async file => {
    const ddl = await readFile(new URL(file, ROOT), "utf8");
    assert.doesNotMatch(ddl.replace(/^--.*$/gm, ""), /(?:alter|drop)\s+table|flight_phase_state|arrival_|viewer_id|history|archive|raw_payload|private_aircraft_identity|session_key/i);
    assert.equal((ddl.match(/create table if not exists/g) ?? []).length, 2);
    return { file, ddl, sha256: createHash("sha256").update(ddl).digest("hex") };
  }));
  if (resumePath) {
    assert.ok(!outputPath || resolve(outputPath) !== resolve(resumePath), "preserve the failed checkpoint; use a different output file");
    const checkpointText = await readFile(resumePath, "utf8");
    const checkpoint = JSON.parse(checkpointText);
    assert.equal(checkpoint.stage, "Part 3B.2.1"); assert.equal(checkpoint.status, "failed");
    assert.equal(checkpoint.certifiedSourceSha, sourceSha); assert.equal(checkpoint.implementationCommit, IMPLEMENTATION);
    assert.equal(checkpoint.runtimeUnchangedFromImplementation, true);
    for (const key of ["projectId", "branchId", "databaseName", "endpointHost", "productionBranchId"])
      assert.equal(checkpoint.neon?.[key], metadata[key], `resume checkpoint has a different ${key}`);
    assert.equal(checkpoint.neon?.creationMode, "schema-only"); assert.equal(checkpoint.neon?.isolated, true);
    assert.equal(checkpoint.neon?.noProductionDataCopied, true); assert.equal(checkpoint.neon?.createdForVerification, true);
    assert.deepEqual(checkpoint.schema?.tables, TABLES.map(table => `inbound_plugin_v1.${table}`));
    assert.equal(checkpoint.schema?.otherApplicationCatalogUnchanged, true);
    assert.equal(checkpoint.schema?.only0006And0007Applied, true);
    assert.equal(checkpoint.migrations?.length, migrationSources.length);
    for (let i = 0; i < migrationSources.length; i++) {
      assert.equal(checkpoint.migrations[i].file, migrationSources[i].file);
      assert.equal(checkpoint.migrations[i].sha256, migrationSources[i].sha256);
      assert.equal(checkpoint.migrations[i].applied, true);
    }
    assert.deepEqual(checkpoint.unexpectedStoreSqlErrors, []);
    assert.equal(checkpoint.liveProviderCalls, 0); assert.equal(checkpoint.deployments, 0); assert.equal(checkpoint.publicEndpoints, 0);
    assert.equal(checkpoint.tests?.length, RESUMABLE_CHECKPOINT_SUITES.length);
    for (let i = 0; i < RESUMABLE_CHECKPOINT_SUITES.length; i++) {
      assert.equal(checkpoint.tests[i].name, RESUMABLE_CHECKPOINT_SUITES[i]);
      assert.equal(checkpoint.tests[i].status, i === RESUMABLE_CHECKPOINT_SUITES.length - 1 ? "failed" : "passed");
    }
    for (const error of [checkpoint.error, checkpoint.tests.at(-1).error]) {
      assert.equal(error?.name, "AssertionError"); assert.equal(error?.code, "ERR_ASSERTION");
      assert.equal(error?.message, "Expected values to be strictly equal:\n\n0 !== 1\n");
    }
    report.resumeCheckpoint = { validated: true, sha256: createHash("sha256").update(checkpointText).digest("hex"),
      certifiedSourceSha: checkpoint.certifiedSourceSha, implementationCommit: checkpoint.implementationCommit,
      branchId: checkpoint.neon.branchId, projectId: checkpoint.neon.projectId,
      failedSuite: checkpoint.tests.at(-1).name, priorPassedSuites: 8,
      priorFinishedAt: checkpoint.finishedAt, migrationStatementsExecuted: 0 };
  }
  const driverPath = argument("--driver-module");
  if (driverPath) assert.ok(isAbsolute(driverPath));
  const driver = driverPath ? await import(pathToFileURL(driverPath).href) : pg;
  assert.equal(typeof driver.Client, "function");
  report.transport = driverPath ? "injected-pg-compatible-driver" : "pg-tcp";
  const importSource = file => import(new URL(`src/lib/${file}`, ROOT).href);
  const [collections, routes, enrichment, engines, policies, routePolicy, areas, views] = await Promise.all([
    importSource("nearby-v1/store.server.ts"), importSource("nearby-v1/route-hint-store.server.ts"),
    importSource("nearby-v1/route-enrichment.ts"), importSource("nearby-v1/engine.server.ts"),
    importSource("nearby-v1/model.ts"), importSource("nearby-v1/route-hints.ts"),
    importSource("plugin-v1/areas.ts"), importSource("nearby-v1/views.ts"),
  ]);
  const { NEARBY_POLICY } = policies;
  const { ROUTE_HINT_POLICY, routeHintFromLookup } = routePolicy;
  const chicago = areas.areaDefinition("preset:chicago");
  const makeClient = suffix => new driver.Client({ connectionString,
    application_name: `inbound-route-321-${suffix}`, connectionTimeoutMillis: 20000,
    statement_timeout: 20000, lock_timeout: 15000, idle_in_transaction_session_timeout: 20000 });
  control = makeClient("control"); await control.connect();
  const identity = (await control.query("select current_database() as database,current_setting('server_version') as version,pg_backend_pid() as pid")).rows[0];
  assert.equal(identity.database, metadata.databaseName);
  report.database = { name: identity.database, serverVersion: identity.version };
  const catalog = async () => (await control.query(`select table_schema,table_name from information_schema.tables
    where table_type='BASE TABLE' and table_schema not in ('information_schema','pg_catalog') order by table_schema,table_name`)).rows;
  const before = await catalog();
  const existingTables = before.filter(row => row.table_schema === "inbound_plugin_v1").map(row => row.table_name);
  if (resumePath) assert.deepEqual(existingTables, TABLES, "resume branch must contain exactly the verified four plugin tables");
  else assert.equal(existingTables.length, 0, "fresh branch must not contain earlier plugin tables");
  report.migrations = [];
  for (const { file, ddl, sha256 } of migrationSources) {
    if (!resumePath) {
      await control.query("begin");
      try { await control.query(ddl); await control.query("commit"); }
      catch (error) { await control.query("rollback"); throw error; }
    }
    report.migrations.push({ file, applied: true, sha256, reused: Boolean(resumePath), appliedInThisRun: !resumePath });
  }
  report.migrationStatementsExecuted = resumePath ? 0 : migrationSources.length;
  const after = await catalog();
  assert.deepEqual(after.filter(row => row.table_schema === "inbound_plugin_v1").map(row => row.table_name), TABLES);
  assert.deepEqual(after.filter(row => row.table_schema !== "inbound_plugin_v1"), before.filter(row => row.table_schema !== "inbound_plugin_v1"));
  const routeColumns = (await control.query(`select column_name from information_schema.columns
    where table_schema='inbound_plugin_v1' and table_name in ('route_hint','route_construction_budget')`)).rows.map(row => row.column_name);
  assert.ok(routeColumns.every(name => !/json|payload|viewer|user|aircraft|session|occurrence|history/i.test(name)));
  const triggers = Number((await control.query(`select count(*) as count from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid=t.tgrelid join pg_catalog.pg_namespace n on n.oid=c.relnamespace
    where n.nspname='inbound_plugin_v1' and not t.tgisinternal`)).rows[0].count);
  assert.equal(triggers, 0);
  report.schema = { tables: TABLES.map(name => `inbound_plugin_v1.${name}`), only0006And0007Applied: true,
    otherApplicationCatalogUnchanged: true, routeStateContainsNoPrivateAircraftViewerPayloadOrHistoryFields: true, userTriggers: 0 };
  if (resumePath) {
    const environments = (await control.query(TABLES.map(table => `select distinct environment from inbound_plugin_v1.${table}`).join(" union "))).rows.map(row => row.environment).sort();
    // Validate the entire inventory before any mutation. An unrelated plugin
    // environment causes a stop rather than being included in a blanket reset.
    for (const environment of environments) assert.match(environment, /^verify321(?:_|$)/);
    const beforeRowCounts = {}, explicitDeleteCounts = {}, afterRowCounts = {};
    for (const table of TABLES)
      beforeRowCounts[table] = Number((await control.query(`select count(*) as count from inbound_plugin_v1.${table}`)).rows[0].count);
    for (const table of ["current_collection", "route_hint", "route_construction_budget"])
      explicitDeleteCounts[table] = (await control.query(`delete from inbound_plugin_v1.${table} where environment=any($1::text[]) returning environment`, [environments])).rows.length;
    for (const table of TABLES) {
      afterRowCounts[table] = Number((await control.query(`select count(*) as count from inbound_plugin_v1.${table}`)).rows[0].count);
      assert.equal(afterRowCounts[table], 0);
    }
    report.initialInventedEnvironmentCleanup = { environments, beforeRowCounts, explicitDeleteCounts,
      rankedViewCascadeDeleted: beforeRowCounts.ranked_view - afterRowCounts.ranked_view,
      afterRowCounts, onlyValidatedInventedEnvironments: true, applicationTablesTouched: false };
    process.stdout.write("PASS verified failed-checkpoint resume; zero migration statements; invented environments reset\n");
  }
  for (let offset = 0; offset < N; offset += 10) {
    const batch = Array.from({ length: Math.min(10, N - offset) }, (_, i) => makeClient(String(offset + i)));
    clients.push(...batch); await Promise.all(batch.map(client => client.connect()));
  }
  const pids = await Promise.all(clients.map(async client => (await client.query("select pg_backend_pid() as pid")).rows[0].pid));
  assert.equal(new Set(pids).size, N); assert.ok(!pids.includes(identity.pid));
  report.connections = { count: N, distinctBackendPids: new Set(pids).size, backendPids: pids,
    separateControlSession: true, directEndpoint: true };
  let sqlQueries = 0;
  const adaptor = client => Object.assign(async () => [], { query: async (query, values = []) => {
    assert.ok(query.includes("inbound_plugin_v1."), "application queries must remain inside the isolated plugin schema");
    assert.doesNotMatch(query, /\b(?:public|flight_phase_state|arrival_projection_state|route_geometry_state)\b/i);
    sqlQueries++;
    try { return (await client.query(query, values)).rows; }
    catch (error) {
      report.unexpectedStoreSqlErrors.push({ name: error.name, code: error.code ?? null, message: error.message });
      throw error;
    }
  } });
  const collectionStore = (index = 0, env = ENV, clock = "provided") => collections.createNearbyCollectionStore({
    environment: env, sqlProvider: async () => adaptor(clients[index]), clock });
  const routeStore = (index = 0, env = ENV, clock = "provided") => {
    const store = routes.createNearbyRouteHintStore({ environment: env, sqlProvider: async () => adaptor(clients[index]), clock });
    const claim = store.claim.bind(store);
    store.claim = async input => { const lease = await claim(input); if (lease) report.routeClaimWinners++; return lease; };
    return store;
  };
  const count = async (table, env = ENV) => {
    assert.ok(TABLES.includes(table));
    return Number((await control.query(`select count(*) as count from inbound_plugin_v1.${table} where environment=$1`, [env])).rows[0].count);
  };
  const clear = async env => {
    assert.match(env, /^verify321(?:_|$)/);
    for (const table of ["current_collection", "route_hint", "route_construction_budget"])
      await control.query(`delete from inbound_plugin_v1.${table} where environment=$1`, [env]);
  };
  const snapshot = (at, number = 125) => ({ observations: Array.from({ length: number }, (_, i) => ({
    cardId: uuid(i + 1), radarId: uuid(i + 10001), privateAircraftIdentity: `invented-aircraft-${i + 1}`,
    sessionKey: `invented-session-${i + 1}`, observedCallsign: `UAL${i + 1}`, registration: null,
    latitude: chicago.reference.latitude + i / 100000, longitude: chicago.reference.longitude,
    altitudeFt: 20000, groundspeedKt: 240, groundTrackDeg: 90, verticalRateFpm: 0, onGround: false,
    observedAt: iso(at), positionKind: "observed", acceptedPosition: true, identityConflict: false,
    typeCode: "B738", category: null, operator: "Invented Air", interesting: false,
    route: { originIata: null, destinationIata: null, verification: "unknown", checkedAt: null }, datedBinding: null,
    freshness: { ageSeconds: 0, state: "fresh" },
    provenance: { source: "invented_telemetry", receivedAt: iso(at), positionAgeSeconds: 0, acceptance: "inbound-fusion" },
  })), partial: false, metadata: { providerCalls: 0, rawCount: number, fusedCount: number,
    rejectedCount: 0, successfulProviders: 0, failedProviders: 0 } });
  const lookupResult = (key, outcome = "positive") => ({ observedCallsign: key,
    originIata: outcome === "positive" ? "SEA" : null, destinationIata: outcome === "positive" ? "ORD" : null,
    airlineLabel: outcome === "positive" ? "Invented Air" : null, outcome, sourceClass: "invented_route",
    verification: outcome === "positive" ? "hint" : "unknown" });
  const positive = (key, at = NOW) => routeHintFromLookup(lookupResult(key), at);
  const negative = (key, at = NOW) => routeHintFromLookup(lookupResult(key, "negative"), at);
  const seed = async (env, version = 1, at = NOW) => {
    assert.match(env, /^verify321_/);
    await control.query(`insert into inbound_plugin_v1.current_collection
      (environment,collection_key,collection_version,accepted_snapshot_at,accepted_collection,next_attempt_at,active_until,inactive_expires_at)
      values ($1,$2,$3,$4,'[]'::jsonb,$4,$4::timestamptz+interval '60 seconds',$4::timestamptz+interval '1 hour')
      on conflict (environment,collection_key) do update set collection_version=excluded.collection_version,
        accepted_snapshot_at=excluded.accepted_snapshot_at,accepted_collection=excluded.accepted_collection,last_attempt_failed=false,
        active_until=excluded.active_until,inactive_expires_at=excluded.inactive_expires_at`, [env, areas.CHICAGO_COLLECTION.id, version, new Date(at)]);
    report.directFixtureSeeds++;
  };
  const claim = (index, env, key, version = 1, at = NOW, clock = "provided") => routeStore(index, env, clock).claim({
    observedCallsign: key, collectionVersion: version, owner: randomUUID(), nowMs: at });
  const readBudget = async env => (await control.query(`select collection_version,collection_snapshot_at,cycle_lookups,
    cardinality(recent_starts) as starts,recent_starts,retain_until from inbound_plugin_v1.route_construction_budget where environment=$1`, [env])).rows[0];
  const simultaneous = async callback => {
    const start = barrier();
    const pending = clients.map(async (_, i) => { await start.promise; return callback(i); });
    start.resolve(); return deadline(Promise.all(pending), "100 simultaneous independent-session operations");
  };
  const makeEngines = ({ env = ENV, clock, acquire, lookup }) => clients.map((_, i) => {
    const routes = enrichment.createRouteEnrichmentService({ store: routeStore(i, env), clock, lookup });
    return engines.createPrivateNearbyEngine({ environment: env, store: collectionStore(i, env), clock, acquire, routeEnrichment: routes });
  });

  let now = NOW;
  const routeStarts = [];
  const viewers = makeEngines({ clock: () => now,
    acquire: async () => { report.fakeAcquisitionCalls++; return snapshot(now); },
    lookup: async key => { report.fakeRouteLookupCalls++; routeStarts.push({ key, at: now });
      return lookupResult(key, key === "UAL2" ? "negative" : "positive"); } });
  await test("100 independent normal viewers: one fake aircraft acquisition, zero route lookups", async () => {
    const start = barrier(), release = barrier(), started = barrier(), done = barrier();
    releasePending = release.resolve;
    let acquisitions = 0, leaseWinners = 0, coldContenders = 0;
    const cold = clients.map((_, i) => {
      const store = collectionStore(i), originalClaim = store.claim.bind(store);
      store.claim = async (...input) => { const result = await originalClaim(...input); if (result) leaseWinners++; return result; };
      const service = enrichment.createRouteEnrichmentService({ store: routeStore(i), clock: () => NOW,
        lookup: async key => { report.fakeRouteLookupCalls++; return lookupResult(key); } });
      const engine = engines.createPrivateNearbyEngine({ environment: ENV, store, clock: () => NOW, routeEnrichment: service,
        acquire: async () => { acquisitions++; report.fakeAcquisitionCalls++; started.resolve(); await release.promise; return snapshot(NOW); } });
      return (async () => { await start.promise; const result = await engine.request("preset:chicago");
        if (!result.view && ++coldContenders === 99) done.resolve(); return result; })();
    });
    const complete = Promise.all(cold); complete.catch(() => {}); start.resolve();
    try {
      await deadline(Promise.race([started.promise, complete]), "cold acquisition starts");
      await deadline(Promise.race([done.promise, complete]), "99 cold viewers return before publication");
      assert.equal(acquisitions, 1); assert.equal(leaseWinners, 1); assert.equal(coldContenders, 99);
      assert.equal(report.fakeRouteLookupCalls, 0); release.resolve();
      const initial = await deadline(complete, "100 cold viewer responses");
      assert.equal(initial.filter(result => result.view !== null).length, 1);
      const warm = await simultaneous(i => viewers[i].request("preset:chicago"));
      assert.equal(report.fakeAcquisitionCalls, 1); assert.equal(report.fakeRouteLookupCalls, 0);
      assert.ok(warm.every(result => result.view?.radar.length === 100 && result.view.featured.length === 4));
      const board = warm[0].view.featured.map(row => row.candidate.cardId);
      assert.ok(warm.every(result => JSON.stringify(result.view.featured.map(row => row.candidate.cardId)) === JSON.stringify(board)));
      assert.equal(await count("current_collection"), 1); assert.equal(await count("route_hint"), 0);
      const stored = await collectionStore(99).read(NOW); assert.equal(stored.collectionVersion, 1);
      assert.equal(stored.observations.length, 125);
      report.concurrent100ViewerAcquisitions = acquisitions;
      report.concurrent100ViewerRouteLookups = 0;
      return { independentSessions: 100, fakeAcquisitions: acquisitions, leaseWinners, coldContenders: 99,
        normalViewerRouteLookups: 0, warmExtraAcquisitions: 0, collectionVersion: 1,
        radarCount: 100, featuredCount: 4, radarBytes: Buffer.byteLength(JSON.stringify(warm[0].view.radar)), oneSharedCollection: true };
    } finally { release.resolve(); await complete.catch(() => {}); releasePending = () => {}; }
  });

  await test("real cold-snapshot route renderer/ranking/privacy integration", async () => {
    const { verifyRouteIntegration } = await import(new URL("./integration.ts", import.meta.url).href);
    assert.equal(typeof verifyRouteIntegration, "function");
    const original = await collectionStore(99).read(NOW);
    const details = await verifyRouteIntegration({ sqlProvider: async () => adaptor(control), environment: ENV, nowMs: NOW, connectionCount: N });
    assert.deepEqual(await collectionStore(98).read(NOW), original, "integration must leave main fake current snapshot unchanged");
    for (const table of TABLES) assert.equal(await count(table, `${ENV}_integration`), 0, "integration fixture environment must be cleaned");
    assert.equal(report.fakeAcquisitionCalls, 1); assert.equal(report.fakeRouteLookupCalls, 0);
    return details;
  });

  await test("100 explicit construction workers share two cycle winners and six rolling starts", async () => {
    const first = await simultaneous(i => viewers[i].constructRouteHints("preset:chicago"));
    assert.equal(first.reduce((sum, result) => sum + result.lookupsStarted, 0), 2);
    assert.equal(first.reduce((sum, result) => sum + result.published, 0), 2);
    assert.equal(routeStarts.length, 2); assert.deepEqual(routeStarts.map(item => item.key).sort(), ["UAL1", "UAL2"]);
    report.concurrent100ConstructionLookups = routeStarts.length;
    const coldBoard = (await viewers[0].request("preset:chicago")).view.featured.map(row => row.candidate.cardId);
    const cached = await simultaneous(i => viewers[i].request("preset:chicago"));
    const raw = (await viewers[0].read()).collection;
    assert.ok(raw.observations.every(o => o.route.verification === "unknown"));
    for (const result of cached) {
      assert.deepEqual(result.view.featured.map(row => row.candidate.cardId), coldBoard);
      assert.equal(result.view.ranked.find(row => row.candidate.observedCallsign === "UAL1").route.verification, "hint");
      assert.equal(result.view.ranked.find(row => row.candidate.observedCallsign === "UAL2").route.verification, "unknown");
      assert.deepEqual(result.view.radar, views.buildNearbyView(raw, chicago, now, { previousStability: result.view.stability }).radar);
    }
    assert.equal(routeStarts.length, 2);
    for (const elapsed of [20000, 40000]) {
      now = NOW + elapsed; await viewers[0].requestRadar("preset:chicago");
      const cycle = await simultaneous(i => viewers[i].constructRouteHints("preset:chicago"));
      assert.equal(cycle.reduce((sum, result) => sum + result.lookupsStarted, 0), 2);
      assert.ok(cycle.every(result => result.cacheHits >= 2));
    }
    assert.equal(routeStarts.length, 6);
    now = NOW + 59999;
    assert.equal((await simultaneous(i => viewers[i].constructRouteHints("preset:chicago"))).reduce((sum, r) => sum + r.lookupsStarted, 0), 0);
    now = NOW + 60000; await viewers[0].requestRadar("preset:chicago");
    const boundary = await simultaneous(i => viewers[i].constructRouteHints("preset:chicago"));
    assert.equal(boundary.reduce((sum, result) => sum + result.lookupsStarted, 0), 2);
    assert.equal(routeStarts.length, 8); assert.equal(routeStarts.filter(item => item.key === "UAL1").length, 1);
    assert.equal(routeStarts.filter(item => item.key === "UAL2").length, 2);
    for (const item of routeStarts) assert.ok(routeStarts.filter(other => other.at > item.at - 60000 && other.at <= item.at).length <= 6);
    const budget = await readBudget(ENV); assert.equal(budget.cycle_lookups, 2); assert.equal(budget.starts, 6);
    return { independentWorkers: 100, initialExactFakeRouteLookups: 2, initialPublished: 2,
      sameCallsignCollapsePassed: true, normalViewerLookupsAfterCachePublication: 0,
      startsOverFourAcceptedCycles: routeStarts, perCycleMaximum: 2, rollingMinuteMaximum: 6,
      positiveReusedAcrossCycles: true, negativeRequeriedAt60Seconds: true,
      rawAcceptedSnapshotUnchangedByHints: true, radarUnaffectedByRouteHints: true, sameVersionFeaturedStable: true };
  });

  await test("100 same-callsign claims collapse to one lease and charge; hits charge zero", async () => {
    const env = `${ENV}_same`; await seed(env);
    const leases = await simultaneous(i => claim(i, env, "FAKE1"));
    const winners = leases.filter(Boolean); assert.equal(winners.length, 1);
    assert.equal(winners[0].generation, 1);
    const before = await readBudget(env); assert.equal(before.cycle_lookups, 1); assert.equal(before.starts, 1);
    assert.equal(await routeStore(0, env).publish(winners[0], positive("FAKE1"), NOW), true);
    assert.ok((await simultaneous(i => claim(i, env, "FAKE1"))).every(value => value === null));
    const after = await readBudget(env); assert.equal(after.cycle_lookups, 1); assert.equal(after.starts, 1);
    assert.equal(await count("route_hint", env), 1);
    return { independentClaims: 100, exactLeaseWinners: 1, exactChargedStarts: 1,
      duplicateCachedClaimsCharged: 0, oneMutableCallsignRow: true };
  });

  await test("positive/negative TTL reuse, exact expiry and sixty-second failure cooldown", async () => {
    const env = `${ENV}_ttl`; await seed(env);
    const pos = await claim(0, env, "POS1"), neg = await claim(1, env, "NEG1"); assert.ok(pos); assert.ok(neg);
    assert.equal(await routeStore(0, env).publish(pos, positive("POS1"), NOW), true);
    assert.equal(await routeStore(1, env).fail(neg, NOW), true);
    const values = await routeStore(99, env).read(["POS1", "NEG1"], NOW);
    assert.deepEqual(values.map(value => value.outcome), ["negative", "positive"]);
    assert.equal(values[0].sourceClass, "lookup_failure");
    assert.equal(Date.parse(values[0].expiresAt) - Date.parse(values[0].checkedAt), 60000);
    assert.equal(Date.parse(values[1].expiresAt) - Date.parse(values[1].checkedAt), 1800000);
    await seed(env, 2, NOW + 20000);
    assert.equal(await claim(0, env, "POS1", 2, NOW + 20000), null);
    assert.equal(await claim(1, env, "NEG1", 2, NOW + 20000), null);
    assert.equal((await readBudget(env)).cycle_lookups, 2);
    await seed(env, 3, NOW + 59999);
    assert.equal((await routeStore(99, env).read(["NEG1"], NOW + 59999)).length, 1);
    assert.equal(await claim(2, env, "NEG1", 3, NOW + 59999), null);
    await seed(env, 4, NOW + 60000);
    assert.equal((await routeStore(99, env).read(["NEG1"], NOW + 60000)).length, 0);
    const retry = await claim(3, env, "NEG1", 4, NOW + 60000); assert.ok(retry); assert.equal(retry.generation, 2);
    assert.equal(await routeStore(3, env).publish(retry, positive("NEG1", NOW + 60000), NOW + 60000), true);
    assert.equal((await routeStore(99, env).read(["POS1"], NOW + 1799999)).length, 1);
    assert.equal((await routeStore(99, env).read(["POS1"], NOW + 1800000)).length, 0);
    await seed(env, 5, NOW + 1800000);
    assert.ok(await claim(4, env, "POS1", 5, NOW + 1800000));
    return { positiveTtlSeconds: 1800, negativeFailureTtlSeconds: 60, cacheHitsConsumeNoQuota: true,
      negativeUsableBeforeExpiryAndHiddenAtExpiry: true, positiveUsableBeforeExpiryAndHiddenAtExpiry: true,
      refreshedNegativeGeneration: 2, failureSourceClass: "lookup_failure" };
  });

  await test("expired/crashed leases, stale owners and duplicate route publications are fenced", async () => {
    const env = `${ENV}_fence`; await seed(env); const old = await claim(0, env, "FAKE1"); assert.ok(old);
    assert.equal(await routeStore(0, env).publish(old, positive("FAKE1", NOW + 10000), NOW + 10000), false);
    assert.equal(await routeStore(0, env).fail(old, NOW + 10000), false);
    assert.equal(await claim(1, env, "FAKE1", 1, NOW + 10000), null);
    await seed(env, 2, NOW + 59999); assert.equal(await claim(1, env, "FAKE1", 2, NOW + 59999), null);
    await seed(env, 3, NOW + 60000); const replacement = await claim(2, env, "FAKE1", 3, NOW + 60000);
    assert.ok(replacement); assert.equal(replacement.generation, old.generation + 1);
    assert.equal(await routeStore(0, env).publish(old, positive("FAKE1", NOW + 60000), NOW + 60000), false);
    assert.equal(await routeStore(0, env).fail(old, NOW + 60000), false);
    assert.equal(await routeStore(2, env).publish(replacement, negative("FAKE1", NOW + 60000), NOW + 60000), true);
    assert.equal(await routeStore(2, env).publish(replacement, negative("FAKE1", NOW + 60000), NOW + 60000), false);
    assert.equal(await routeStore(2, env).fail(replacement, NOW + 60000), false);
    return { leaseSeconds: 10, crashRetryCooldownSeconds: 60, originalGeneration: old.generation,
      replacementGeneration: replacement.generation, expiredWriterRejected: true, staleWriterRejected: true,
      duplicatePublishRejected: true, duplicateFailureRejected: true };
  });

  await test("actual cycle identity and exact rolling-minute boundary enforced across independent sessions", async () => {
    const env = `${ENV}_quota`; const starts = [];
    for (const [version, elapsed, keys] of [[1, 0, ["FAKE1", "FAKE2"]], [2, 20000, ["FAKE3", "FAKE4"]], [3, 40000, ["FAKE5", "FAKE6"]]]) {
      await seed(env, version, NOW + elapsed);
      const results = await simultaneous(i => claim(i, env, keys[i % 2], version, NOW + elapsed));
      assert.equal(results.filter(Boolean).length, 2); starts.push(...results.filter(Boolean).map(value => value.claimedAtMs));
      assert.equal(await claim(99, env, `EXTRA${version}`, version, NOW + elapsed), null);
    }
    await seed(env, 4, NOW + 59999);
    assert.equal(await claim(0, env, "FAKE7", 4, NOW + 59999), null, "new cycle is blocked solely by rolling six-start cap");
    const boundary = await simultaneous(i => claim(i, env, i % 2 ? "FAKE7" : "FAKE8", 4, NOW + 60000));
    assert.equal(boundary.filter(Boolean).length, 2); starts.push(...boundary.filter(Boolean).map(value => value.claimedAtMs));
    assert.equal(await claim(99, env, "FAKE9", 4, NOW + 60000), null);
    const budget = await readBudget(env); assert.equal(Number(budget.collection_version), 4);
    assert.equal(budget.cycle_lookups, 2); assert.equal(budget.starts, 6);
    for (const at of starts) assert.ok(starts.filter(other => other > at - 60000 && other <= at).length <= 6);
    return { cycleMaximum: 2, rollingMaximum: 6, exact59999MsBlocked: true, exact60000MsTwoWinners: true,
      acceptedStarts: starts, finalCycleVersion: 4, finalCycleCharges: 2, finalRollingCharges: 6 };
  });

  await test("current/fresh/active/successful collection required; environment state isolated", async () => {
    const env = `${ENV}_scope`, other = `${ENV}_other`;
    assert.equal(await claim(0, env, "FAKE1"), null); await seed(env);
    assert.equal(await claim(0, env, "FAKE1", 2), null);
    assert.equal(await claim(0, env, "STALE1", 1, NOW + 45001), null);
    assert.ok(await claim(1, env, "EDGE1", 1, NOW + 45000));
    await control.query("update inbound_plugin_v1.current_collection set last_attempt_failed=true where environment=$1", [env]);
    assert.equal(await claim(2, env, "FAKE1"), null); await seed(env);
    await control.query("update inbound_plugin_v1.current_collection set active_until=$1 where environment=$2", [new Date(NOW), env]);
    assert.equal(await claim(2, env, "FAKE1"), null); await seed(env); await seed(other);
    const ours = await claim(3, env, "FAKE1"), theirs = await claim(4, other, "FAKE1"); assert.ok(ours); assert.ok(theirs);
    assert.equal(await routeStore(3, env).publish(ours, positive("FAKE1"), NOW), true);
    assert.equal(await routeStore(4, other).publish(theirs, negative("FAKE1"), NOW), true);
    assert.equal((await routeStore(99, env).read(["FAKE1"], NOW))[0].outcome, "positive");
    assert.equal((await routeStore(98, other).read(["FAKE1"], NOW))[0].outcome, "negative");
    await routeStore(0, env).cleanup(NOW + 60000);
    assert.equal((await routeStore(98, other).read(["FAKE1"], NOW + 59999)).length, 1);
    return { absentCollectionRejected: true, staleVersionRejected: true, exact45SecondsFresh: true,
      olderThan45SecondsRejected: true, failedCollectionRejected: true, inactiveCollectionRejected: true,
      sharedCallsignAcrossEnvironmentsIndependent: true, cleanupDoesNotCrossEnvironment: true };
  });

  await test("cleanup/recreation preserve quota; 100 concurrent cleanup and claim operations remain bounded", async () => {
    const env = `${ENV}_cleanup`; await seed(env);
    const old1 = await claim(0, env, "OLD1"), old2 = await claim(1, env, "OLD2"); assert.ok(old1); assert.ok(old2);
    assert.equal(await routeStore(0, env).fail(old1, NOW), true);
    await control.query("delete from inbound_plugin_v1.current_collection where environment=$1", [env]);
    assert.deepEqual(await routeStore(2, env).cleanup(NOW + 10000), { hints: 0, budgets: 0 });
    await seed(env, 1, NOW + 20000);
    assert.ok(await claim(3, env, "MID1", 1, NOW + 20000)); assert.ok(await claim(4, env, "MID2", 1, NOW + 20000));
    assert.equal(await claim(5, env, "MID3", 1, NOW + 20000), null);
    await routeStore(5, env).cleanup(NOW + 80000);
    await seed(env, 1, NOW + 20000);
    assert.equal(await claim(5, env, "MID3", 1, NOW + 40000), null, "same actual snapshot cycle survives cleanup");
    await control.query("delete from inbound_plugin_v1.current_collection where environment=$1", [env]);
    await control.query("update inbound_plugin_v1.route_construction_budget set retain_until=$1 where environment=$2", [new Date(NOW + 60000), env]);
    const at = NOW + 120000; await seed(env, 1, at);
    const leases = await simultaneous(async i => {
      if (i % 2 === 0) await routeStore(i, env).cleanup(at);
      const lease = await claim(i, env, i % 2 === 0 ? "NEW1" : "NEW2", 1, at);
      if (i % 2 !== 0) await routeStore(i, env).cleanup(at);
      return lease;
    });
    const winners = leases.filter(Boolean); assert.equal(winners.length, 2);
    assert.deepEqual(winners.map(value => value.observedCallsign).sort(), ["NEW1", "NEW2"]);
    const budget = await readBudget(env); assert.equal(budget.cycle_lookups, 2); assert.equal(budget.starts, 2);
    assert.equal(await count("route_hint", env), 2);
    assert.equal(await routeStore(0, env).fail(old2, at), false);
    for (const lease of winners) assert.equal(await routeStore(99, env).publish(lease, positive(lease.observedCallsign, at), at), true);
    assert.equal(await claim(98, env, "EXTRA1", 1, at), null);
    await control.query("delete from inbound_plugin_v1.current_collection where environment=$1", [env]);
    const retentionExpiresAtMs = budget.retain_until instanceof Date ? budget.retain_until.getTime() : Date.parse(budget.retain_until);
    assert.ok(Number.isFinite(retentionExpiresAtMs));
    assert.ok(retentionExpiresAtMs >= at + NEARBY_POLICY.inactiveRetentionMs);
    const justBeforeExpiry = await routeStore(99, env).cleanup(retentionExpiresAtMs - 1);
    assert.equal(justBeforeExpiry.budgets, 0); assert.equal(await count("route_construction_budget", env), 1);
    assert.equal(await count("route_hint", env), 0, "route hints expire before the retained budget");
    const cleared = await routeStore(99, env).cleanup(retentionExpiresAtMs);
    assert.equal(cleared.budgets, 1); assert.equal(await count("route_hint", env), 0);
    assert.deepEqual(await routeStore(99, env).cleanup(retentionExpiresAtMs), { hints: 0, budgets: 0 });
    return { cooldownAndBudgetSurviveParentDeletion: true, sameVersionNewSnapshotStartsNewCycle: true,
      liveActualSnapshotCycleCannotBeErasedByCleanup: true, concurrentIndependentCleanupClaims: 100,
      exactConcurrentWinners: 2, finalCycleCharges: 2, staleWriterRejectedAfterRecreation: true,
      expiredHintRowsRemoved: true, budgetRetainedJustBeforeExpiry: true,
      budgetRetentionExpiresAt: iso(retentionExpiresAtMs), expiredBudgetRowsRemoved: 1, cleanupIdempotent: true };
  });

  await test("192-row cap counts pending rows and expired cache rows prune without quota charge on rejection", async () => {
    const env = `${ENV}_rowcap`; await seed(env);
    await control.query(`insert into inbound_plugin_v1.route_hint
      (environment,observed_callsign,origin_iata,outcome,checked_at,expires_at,source_class,verification,next_attempt_at)
      select $1,'CACHE'||n,'SEA','positive',$2,$2::timestamptz+interval '30 minutes','invented','hint',$2::timestamptz+interval '30 minutes'
      from generate_series(1,191) n`, [env, new Date(NOW)]);
    const pending = await claim(0, env, "PENDING1"); assert.ok(pending); assert.equal(await count("route_hint", env), 192);
    assert.equal(await claim(1, env, "OVERFLOW1"), null);
    const budget = await readBudget(env); assert.equal(budget.cycle_lookups, 1); assert.equal(budget.starts, 1);
    await control.query(`update inbound_plugin_v1.route_hint set checked_at=$1::timestamptz-interval '30 minutes',
      expires_at=$1,next_attempt_at=$1 where environment=$2 and outcome='positive'`, [new Date(NOW), env]);
    assert.ok(await claim(2, env, "NEW1")); assert.equal(await count("route_hint", env), 2);
    assert.equal((await readBudget(env)).cycle_lookups, 2);
    return { configuredRowCap: 192, actualPositiveRows: 191, actualPendingRows: 1,
      capOverflowClaimRejected: true, rejectedCapClaimCharged: 0,
      opportunisticExpiredRowsPruned: 191, rowsAfterPruningAndNewClaim: 2 };
  });

  await test("Postgres route schema constraints and malformed runtime publications fail closed", async () => {
    const env = `${ENV}_constraints`;
    const insert = (key, changes = {}) => {
      const p = { env, key, origin: "SEA", dest: "ORD", label: "Invented Air", outcome: "positive", seconds: 1800,
        source: "invented", verification: "hint", ...changes };
      return control.query(`insert into inbound_plugin_v1.route_hint
        (environment,observed_callsign,origin_iata,destination_iata,airline_label,outcome,checked_at,expires_at,source_class,verification,next_attempt_at)
        values ($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+$8*interval '1 second',$9,$10,$7)`,
      [p.env,p.key,p.origin,p.dest,p.label,p.outcome,new Date(NOW),p.seconds,p.source,p.verification]);
    };
    await insert("POS1"); await insert("NEG1", { origin: null, dest: null, label: null, outcome: "negative", seconds: 60, verification: "unknown" });
    const invalid = [{ seconds: 1800.001 }, { outcome: "negative", origin: null, dest: null, label: null, seconds: 60.001, verification: "unknown" },
      { seconds: 0 }, { key: "BAD CALL" }, { origin: "SEATTLE" }, { origin: null, dest: null },
      { outcome: "negative", seconds: 60, origin: "SEA", dest: null, label: null, verification: "unknown" },
      { label: "x".repeat(65) }, { label: "https://example.invalid" }, { label: " Invented Air " },
      { verification: "confirmed" }, { env: "viewer:1" }, { label: "<script>" }, { source: "raw:provider" }];
    for (let i = 0; i < invalid.length; i++) await assert.rejects(insert(`BAD${i}`, invalid[i]), error => error.code === "23514");
    await seed(env);
    await control.query(`insert into inbound_plugin_v1.route_construction_budget
      (environment,collection_key,collection_version,collection_snapshot_at,cycle_lookups,recent_starts,retain_until)
      values ($1,$2,1,$3,2,$4,$3)`, [env, areas.CHICAGO_COLLECTION.id, new Date(NOW), Array(6).fill(new Date(NOW))]);
    for (const [sql, values] of [
      ["recent_starts=$2", [env, Array(7).fill(new Date(NOW))]], ["cycle_lookups=3", [env]],
      ["collection_key='viewer:1'", [env]], ["recent_starts=ARRAY[NULL]::timestamptz[]", [env]],
    ]) await assert.rejects(control.query(`update inbound_plugin_v1.route_construction_budget set ${sql} where environment=$1`, values), error => error.code === "23514");
    const runtime = `${ENV}_invalid`; await seed(runtime); const lease = await claim(0, runtime, "BAD1"); assert.ok(lease);
    const store = routeStore(1, runtime);
    await assert.rejects(store.publish(lease, { ...positive("BAD1"), verification: "confirmed" }, NOW), /Invalid private route hint/);
    await assert.rejects(store.publish(lease, { ...positive("BAD1"), rawPayload: {} }, NOW), /Invalid private route hint shape/);
    await assert.rejects(store.publish(lease, positive("OTHER1"), NOW), /Invalid route hint publication/);
    await assert.rejects(store.read(Array(13).fill("BAD1"), NOW), /exceeds enrichment pool/);
    await assert.rejects(claim(1, runtime, "bad1"), /normalized route callsign/);
    assert.equal((await control.query("select outcome from inbound_plugin_v1.route_hint where environment=$1 and observed_callsign='BAD1'", [runtime])).rows[0].outcome, null);
    return { validMaximumPositiveTtlAccepted: true, validMaximumNegativeTtlAccepted: true,
      invalidSqlHintCasesRejected: invalid.length, invalidSqlBudgetCasesRejected: 4,
      confirmedAndRawPayloadRuntimeHintsRejected: true, callsignMismatchRejected: true,
      thirteenKeyReadRejected: true, unnormalizedClaimRejected: true, malformedPublicationLeavesPendingRowUnchanged: true };
  });

  await test("default database clock ignores forged caller times and stamps actual cache TTL", async () => {
    const env = `${ENV}_clock`;
    const real = (await control.query("select clock_timestamp() as instant")).rows[0].instant.getTime();
    await seed(env, 1, real);
    const store = routeStore(99, env, "database");
    const lease = await store.claim({ observedCallsign: "CLOCK1", collectionVersion: 1, owner: randomUUID(), nowMs: NOW });
    assert.ok(lease); assert.notEqual(lease.claimedAtMs, NOW);
    assert.ok(Math.abs(lease.claimedAtMs - real) < 10000); assert.equal(lease.leaseUntilMs - lease.claimedAtMs, ROUTE_HINT_POLICY.leaseMs);
    assert.equal(await claim(98, env, "CLOCK1", 1, NOW + 1000000, "database"), null);
    assert.deepEqual(await store.cleanup(NOW + 1000000), { hints: 0, budgets: 0 });
    assert.equal(await store.publish(lease, positive("CLOCK1", NOW), NOW), true);
    const value = (await store.read(["CLOCK1"], NOW))[0]; assert.ok(value);
    assert.ok(Math.abs(Date.parse(value.checkedAt) - real) < 10000);
    assert.equal(Date.parse(value.expiresAt) - Date.parse(value.checkedAt), ROUTE_HINT_POLICY.positiveTtlMs);
    const budget = await readBudget(env); assert.equal(budget.recent_starts[0].getTime(), lease.claimedAtMs);
    return { databaseClockDefault: true, forgedCallerCannotExpireLeaseOrCache: true,
      databaseStampedCheckedAt: value.checkedAt, actualPositiveTtlSeconds: 1800,
      postClaimClockAndBudgetTimestampMatch: true };
  });

  await test("database clock resamples after real budget/hint row-lock waits", async () => {
    async function waitForLock(pid) {
      const began = performance.now();
      while (performance.now() - began < 5000) {
        const row = (await control.query("select wait_event_type from pg_stat_activity where pid=$1 and datname=current_database()", [pid])).rows[0];
        if (row?.wait_event_type === "Lock") return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error("claim did not wait on the controlled isolated row lock");
    }
    async function setup(env, activeSeconds = 60) {
      const at = (await control.query("select clock_timestamp() as instant")).rows[0].instant.getTime();
      await seed(env, 1, at);
      await control.query("update inbound_plugin_v1.current_collection set active_until=clock_timestamp()+$2*interval '1 second' where environment=$1", [env, activeSeconds]);
      await control.query(`insert into inbound_plugin_v1.route_construction_budget
        (environment,collection_key,collection_version,collection_snapshot_at,retain_until)
        select environment,collection_key,collection_version,accepted_snapshot_at,inactive_expires_at from inbound_plugin_v1.current_collection where environment=$1`, [env]);
      return at;
    }
    const stampEnv = `${ENV}_wait_stamp`; await setup(stampEnv);
    await clients[0].query("begin");
    try {
      await clients[0].query("select 1 from inbound_plugin_v1.route_construction_budget where environment=$1 for update", [stampEnv]);
      const pending = claim(1, stampEnv, "WAIT1", 1, NOW, "database"); pending.catch(() => {});
      await waitForLock(pids[1]); await control.query("select pg_sleep(0.15)");
      const releaseAt = (await control.query("select clock_timestamp() as instant")).rows[0].instant.getTime();
      await clients[0].query("commit");
      const lease = await deadline(pending, "claim after real budget lock release"); assert.ok(lease);
      assert.ok(lease.claimedAtMs >= releaseAt, "returned clock must include the actual budget wait");
      assert.equal(lease.leaseUntilMs - lease.claimedAtMs, 10000);
      assert.equal((await readBudget(stampEnv)).recent_starts[0].getTime(), lease.claimedAtMs);
    } catch (error) { await clients[0].query("rollback"); throw error; }
    const results = [];
    for (const type of ["budget", "hint"]) {
      const env = `${ENV}_wait_${type}`; const seededAt = await setup(env, 5);
      if (type === "hint") await control.query(`insert into inbound_plugin_v1.route_hint
        (environment,observed_callsign,outcome,checked_at,expires_at,source_class,verification,next_attempt_at)
        values ($1,'WAIT1','negative',$2::timestamptz-interval '60 seconds',$2::timestamptz-interval '1 millisecond','invented','unknown',$2::timestamptz-interval '1 millisecond')`, [env, new Date(seededAt)]);
      await clients[0].query("begin");
      try {
        await clients[0].query(`select 1 from inbound_plugin_v1.${type === "budget" ? "route_construction_budget" : "route_hint"} where environment=$1 for update`, [env]);
        const pending = claim(1, env, "WAIT1", 1, NOW, "database"); pending.catch(() => {});
        await waitForLock(pids[1]); await control.query("select pg_sleep(5.1)");
        await clients[0].query("commit");
        assert.equal(await deadline(pending, `${type} wait expiration protection`), null);
        const budget = await readBudget(env); assert.equal(budget.cycle_lookups, 0); assert.equal(budget.starts, 0);
        results.push({ lock: type, inactiveWhileQueuedClaimRejected: true, chargedStarts: 0 });
      } catch (error) { await clients[0].query("rollback"); throw error; }
    }
    return { genuineIndependentPostgresRowLockWaits: true, postWaitLeaseClockMatchesRollingBudget: true,
      noTestFunctionsOrTriggersAdded: true, queuedExpiryProtection: results };
  });

  await test("100 construction workers during fake route outage respect negative retry cache", async () => {
    const env = `${ENV}_failure`; let at = NOW, acquisitions = 0, failedLookups = 0;
    const fake = makeEngines({ env, clock: () => at,
      acquire: async () => { acquisitions++; report.fakeAcquisitionCalls++; return snapshot(at, 2); },
      lookup: async () => { failedLookups++; report.fakeRouteLookupCalls++; throw new Error("invented route lookup outage"); } });
    const seedView = await fake[0].request("preset:chicago");
    const board = seedView.view.featured.map(row => row.candidate.cardId);
    const construct = () => simultaneous(i => fake[i].constructRouteHints("preset:chicago"));
    assert.equal((await construct()).reduce((sum, result) => sum + result.failed, 0), 2);
    await construct(); await construct(); assert.equal(failedLookups, 2);
    const reads = await simultaneous(i => fake[i].request("preset:chicago"));
    assert.ok(reads.every(result => result.view.radar.length === 2 && JSON.stringify(result.view.featured.map(row => row.candidate.cardId)) === JSON.stringify(board)));
    at += 20000; await fake[0].requestRadar("preset:chicago");
    assert.equal((await construct()).reduce((sum, result) => sum + result.lookupsStarted, 0), 0);
    at = NOW + 60000; await fake[0].requestRadar("preset:chicago");
    assert.equal((await construct()).reduce((sum, result) => sum + result.lookupsStarted, 0), 2);
    assert.equal(failedLookups, 4);
    return { independentOutageWorkers: 100, initialExactFakeFailedLookups: 2, immediateRetryLookups: 0,
      lookupsBefore60SecondExpiry: 0, lookupsAt60SecondExpiry: 2, totalFakeFailureLookups: 4,
      fakeAcquisitions: acquisitions, acceptedAircraftAndFeaturedSlotsPreserved: true };
  });

  const environments = (await control.query("select distinct environment from inbound_plugin_v1.current_collection union select distinct environment from inbound_plugin_v1.route_hint union select distinct environment from inbound_plugin_v1.route_construction_budget")).rows.map(row => row.environment);
  for (const env of environments) { assert.match(env, /^verify321(?:_|$)/); await clear(env); }
  const finalCounts = {};
  for (const table of TABLES) {
    finalCounts[table] = Number((await control.query(`select count(*) as count from inbound_plugin_v1.${table}`)).rows[0].count);
    assert.equal(finalCounts[table], 0);
  }
  assert.deepEqual((await catalog()).filter(row => row.table_schema !== "inbound_plugin_v1"), before.filter(row => row.table_schema !== "inbound_plugin_v1"));
  assert.equal(report.liveProviderCalls, 0);
  assert.equal(report.fakeRouteLookupCalls, 12, "eight normal construction-cycle fake lookups plus four fake outage lookups");
  assert.equal(report.fakeAcquisitionCalls, 7, "one cold acquisition, three refreshes, one outage acquisition and two outage refreshes");
  report.finalState = { tableRowCounts: finalCounts, boundedMutableTablesOnly: true,
    otherApplicationCatalogUnchanged: true, removableWithIsolatedBranch: true, sqlQueries,
    productionConnections: 0, productionRowsReadOrWritten: 0, mainUntouched: true,
    fixtureUntouched: true, publicRealAircraftExposed: false, liveProviderCalls: 0 };
  report.status = "passed";
}
try { await main(); }
catch (error) {
  report.status = "failed"; report.error = { name: error.name, code: error.code ?? null, message: error.message };
  process.stderr.write(`FAIL ${error.message}\n`); process.exitCode = 1;
} finally {
  releasePending(); await Promise.allSettled(clients.map(client => client.end()));
  if (control) await control.end().catch(() => {});
  globalThis.fetch = originalFetch;
  report.finishedAt = new Date().toISOString();
  if (outputPath) await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

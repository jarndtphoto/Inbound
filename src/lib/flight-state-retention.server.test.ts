import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "./db.ts";
import {
  createFlightStateCleanup,
  FLIGHT_STATE_RETENTION_MS,
  ATIS_RETENTION_MS,
  CLEANUP_INTERVAL_MS,
  CLEANUP_BATCH_LIMIT,
} from "./flight-state-retention.server.ts";
import { createFlightPhaseStateStore } from "./flight-phase-state-store.server.ts";
import { createArrivalStateStore } from "./arrival-state-store.server.ts";
import { createRouteMemoryStore } from "./route-memory-store.server.ts";
import { emptyArrivalState } from "./arrival-projection-state.ts";
import { emptyRouteMemory } from "./route-memory.ts";

const flightTables = ["flight_phase_state", "arrival_projection_state", "flight_route_state", "flight_ground_state"] as const;
const tables = [...flightTables, "arrival_atis_cache"] as const;
type Table = typeof tables[number];
const now = Date.parse("2026-10-04T02:00:00.000Z");
const phase = { push: { unix: now / 1000, source: "live_detected", live: true, at: now / 1000 }, taxiOut: null };
const leg = { origin: "ORD", destination: "HNL", date: "2026-10-03" };
const atis = [{ airport: "KORD", type: "combined", datis: "LDG RWY 10R", updatedAt: new Date(now).toISOString() }];

function toSql(run: <T>(query: string, values: unknown[]) => Promise<T[]>): Sql {
  const sql = (async <T>(strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0];
    for (let i = 0; i < values.length; i++) query += `$${i + 1}${strings[i + 1]}`;
    return run<T>(query, values);
  }) as Sql;
  sql.query = <T>(query: string, values: unknown[] = []) => run<T>(query, values);
  return sql;
}

async function database() {
  const pg = new PGlite();
  for (const file of ["0002_flight_phase_state.sql", "0003_arrival_projection_state.sql", "0004_confirmed_takeoff.sql", "0005_route_geometry_state.sql", "0007_flight_ground_state.sql", "0011_push_scope_boundary.sql"])
    await pg.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  const sql = toSql(async <T>(query: string, values: unknown[]) => (await pg.query<T>(query, values)).rows);
  return { pg, sql };
}

async function seed(pg: PGlite, table: Table, key: string, at: number) {
  if (table === "arrival_atis_cache") {
    await pg.query("insert into arrival_atis_cache (airport, entries, fetched_at) values ($1, '[]'::jsonb, $2)", [key, at]);
  } else if (table === "flight_ground_state") {
    await pg.query(`insert into flight_ground_state
      (land_key, requested_ident, origin_iata, dest_iata, airport_iata, airport_lat, airport_lon, movement_kind, updated_at)
      values ($1, 'TEST1', 'ORD', 'HNL', 'ORD', 41.98, -87.90, 'departure', $2::timestamptz)`,
      [key, new Date(at).toISOString()]);
  } else {
    const stateColumn = table === "flight_phase_state" ? "" : ", state";
    const stateValue = table === "flight_phase_state" ? "" : ", '{}'::jsonb";
    await pg.query(`insert into ${table} (land_key, updated_at${stateColumn}) values ($1, $2::timestamptz${stateValue})`, [key, new Date(at).toISOString()]);
  }
}

async function keys(pg: PGlite, table: Table) {
  const key = table === "arrival_atis_cache" ? "airport" : "land_key";
  return (await pg.query<{ key: string }>(`select ${key} as key from ${table} order by ${key}`)).rows.map(row => row.key);
}

function deletedTable(query: string) {
  return query.match(/\bdelete\s+from\s+(?:public\.)?(\w+)/i)?.[1];
}

test("retention deletes expired rows, keeps recent/boundary/future and refreshed active rows, and leaves auth and other tables intact", async () => {
  const { pg } = await database();
  assert.equal(FLIGHT_STATE_RETENTION_MS, 7 * 24 * 60 * 60_000);
  assert.equal(ATIS_RETENTION_MS, 24 * 60 * 60_000);
  assert.equal(CLEANUP_INTERVAL_MS, 6 * 60 * 60_000);
  assert.equal(CLEANUP_BATCH_LIMIT, 1000);
  try {
    for (const table of tables) {
      const retention = table === "arrival_atis_cache" ? ATIS_RETENTION_MS : FLIGHT_STATE_RETENTION_MS;
      await seed(pg, table, "expired", now - retention - 1);
      await seed(pg, table, "boundary", now - retention);
      await seed(pg, table, "recent", now - retention + 1);
      await seed(pg, table, "future", now + 60_000);
      await seed(pg, table, "active", now - retention - 60_000);
      if (table === "arrival_atis_cache")
        await pg.query("update arrival_atis_cache set fetched_at = $1 where airport = 'active'", [now]);
      else await pg.query(`update ${table} set updated_at = $1::timestamptz where land_key = 'active'`, [new Date(now).toISOString()]);
    }
    await pg.exec(readFileSync(new URL("../../migrations/auth/0001_auth.sql", import.meta.url), "utf8"));
    const ancient = new Date(now - 100 * 24 * 60 * 60_000).toISOString();
    await pg.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values (\'auth-user\',\'Retention sentinel\',\'sentinel@example.test\',false,$1,$1)', [ancient]);
    await pg.query('insert into "session" (id,token,"userId","expiresAt","createdAt","updatedAt") values (\'auth-session\',\'test-token\',\'auth-user\',$1,$1,$1)', [ancient]);
    await pg.query('insert into "account" (id,"accountId","providerId","userId","createdAt","updatedAt") values (\'auth-account\',\'test-account\',\'test-provider\',\'auth-user\',$1,$1)', [ancient]);
    await pg.query('insert into "verification" (id,identifier,value,"expiresAt","createdAt","updatedAt") values (\'auth-verification\',\'test-identifier\',\'test-value\',$1,$1,$1)', [ancient]);
    await pg.exec("create table retention_other (id text primary key, updated_at timestamptz); create table _migrations (name text primary key, applied_at timestamptz)");
    await pg.query("insert into retention_other values ('other-sentinel', $1)", [ancient]);
    await pg.query("insert into _migrations values ('migration-sentinel', $1)", [ancient]);
    const untouchedTables = ["user", "session", "account", "verification", "retention_other", "_migrations"];
    const before = await Promise.all(untouchedTables.map(table => pg.query(`select * from "${table}"`)));
    const deleted: string[] = [];
    const observingSql = toSql(async <T>(query: string, values: unknown[]) => {
      const table = deletedTable(query);
      if (table) deleted.push(table);
      return (await pg.query<T>(query, values)).rows;
    });
    await createFlightStateCleanup({ now: () => now })(observingSql);
    assert.deepEqual([...deleted].sort(), [...tables].sort(), "only the five permitted tables receive deletes");
    for (const table of tables)
      assert.deepEqual(await keys(pg, table), ["active", "boundary", "future", "recent"], table);
    const after = await Promise.all(untouchedTables.map(table => pg.query(`select * from "${table}"`)));
    assert.deepEqual(after.map(result => result.rows), before.map(result => result.rows));
  } finally { await pg.close(); }
});

test("each table deletes at most 1000 oldest rows per run without looping over its remaining expired rows", async () => {
  const { pg, sql } = await database();
  let clock = now;
  const cleanup = createFlightStateCleanup({ now: () => clock });
  try {
    for (const table of flightTables) {
      if (table === "flight_ground_state") {
        await pg.query(`insert into flight_ground_state
          (land_key, requested_ident, origin_iata, dest_iata, airport_iata, airport_lat, airport_lon, movement_kind, updated_at)
          select 'expired-' || n, 'TEST1', 'ORD', 'HNL', 'ORD', 41.98, -87.90, 'departure',
            $1::timestamptz + n * interval '1 millisecond'
          from generate_series(1, 1001) as n`, [new Date(now - FLIGHT_STATE_RETENTION_MS - 60_000).toISOString()]);
      } else {
        const stateColumn = table === "flight_phase_state" ? "" : ", state";
        const stateValue = table === "flight_phase_state" ? "" : ", '{}'::jsonb";
        await pg.query(`insert into ${table} (land_key, updated_at${stateColumn})
          select 'expired-' || n, $1::timestamptz + n * interval '1 millisecond'${stateValue}
          from generate_series(1, 1001) as n`, [new Date(now - FLIGHT_STATE_RETENTION_MS - 60_000).toISOString()]);
      }
    }
    await pg.query("insert into arrival_atis_cache (airport, entries, fetched_at) select 'expired-' || n, '[]'::jsonb, $1::bigint + n from generate_series(1, 1001) as n", [now - ATIS_RETENTION_MS - 60_000]);
    await cleanup(sql);
    for (const table of tables) assert.deepEqual(await keys(pg, table), ["expired-1001"], table);
    await cleanup(sql);
    for (const table of tables) assert.deepEqual(await keys(pg, table), ["expired-1001"], "immediate poll cannot start another batch");
    clock += CLEANUP_INTERVAL_MS;
    await cleanup(sql);
    for (const table of tables) assert.deepEqual(await keys(pg, table), [], table);
  } finally { await pg.close(); }
});

test("concurrent writes share one cleanup run, the six-hour boundary is exact, and separate factories are isolated", async () => {
  const { pg } = await database();
  let clock = now, queries = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const sql = toSql(async <T>(query: string, values: unknown[]) => {
    queries++;
    if (queries === 1) await gate;
    return (await pg.query<T>(query, values)).rows;
  });
  const cleanup = createFlightStateCleanup({ now: () => clock });
  try {
    const first = cleanup(sql);
    await Promise.resolve();
    await Promise.all(Array.from({ length: 12 }, () => cleanup(sql)));
    assert.equal(queries, 1, "throttle is reserved before the first query settles");
    release(); await first;
    assert.equal(queries, 5);
    clock += CLEANUP_INTERVAL_MS - 1;
    await cleanup(sql); assert.equal(queries, 5);
    clock++;
    await cleanup(sql); assert.equal(queries, 10);
    await createFlightStateCleanup({ now: () => clock })(sql);
    assert.equal(queries, 15, "an independently injected factory has its own throttle");
  } finally { release(); await pg.close(); }
});

test("one table failure logs and continues the other three deletes, then throttles failure retries for six hours", async () => {
  const { pg } = await database();
  let clock = now, attempts = 0;
  const errors: { table: string; error: unknown }[] = [];
  const sql = toSql(async <T>(query: string, values: unknown[]) => {
    const table = deletedTable(query);
    if (table) attempts++;
    if (table === "flight_phase_state") throw Error("Simulated cleanup failure");
    return (await pg.query<T>(query, values)).rows;
  });
  const cleanup = createFlightStateCleanup({ now: () => clock, onError: (table, error) => { errors.push({ table, error }); } });
  try {
    for (const table of tables)
      await seed(pg, table, "expired", now - (table === "arrival_atis_cache" ? ATIS_RETENTION_MS : FLIGHT_STATE_RETENTION_MS) - 1);
    await assert.doesNotReject(cleanup(sql));
    assert.deepEqual(errors.map(entry => entry.table), ["flight_phase_state"]);
    assert.match(String(errors[0]!.error), /Simulated cleanup failure/); assert.equal(attempts, 5);
    assert.deepEqual(await keys(pg, "flight_phase_state"), ["expired"]);
    for (const table of tables.filter(table => table !== "flight_phase_state"))
      assert.deepEqual(await keys(pg, table), [], table);
    await Promise.all(Array.from({ length: 12 }, () => cleanup(sql)));
    assert.equal(attempts, 5); assert.equal(errors.length, 1);
    clock += CLEANUP_INTERVAL_MS;
    await cleanup(sql); assert.equal(attempts, 10); assert.equal(errors.length, 2);
  } finally { await pg.close(); }
});

test("a cleanup outage never changes a successful phase poll or stops subsequent state and ATIS writes", async () => {
  const { pg } = await database();
  const errors: string[] = [];
  const sql = toSql(async <T>(query: string, values: unknown[]) => {
    if (deletedTable(query)) throw Error("Retention database outage");
    return (await pg.query<T>(query, values)).rows;
  });
  const cleanup = createFlightStateCleanup({ now: () => now, onError: table => { errors.push(table); } });
  const phaseStore = createFlightPhaseStateStore(async () => sql, cleanup);
  const arrivalStore = createArrivalStateStore(async () => sql, cleanup);
  const routeStore = createRouteMemoryStore(async () => sql, cleanup);
  const key = "leg:v1:UAL219|2026-10-03|ORD|HNL";
  const route = { ...emptyRouteMemory(leg), track: [{ lat: 41.98, lon: -87.9, seenAt: now }] };
  try {
    assert.equal(await phaseStore.save(key, phase, 0), "ok");
    const loaded = await phaseStore.load(key);
    assert.equal(loaded.status, "ok"); assert.deepEqual(loaded.state, phase);
    assert.deepEqual([...errors].sort(), [...tables].sort());
    assert.equal((await arrivalStore.save(key, emptyArrivalState(), 0)).status, "ok");
    assert.equal((await routeStore.save(key, route, 0)).status, "ok");
    await arrivalStore.saveAtis("KORD", atis, now);
    assert.deepEqual(await arrivalStore.loadAtis("KORD", now), atis);
    assert.equal(errors.length, 5, "subsequent normal writes do not cause a cleanup error storm");
  } finally { await pg.close(); }
});

test("normal writes call cleanup after success, while empty/no-op/rejected writes and reads do not", async () => {
  const { pg, sql } = await database();
  let calls = 0;
  const cleanup = async (connection: Sql) => { assert.equal(connection, sql); calls++; };
  const phaseStore = createFlightPhaseStateStore(async () => sql, cleanup);
  const arrivalStore = createArrivalStateStore(async () => sql, cleanup);
  const routeStore = createRouteMemoryStore(async () => sql, cleanup);
  const key = "leg:v1:UAL219|2026-10-03|ORD|HNL";
  const route = { ...emptyRouteMemory(leg), track: [{ lat: 41.98, lon: -87.9, seenAt: now }] };
  try {
    await phaseStore.load(key); await arrivalStore.load(key); await routeStore.load(key, leg);
    assert.equal(calls, 0);
    await phaseStore.save("", phase, 0);
    assert.equal(calls, 0);
    assert.equal(await phaseStore.save(key, phase, 0), "ok"); assert.equal(calls, 1);
    const savedArrival = await arrivalStore.save(key, emptyArrivalState(), 0);
    assert.equal(savedArrival.status, "ok"); assert.equal(calls, 2);
    assert.equal((await arrivalStore.save(key, emptyArrivalState(), 0)).status, "conflict_held");
    assert.equal(calls, 2);
    await routeStore.save(key, emptyRouteMemory(leg), 0); assert.equal(calls, 2);
    const savedRoute = await routeStore.save(key, route, 0);
    assert.equal(savedRoute.status, "ok"); assert.equal(calls, 3);
    await routeStore.save(key, route, savedRoute.version); assert.equal(calls, 3);
    await arrivalStore.saveAtis("KORD", [], now); assert.equal(calls, 3);
    await arrivalStore.saveAtis("KORD", atis, now); assert.equal(calls, 4);
    await arrivalStore.saveAtis("KORD", atis, now - 1); assert.equal(calls, 4);
  } finally { await pg.close(); }
});

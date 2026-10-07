import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "./db.ts";
import type { PhaseState, PushLatch } from "./flight-phase-state-logic.ts";
import { createFlightPhaseStateStore } from "./flight-phase-state-store.server.ts";

const key = "leg:v1:UAL561|2026-10-07|DEN|ORD";
const alias = "leg:unvalidated:UAL561|DEN|ORD|2026-10-07";
const unix = (clock: string) => Date.parse(`2026-10-07T${clock}:00Z`) / 1000;
const boundary = unix("17:00"), oldUnix = unix("11:53"), actualUnix = unix("17:36");
const push = (time: number, source = "track_detected"): PushLatch => ({ unix: time, source, live: true, at: time });
const stale: PhaseState = { push: push(oldUnix), taxiOut: null };
const corrected: PhaseState = { push: push(actualUnix, "provider_actual"), taxiOut: null, pushNotBeforeUnix: boundary };
let pg: PGlite, sql: Sql;
const store = () => createFlightPhaseStateStore(async () => sql, async () => {});

before(async () => {
  pg = new PGlite();
  for (const file of ["0002_flight_phase_state.sql", "0004_confirmed_takeoff.sql", "0011_push_scope_boundary.sql"])
    await pg.exec(readFileSync(new URL(`../../migrations/${file}`, import.meta.url), "utf8"));
  sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0];
    for (let i = 0; i < values.length; i++) query += `$${i + 1}${strings[i + 1]}`;
    return (await pg.query(query, values)).rows;
  }) as Sql;
});
beforeEach(async () => { await pg.exec("truncate flight_phase_state"); });
after(async () => { await pg.close(); });

test("a new boundary drops an old-tail detection and survives a cold store", async () => {
  assert.equal(await store().save(key, stale, 0), "ok");
  const loaded = await store().load(key);
  assert.equal(await store().save(key, { ...loaded.state, pushNotBeforeUnix: boundary }, loaded.version), "ok");
  const next = await store().load(key);
  assert.deepEqual(next.state, { push: null, taxiOut: null, pushNotBeforeUnix: boundary });
  assert.equal(next.version, 2);
  const row = (await pg.query<{ push_unix: number | null; push_not_before_unix: number }>(
    "select push_unix, push_not_before_unix from flight_phase_state where land_key = $1", [key])).rows[0];
  assert.equal(row.push_unix, null);
  assert.equal(row.push_not_before_unix, boundary);
});

test("a current-version writer cannot forget or lower the boundary or erase the valid provider fallback", async () => {
  await store().save(key, corrected, 0);
  for (const outdated of [stale, { ...stale, pushNotBeforeUnix: oldUnix - 60 }]) {
    const current = await store().load(key);
    assert.equal(await store().save(key, outdated, current.version), "ok");
    assert.deepEqual((await store().load(key)).state, corrected);
  }
});

test("a stale CAS writer cannot revive an old-tail push or drop the winning boundary", async () => {
  await store().save(key, stale, 0);
  const staleRead = await store().load(key);
  await store().save(key, corrected, staleRead.version);
  assert.equal(await store().save(key, staleRead.state, staleRead.version), "conflict_resolved");
  assert.deepEqual((await store().load(key)).state, corrected);
});

test("a boundary arriving between the read and CAS write excludes the losing detection", async () => {
  await store().save(key, stale, 0);
  const staleRead = await store().load(key);
  let raced = false;
  const racingSql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!raced && /insert into flight_phase_state/.test(strings.join(""))) {
      raced = true;
      assert.equal(await store().save(key, corrected, staleRead.version), "ok");
    }
    return sql(strings, ...values);
  }) as Sql;
  const losing = createFlightPhaseStateStore(async () => racingSql, async () => {});
  assert.equal(await losing.save(key, staleRead.state, staleRead.version), "conflict_resolved");
  assert.equal(raced, true);
  assert.deepEqual((await store().load(key)).state, corrected);
});

test("legacy alias folds cannot revive an excluded old push and leave the alias intact", async () => {
  await store().save(alias, stale, 0);
  await store().save(key, corrected, 0);
  const aliasBefore = (await pg.query("select * from flight_phase_state where land_key = $1", [alias])).rows[0];
  const current = await store().load(key, [alias]);
  assert.equal(current.status, "ok");
  assert.deepEqual(current.state, corrected);
  assert.equal(current.version, 1, "unchanged alias fold does not write again");
  assert.deepEqual((await pg.query("select * from flight_phase_state where land_key = $1", [alias])).rows[0], aliasBefore);
});

test("a boundary from a legacy row advances the canonical scope even without a push latch", async () => {
  await store().save(key, stale, 0);
  const scoped: PhaseState = { push: null, taxiOut: null, pushNotBeforeUnix: boundary };
  await store().save(alias, scoped, 0);
  assert.deepEqual((await store().load(key, [alias])).state, scoped);
  const current = await store().load(key);
  assert.equal(await store().save(key, stale, current.version), "ok");
  assert.deepEqual((await store().load(key)).state, scoped);
});

test("read validation rejects an old writer's detected push while preserving its durable boundary", async () => {
  await store().save(key, corrected, 0);
  // Older deployments update these fields without knowing the additive column.
  await pg.query("update flight_phase_state set push_unix = $1, push_source = 'track_detected', push_at = $1, version = version + 1 where land_key = $2", [oldUnix, key]);
  assert.deepEqual((await store().load(key)).state, { push: null, taxiOut: null, pushNotBeforeUnix: boundary });
});

test("provider actuals remain valid even before a physical trace boundary", async () => {
  const actual = { ...corrected, pushNotBeforeUnix: actualUnix + 60 };
  assert.equal(await store().save(key, actual, 0), "ok");
  assert.deepEqual((await store().load(key)).state, actual);
  const current = await store().load(key);
  assert.equal(await store().save(key, stale, current.version), "ok");
  assert.deepEqual((await store().load(key)).state, actual);
});

test("an ordinary save preserves the story's genuinely earlier physical push within scope", async () => {
  await store().save(key, corrected, 0);
  const physical = { ...corrected, push: push(unix("17:34")) };
  const current = await store().load(key);
  assert.equal(await store().save(key, physical, current.version), "ok");
  assert.deepEqual((await store().load(key)).state, physical);
});

test("existing rows and callers without the optional field keep their original shape", async () => {
  await pg.query("insert into flight_phase_state (land_key, push_unix, push_source, push_live, push_at) values ($1, $2, 'track_detected', true, $2)", [key, oldUnix]);
  const loaded = await store().load(key);
  assert.deepEqual(loaded.state, stale);
  assert.ok(!Object.hasOwn(loaded.state, "pushNotBeforeUnix"));
  assert.equal(await store().save(key, loaded.state, loaded.version), "ok");
  assert.deepEqual((await store().load(key)).state, stale);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db";

const staged = readFileSync(new URL("../../../docs/plugin-v1/migrations/0004_plugin_v1_ephemeral.sql", import.meta.url), "utf8");
test("Staged design is outside both automatic migration discovery paths", () => {
  const automatic = readdirSync(new URL("../../../migrations/", import.meta.url)).filter(f => f.endsWith(".sql"));
  assert.ok(!automatic.some(f => f.includes("plugin")));
  assert.doesNotMatch(staged, /(?:alter|drop)\s+table\s+(?:public\.)?(?:flight_phase_state|arrival_)/i);
});
test("Ephemeral DDL validates using existing local PGLite and Sql surface only", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(staged); await pg.exec(staged); // staged application is idempotent locally
    const sql = Object.assign(async () => [], {
      query: async <T>(query: string, params: unknown[] = []) => (await pg.query<T>(query, params)).rows,
    }) as Sql;
    const insert = "insert into inbound_plugin_v1.current_collection (environment,collection_key,accepted_snapshot_at,accepted_collection,last_safe_snapshot_metadata,next_attempt_at,active_until,inactive_expires_at) values ($1,'nearby:telemetry:v1:chicago:50','2030-01-15T18:00:00Z',$2::jsonb,'{}','2030-01-15T18:00:20Z','2030-01-15T18:01:00Z','2030-01-15T19:00:00Z')";
    await sql.query(insert, ["fixture", JSON.stringify([{ fixture: 1 }])]);
    await assert.rejects(sql.query(insert, ["fixture", "[]"]), /duplicate key/);
    await sql.query(insert, ["other-fixture-environment", "[]"]);
    await assert.rejects(sql.query("update inbound_plugin_v1.current_collection set accepted_collection=$1::jsonb where environment='fixture'", [JSON.stringify(Array(1001).fill({}))]), /check constraint/);
    await assert.rejects(sql.query("update inbound_plugin_v1.current_collection set accepted_collection=$1::jsonb where environment='fixture'", [JSON.stringify([{ large: "x".repeat(1048576) }])]), /check constraint/);
    await sql.query("update inbound_plugin_v1.current_collection set collection_version=collection_version+1,accepted_collection='[]' where environment='fixture'");
    assert.equal((await sql.query("select * from inbound_plugin_v1.current_collection where environment='fixture'")).length, 1, "updates overwrite one current collection, no 20-second history");
    await assert.rejects(sql.query("insert into inbound_plugin_v1.ranked_view values ('fixture','nearby:telemetry:v1:chicago:50','preset:chicago',38,1,1,$1::jsonb,'2030-01-15T19:00:00Z')", [JSON.stringify(Array(6).fill({}))]), /check constraint/);
    await assert.rejects(sql.query("insert into inbound_plugin_v1.route_hint values ('fixture','UAL1847',1,'ORD','BOS',null,'positive','2030-01-15T18:00:00Z','2030-01-15T18:31:00Z')"), /check constraint/);
    const registry = "insert into inbound_plugin_v1.occurrence_registry values ('fixture',$1::uuid,'UAL1847','2030-01-15','America/Chicago','KORD','KBOS',$2::timestamptz,'[]','2030-01-15T18:00:00Z','2030-01-29T18:00:00Z')";
    await sql.query(registry, ["00000000-0000-4000-8000-000000000001", "2030-01-15T14:00:00Z"]);
    await sql.query(registry, ["00000000-0000-4000-8000-000000000002", "2030-01-15T19:00:00Z"]);
    assert.equal((await sql.query("select * from inbound_plugin_v1.occurrence_registry")).length, 2, "same-day repeated scheduled departures stay separate");
    await sql.query("insert into inbound_plugin_v1.card_session values ('fixture','nearby:telemetry:v1:chicago:50','00000000-0000-4000-8000-000000000010','fixture-private-aircraft','UAL1847',null,'2030-01-15T18:00:00Z','2030-01-15T18:00:00Z','2030-01-15T19:00:00Z')");
    await assert.rejects(sql.query("insert into inbound_plugin_v1.selection_handle values ('fixture',$1,'00000000-0000-4000-8000-000000000010','2030-01-15T18:00:00Z','2030-01-15T18:00:06Z','2030-01-15T18:02:01Z','{}',null)", [new Uint8Array(32)]), /check constraint/);
    await assert.rejects(sql.query("insert into inbound_plugin_v1.candidate_choice values ('fixture',$1,'2030-01-15T18:00:00Z','2030-01-15T18:02:00Z','2030-01-15T18:01:00Z','{}')", [new Uint8Array(32)]), /check constraint/);
    const tables = await sql.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema='inbound_plugin_v1'");
    assert.equal(tables.length, 10);
    assert.ok(!tables.some(t => /history|archive|traffic_sample/.test(t.table_name)));
  } finally { await pg.close(); }
});

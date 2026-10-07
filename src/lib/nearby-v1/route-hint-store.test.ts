import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db";
import { CHICAGO_COLLECTION } from "../plugin-v1/areas";
import { ROUTE_HINT_POLICY, routeHintFromLookup, type NearbyRouteHintLease } from "./route-hints";
import { NEARBY_POLICY } from "./model";
import { createNearbyRouteHintStore } from "./route-hint-store.server";

const collectionDdl = readFileSync(new URL("../../../docs/plugin-v1/migrations/0006_nearby_collection.sql", import.meta.url), "utf8");
const routeDdl = readFileSync(new URL("../../../docs/plugin-v1/migrations/0007_route_hint.sql", import.meta.url), "utf8");
const now = Date.parse("2030-01-01T12:00:00.000Z");
const positive = (key: string, at = now) => routeHintFromLookup({ observedCallsign: key, originIata: "SEA", destinationIata: "ORD", airlineLabel: "Invented Air", outcome: "positive", sourceClass: "fake", verification: "hint" }, at);
const negative = (key: string, at = now) => routeHintFromLookup({ observedCallsign: key, originIata: null, destinationIata: null, airlineLabel: null, outcome: "negative", sourceClass: "fake", verification: "unknown" }, at);
async function database() {
  const pg = new PGlite();
  await pg.exec(collectionDdl); await pg.exec(routeDdl);
  const sql = Object.assign(async () => [], { query: async <T>(query: string, values: unknown[] = []) => (await pg.query<T>(query, values)).rows }) as Sql;
  const store = (environment = "test", clock: "provided" | "database" = "provided") => createNearbyRouteHintStore({ environment, sqlProvider: async () => sql, clock });
  const seed = async (version = 1, at = now, environment = "test") => sql.query(`
    insert into inbound_plugin_v1.current_collection (environment,collection_key,collection_version,accepted_snapshot_at,accepted_collection,next_attempt_at,active_until,inactive_expires_at)
    values ($1,$2,$3,$4,'[]'::jsonb,$4,$4::timestamptz+interval '60 seconds',$4::timestamptz+interval '1 hour')
    on conflict (environment,collection_key) do update set collection_version=excluded.collection_version,
      accepted_snapshot_at=excluded.accepted_snapshot_at,accepted_collection=excluded.accepted_collection,last_attempt_failed=false,
      active_until=excluded.active_until,inactive_expires_at=excluded.inactive_expires_at`, [environment, CHICAGO_COLLECTION.id, version, new Date(at)]);
  const claim = (key = "FAKE1", version = 1, at = now, environment = "test") => store(environment).claim({ observedCallsign: key, collectionVersion: version, owner: randomUUID(), nowMs: at });
  return { pg, sql, store, seed, claim };
}

test("Route DDL creates only bounded mutable hint/budget tables, is idempotent, and stays opt-in", async () => {
  const { pg, sql } = await database();
  try {
    await pg.exec(routeDdl);
    const tables = await sql.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema='inbound_plugin_v1' order by table_name");
    assert.deepEqual(tables.map(row => row.table_name), ["current_collection", "ranked_view", "route_construction_budget", "route_hint"]);
    assert.ok(!readdirSync(new URL("../../../migrations", import.meta.url)).some(name => /nearby|plugin|route_hint/.test(name)));
    assert.doesNotMatch(routeDdl.replace(/^--.*$/gm, ""), /(?:alter|drop)\s+table|user_id|history|archive|raw_payload|private_aircraft_identity|session_key/i);
    const columns = await sql.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='inbound_plugin_v1' and table_name='route_hint'");
    assert.ok(!columns.some(row => /json|payload|user|aircraft|session|occurrence/.test(row.column_name)));
    assert.equal(ROUTE_HINT_POLICY.maxCacheRows, 192);
  } finally { await pg.close(); }
});

test("SQL enforces route fields, positive/negative maximum TTL, environment and six-start budget bounds", async () => {
  const { pg, sql } = await database();
  try {
    const insert = (key: string, outcome = "positive", seconds = 1800, origin: string | null = "SEA", destination: string | null = "ORD", label: string | null = "Invented Air", source = "fake", verification = "hint", environment = "test") => sql.query(`
      insert into inbound_plugin_v1.route_hint (environment,observed_callsign,origin_iata,destination_iata,airline_label,outcome,checked_at,expires_at,source_class,verification,next_attempt_at)
      values ($1,$2,$3,$4,$5,$6,$7,$7::timestamptz+$8*interval '1 second',$9,$10,$7)`, [environment,key,origin,destination,label,outcome,new Date(now),seconds,source,verification]);
    await insert("POS1"); await insert("NEG1", "negative", 60, null, null, null, "fake", "unknown");
    await assert.rejects(insert("POS2", "positive", 1800.001), /check constraint/);
    await assert.rejects(insert("NEG2", "negative", 60.001, null, null, null, "fake", "unknown"), /check constraint/);
    await assert.rejects(insert("POS3", "positive", 0), /check constraint/);
    await assert.rejects(insert("BAD CALL"), /check constraint/);
    await assert.rejects(insert("BAD1", "positive", 1800, "SEATTLE"), /check constraint/);
    await assert.rejects(insert("BAD2", "positive", 1800, null, null), /check constraint/);
    await assert.rejects(insert("BAD3", "negative", 60, "SEA", null, null, "fake", "unknown"), /check constraint/);
    await assert.rejects(insert("BAD4", "positive", 1800, "SEA", "ORD", "x".repeat(65)), /check constraint/);
    await assert.rejects(insert("BAD5", "positive", 1800, "SEA", "ORD", "https://example.invalid"), /check constraint/);
    await assert.rejects(insert("BAD6", "positive", 1800, "SEA", "ORD", " Invented Air "), /check constraint/);
    await assert.rejects(insert("BAD7", "positive", 1800, "SEA", "ORD", "Invented Air", "fake", "confirmed"), /check constraint/);
    await assert.rejects(insert("BAD8", "positive", 1800, "SEA", "ORD", "Invented Air", "fake", "hint", "viewer:1"), /check constraint/);
    await sql.query("insert into inbound_plugin_v1.route_construction_budget values ($1,$2,1,$3,2,$4,$3)", ["test",CHICAGO_COLLECTION.id,new Date(now),Array(6).fill(new Date(now))]);
    await assert.rejects(sql.query("update inbound_plugin_v1.route_construction_budget set recent_starts=$1", [Array(7).fill(new Date(now))]), /check constraint/);
    await assert.rejects(sql.query("update inbound_plugin_v1.route_construction_budget set cycle_lookups=3"), /check constraint/);
    await assert.rejects(sql.query("update inbound_plugin_v1.route_construction_budget set collection_key='viewer:1'"), /check constraint/);
    await assert.rejects(sql.query("update inbound_plugin_v1.route_construction_budget set recent_starts=ARRAY[NULL]::timestamptz[]"), /check constraint/);
  } finally { await pg.close(); }
});

test("100 cold shared callers collapse the same callsign to one lease and one charged lookup", async () => {
  const { pg, sql, store, seed, claim } = await database();
  try {
    await seed();
    const leases = await Promise.all(Array.from({ length: 100 }, () => claim()));
    const winners = leases.filter((lease): lease is NearbyRouteHintLease => !!lease);
    assert.equal(winners.length, 1); assert.equal(winners[0].generation, 1);
    const [budget] = await sql.query<{ cycle_lookups: number; count: number }>("select cycle_lookups,cardinality(recent_starts) as count from inbound_plugin_v1.route_construction_budget");
    assert.deepEqual(budget, { cycle_lookups: 1, count: 1 });
    assert.equal(await store().publish(winners[0], positive("FAKE1"), now), true);
    assert.equal((await sql.query("select * from inbound_plugin_v1.route_hint")).length, 1);
    assert.equal((await store().read(["FAKE1"], now))[0].verification, "hint");
    assert.ok((await Promise.all(Array.from({ length: 100 }, () => claim()))).every(lease => lease === null));
    assert.deepEqual((await sql.query("select cycle_lookups,cardinality(recent_starts) as count from inbound_plugin_v1.route_construction_budget"))[0], budget, "positive hits consume zero quota");
  } finally { await pg.close(); }
});

test("Budget allows two per actual collection cycle and six per rolling minute, including exact boundary", async () => {
  const { pg, sql, seed, claim } = await database();
  try {
    await seed(); assert.ok(await claim("FAKE1")); assert.ok(await claim("FAKE2")); assert.equal(await claim("FAKE3"), null);
    await seed(2, now + 20_000); assert.ok(await claim("FAKE3",2,now+20_000)); assert.ok(await claim("FAKE4",2,now+20_000));
    await seed(3, now + 40_000); assert.ok(await claim("FAKE5",3,now+40_000)); assert.ok(await claim("FAKE6",3,now+40_000));
    await seed(4, now + 59_999); assert.equal(await claim("FAKE7",4,now+59_999), null, "minute cap spans versions");
    assert.ok(await claim("FAKE7",4,now+60_000)); assert.ok(await claim("FAKE8",4,now+60_000)); assert.equal(await claim("FAKE9",4,now+60_000), null);
    const [budget] = await sql.query<{ cycle_lookups: number; count: number; collection_version: number | bigint }>("select cycle_lookups,cardinality(recent_starts) as count,collection_version from inbound_plugin_v1.route_construction_budget");
    assert.equal(budget.cycle_lookups,2); assert.equal(budget.count,6); assert.equal(Number(budget.collection_version),4);
  } finally { await pg.close(); }
});

test("Positive and negative cache reuse survives collection refresh; failure retries after sixty seconds", async () => {
  const { pg, sql, store, seed, claim } = await database();
  try {
    await seed(); const first = (await claim("POS1"))!; const second = (await claim("NEG1"))!;
    assert.equal(await store().publish(first, positive("POS1"), now),true); assert.equal(await store().fail(second,now),true);
    assert.deepEqual((await store().read(["POS1","NEG1"],now)).map(value => value.outcome),["negative","positive"]);
    assert.equal((await store().read(["NEG1"],now))[0].sourceClass,"lookup_failure");
    await seed(2,now+20_000); assert.equal(await claim("POS1",2,now+20_000),null); assert.equal(await claim("NEG1",2,now+20_000),null);
    assert.equal((await sql.query("select cycle_lookups from inbound_plugin_v1.route_construction_budget"))[0].cycle_lookups,2,"cache hits do not touch quota or cycle identity");
    await seed(3,now+59_999); assert.equal(await claim("NEG1",3,now+59_999),null);
    await seed(4,now+60_000); const retry=(await claim("NEG1",4,now+60_000))!; assert.equal(retry.generation,2);
    assert.equal((await store().read(["NEG1"],now+60_000)).length,0); assert.equal(await store().publish(retry,positive("NEG1",now+60_000),now+60_000),true);
    await seed(5,now+ROUTE_HINT_POLICY.positiveTtlMs); assert.equal((await store().read(["POS1"],now+ROUTE_HINT_POLICY.positiveTtlMs)).length,0);
    assert.ok(await claim("POS1",5,now+ROUTE_HINT_POLICY.positiveTtlMs),"expiry allows bounded refresh");
  } finally { await pg.close(); }
});

test("Crashes, stale owners and duplicate writers are fenced without a retry stampede", async () => {
  const { pg, store, seed, claim } = await database();
  try {
    await seed(); const old=(await claim())!;
    assert.equal(await store().publish(old,positive("FAKE1",now+10_000),now+10_000),false);
    assert.equal(await store().fail(old,now+10_000),false);
    assert.equal(await claim("FAKE1",1,now+10_000),null,"lease expiry does not bypass sixty-second crash cooldown");
    await seed(2,now+59_999); assert.equal(await claim("FAKE1",2,now+59_999),null);
    await seed(3,now+60_000); const replacement=(await claim("FAKE1",3,now+60_000))!; assert.equal(replacement.generation,2);
    assert.equal(await store().publish(old,positive("FAKE1",now+60_000),now+60_000),false);
    assert.equal(await store().fail(old,now+60_000),false);
    assert.equal(await store().publish(replacement,negative("FAKE1",now+60_000),now+60_000),true);
    assert.equal(await store().publish(replacement,negative("FAKE1",now+60_000),now+60_000),false);
    assert.equal(await store().fail(replacement,now+60_000),false);
  } finally { await pg.close(); }
});

test("Claims require the current fresh active successful collection and isolate environments", async () => {
  const { pg, sql, store, seed, claim } = await database();
  try {
    assert.equal(await claim(),null); await seed();
    assert.equal(await claim("FAKE1",2),null);
    assert.equal(NEARBY_POLICY.freshMs,45_000);
    assert.equal(await claim("STALE1",1,now+NEARBY_POLICY.freshMs+1),null,"older than forty-five seconds is stale");
    assert.ok(await claim("EDGE1",1,now+NEARBY_POLICY.freshMs),"exactly forty-five seconds remains fresh");
    await sql.query("update inbound_plugin_v1.current_collection set last_attempt_failed=true"); assert.equal(await claim(),null);
    await seed(); await sql.query("update inbound_plugin_v1.current_collection set active_until=$1",[new Date(now)]); assert.equal(await claim(),null);
    await seed(); await seed(1,now,"other");
    const ours=(await claim())!, theirs=(await claim("FAKE1",1,now,"other"))!;
    await store().publish(ours,positive("FAKE1"),now); await store("other").publish(theirs,negative("FAKE1"),now);
    assert.equal((await store().read(["FAKE1"],now))[0].outcome,"positive"); assert.equal((await store("other").read(["FAKE1"],now))[0].outcome,"negative");
    assert.deepEqual(await store().cleanup(now+60_000),{hints:0,budgets:0}); assert.equal((await store("other").read(["FAKE1"],now+59_999)).length,1);
  } finally { await pg.close(); }
});

test("Cleanup cannot erase cycle or rolling quota; collection recreation has a new actual snapshot cycle", async () => {
  const { pg, sql, store, seed, claim } = await database();
  try {
    await seed(); assert.ok(await claim("OLD1")); assert.ok(await claim("OLD2"));
    await sql.query("delete from inbound_plugin_v1.current_collection where environment='test'");
    assert.deepEqual(await store().cleanup(now+10_000),{hints:0,budgets:0},"crash cooldown and budget survive parent deletion");
    await seed(1,now+20_000); assert.ok(await claim("NEW1",1,now+20_000)); assert.ok(await claim("NEW2",1,now+20_000));
    assert.equal(await claim("NEW3",1,now+20_000),null);
    await store().cleanup(now+80_000); await seed(1,now+20_000); assert.equal(await claim("NEW3",1,now+40_000),null,"cleanup retains same live snapshot cycle quota");
    await sql.query("delete from inbound_plugin_v1.current_collection where environment='test'");
    const cleared=await store().cleanup(now+3_700_000); assert.equal(cleared.budgets,1); assert.equal((await sql.query("select * from inbound_plugin_v1.route_hint")).length,0);
    assert.deepEqual(await store().cleanup(now+3_700_000),{hints:0,budgets:0});
  } finally { await pg.close(); }
});

test("Concurrent cleanup and claims after collection recreation preserve two winners and the shared budget", async () => {
  const { pg, sql, store, seed, claim } = await database();
  try {
    await seed();
    const old1=(await claim("OLD1"))!, old2=(await claim("OLD2"))!;
    assert.equal(await store().fail(old1,now),true); // Expired negative and crashed pending row.
    await sql.query("delete from inbound_plugin_v1.current_collection where environment='test'");
    await sql.query("update inbound_plugin_v1.route_construction_budget set retain_until=$1",[new Date(now+60_000)]);
    const at=now+120_000;
    await seed(1,at);
    const work=await Promise.all(Array.from({length:100},async(_,index)=>{
      if(index%2===0) await store().cleanup(at);
      const lease=await claim(index%2===0?"NEW1":"NEW2",1,at);
      if(index%2!==0) await store().cleanup(at);
      return lease;
    }));
    const winners=work.filter((lease):lease is NearbyRouteHintLease=>!!lease);
    assert.equal(winners.length,2); assert.deepEqual(winners.map(lease=>lease.observedCallsign).sort(),["NEW1","NEW2"]);
    const [budget]=await sql.query<{cycle_lookups:number;count:number}>("select cycle_lookups,cardinality(recent_starts) as count from inbound_plugin_v1.route_construction_budget");
    assert.deepEqual(budget,{cycle_lookups:2,count:2});
    assert.equal((await sql.query("select * from inbound_plugin_v1.route_hint")).length,2,"only live pending winners remain");
    assert.equal(await store().fail(old2,at),false,"cleanup/recreation cannot resurrect the crashed writer");
    for(const lease of winners) assert.equal(await store().publish(lease,positive(lease.observedCallsign,at),at),true);
    assert.equal(await claim("EXTRA1",1,at),null);
    const cleanupFunction=routeDdl.slice(routeDdl.indexOf("create or replace function inbound_plugin_v1.cleanup_nearby_route_hints"));
    assert.ok(cleanupFunction.indexOf("for update")<cleanupFunction.indexOf("delete from inbound_plugin_v1.route_hint"),"cleanup takes the budget lock before hint deletion");
  } finally {await pg.close();}
});

test("Per-environment row cap includes pending hints and expired rows are pruned on claim", async () => {
  const { pg, sql, seed, claim } = await database();
  try {
    await seed();
    await sql.query(`insert into inbound_plugin_v1.route_hint (environment,observed_callsign,origin_iata,outcome,checked_at,expires_at,source_class,verification,next_attempt_at)
      select 'test','CACHE'||n,'SEA','positive',$1,$1::timestamptz+interval '30 minutes','fake','hint',$1::timestamptz+interval '30 minutes' from generate_series(1,192) n`,[new Date(now)]);
    assert.equal(await claim(),null); assert.equal((await sql.query("select cycle_lookups from inbound_plugin_v1.route_construction_budget"))[0].cycle_lookups,0);
    await sql.query("update inbound_plugin_v1.route_hint set checked_at=$1::timestamptz-interval '30 minutes',expires_at=$1,next_attempt_at=$1",[new Date(now)]);
    assert.ok(await claim()); assert.equal((await sql.query("select * from inbound_plugin_v1.route_hint")).length,1);
  } finally { await pg.close(); }
});

test("Database-clock claims resample time after waiting for the budget lock path", async () => {
  const {pg,sql,seed,store}=await database();
  try {
    const at=Date.now(); await seed(1,at);
    await pg.exec(`create function inbound_plugin_v1.test_route_budget_delay() returns trigger language plpgsql as $$
      declare v_start timestamptz:=clock_timestamp();
      begin
        while clock_timestamp()<v_start+interval '40 milliseconds' loop null; end loop;
        return new;
      end; $$;
      create trigger test_route_budget_delay before insert on inbound_plugin_v1.route_construction_budget
        for each row execute function inbound_plugin_v1.test_route_budget_delay();`);
    const [{instant}]=await sql.query<{instant:Date}>("select clock_timestamp() as instant");
    const lease=(await store("test","database").claim({observedCallsign:"WAIT1",collectionVersion:1,owner:randomUUID(),nowMs:now}))!;
    assert.ok(lease);
    assert.ok(lease.claimedAtMs>=new Date(instant).getTime()+35,"returned claim timestamp includes the SQL budget-path delay");
    assert.equal(lease.leaseUntilMs-lease.claimedAtMs,ROUTE_HINT_POLICY.leaseMs);
    const [{started}]=await sql.query<{started:Date}>("select recent_starts[1] as started from inbound_plugin_v1.route_construction_budget");
    assert.equal(new Date(started).getTime(),lease.claimedAtMs,"rolling quota is stamped with the same post-wait clock");
  } finally {await pg.close();}
});

test("Default route store ignores caller clocks; missing shared DB and malformed publications fail closed", async () => {
  const { pg, sql, store, seed, claim } = await database();
  try {
    const realNow=Date.now(); await seed(1,realNow);
    const instance=store("test","database");
    const lease=(await instance.claim({observedCallsign:"CLOCK1",collectionVersion:1,owner:randomUUID(),nowMs:now}))!;
    assert.ok(lease); assert.notEqual(lease.claimedAtMs,now);
    assert.equal(await instance.claim({observedCallsign:"CLOCK1",collectionVersion:1,owner:randomUUID(),nowMs:now+1_000_000}),null);
    assert.deepEqual(await instance.cleanup(now+1_000_000),{hints:0,budgets:0});
    assert.equal(await instance.publish(lease,positive("CLOCK1",now),now),true,"database stamps the accepted cache timestamps");
    const cached=(await instance.read(["CLOCK1"],now))[0]; assert.ok(Math.abs(Date.parse(cached.checkedAt)-realNow)<10_000);
    assert.equal(Date.parse(cached.expiresAt)-Date.parse(cached.checkedAt),ROUTE_HINT_POLICY.positiveTtlMs);
    await seed(2); const other=(await claim("BAD1",2))!;
    await assert.rejects(store().publish(other,{...positive("BAD1"),verification:"confirmed"} as never,now),/Invalid private route hint/);
    await assert.rejects(store().publish(other,{...positive("BAD1"),rawPayload:{}} as never,now),/Invalid private route hint shape/);
    await assert.rejects(store().publish(other,positive("OTHER1"),now),/Invalid route hint publication/);
    await assert.rejects(store().read(Array(13).fill("BAD1"),now),/exceeds enrichment pool/);
    await assert.rejects(store().claim({observedCallsign:"bad1",collectionVersion:2,owner:randomUUID(),nowMs:now}),/normalized route callsign/);
    assert.equal((await sql.query("select outcome from inbound_plugin_v1.route_hint where observed_callsign='BAD1'"))[0].outcome,null);
  } finally { await pg.close(); }
  assert.throws(()=>createNearbyRouteHintStore({environment:"viewer:1"}),/Invalid Nearby route environment/);
  const unavailable=createNearbyRouteHintStore({environment:"test",sqlProvider:async()=>{throw new Error("Shared DB unavailable");}});
  await assert.rejects(unavailable.read(["FAKE1"],now),/Shared DB unavailable/);
  await assert.rejects(unavailable.claim({observedCallsign:"FAKE1",collectionVersion:1,owner:randomUUID(),nowMs:now}),/Shared DB unavailable/);
  const saved=process.env.DATABASE_URL; delete process.env.DATABASE_URL;
  try { await assert.rejects(createNearbyRouteHintStore({environment:"test"}).read(["FAKE1"],now),/requires the shared Inbound Postgres database/); }
  finally { if(saved===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=saved; }
});

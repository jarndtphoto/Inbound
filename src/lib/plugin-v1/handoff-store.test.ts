import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "../db";
import { FlightResultV1Schema } from "./contracts";
import { createInventedDetailBuilder } from "./handoff-service.server";
import { createPostgresFlightHandoffStore, tokenHash, type OccurrenceSeed, type SelectionEvidence } from "./handoff-store.server";

const ddl = ["0006_nearby_collection.sql", "0007_route_hint.sql", "0008_flight_handoff.sql"]
  .map(name => readFileSync(new URL(`../../../docs/plugin-v1/migrations/${name}`, import.meta.url), "utf8"));
const now = Date.parse("2026-10-04T03:00:06.000Z");
const evidence = (observedAt = now): SelectionEvidence => ({ environment: "verify34", collectionVersion: 1,
  cardId: "00000000-0000-4000-8000-000000000101", radarId: "00000000-0000-4000-8000-000000000201",
  privateAircraftIdentity: "invented-aircraft-101", sessionKey: "invented-session-101", observedCallsign: "SYN101", registration: null,
  observedAt: new Date(observedAt).toISOString(), latitude: 41.9, longitude: -87.8,
  route: { originIata: "ORD", destinationIata: "BOS", verification: "confirmed", checkedAt: new Date(observedAt).toISOString() },
  datedBinding: { sessionKey: "invented-session-101", observedCallsign: "SYN101", serviceDate: "2026-10-04", confirmedAt: new Date(observedAt).toISOString() } });
const occurrence = (date = "2026-10-04"): OccurrenceSeed => ({ operatingIdent: "SYN101", displayIdent: "SYN101", serviceDate: date,
  serviceTimeZone: "America/Chicago", originIata: "ORD", destinationIata: "BOS", scheduledDepartureAt: `${date}T14:00:00.000Z`,
  identityEvidence: { privateAircraftIdentity: "invented-aircraft-101", sessionKey: "invented-session-101", observedCallsign: "SYN101", registration: null, basis: "dated_binding" } });
async function database() {
  const pg = new PGlite(); for (const migration of ddl) await pg.exec(migration);
  const sql = Object.assign(async () => [], { query: async <T>(query: string, values: unknown[] = []) => (await pg.query<T>(query, values)).rows }) as Sql;
  const store = () => createPostgresFlightHandoffStore({ environment: "verify34", sqlProvider: async () => sql, clock: "provided" });
  return { pg, sql, store };
}

test("incremental 0008 applies four bounded current-state tables after 0006/0007 only", async () => {
  const { pg, sql } = await database();
  try {
    const tables = await sql.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema='inbound_plugin_v1' order by table_name");
    assert.deepEqual(tables.map(row => row.table_name), ["candidate_choice", "current_collection", "detail_snapshot", "occurrence_registry", "ranked_view", "route_construction_budget", "route_hint", "selection_handle"]);
    assert.ok(!readdirSync(new URL("../../../migrations", import.meta.url)).some(name => /0008|handoff|selection|occurrence/.test(name)));
    const source = ddl[2].replace(/^--.*$/gm, "");
    assert.doesNotMatch(source, /(?:alter|drop)\s+table|user_id|viewer_id|traffic_history|raw_provider|lookup_work/i);
    assert.match(source, /token_hash bytea/); assert.doesNotMatch(source, /public_token|selection_token text|candidate_token text/i);
  } finally { await pg.close(); }
});

test("selection stores only a hash, enforces observation lifetime and fences 100 resolution contenders", async () => {
  const { pg, sql, store } = await database();
  try {
    const issued = await store().issueSelection(evidence(), now); assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Date.parse(issued.expiresAt), now + 90_000);
    const rows = await sql.query<{ token_hash: Uint8Array }>("select token_hash from inbound_plugin_v1.selection_handle");
    assert.equal(Buffer.from(rows[0].token_hash).toString("hex"), tokenHash(issued.token));
    const dump = JSON.stringify(await sql.query("select * from inbound_plugin_v1.selection_handle")); assert.equal(dump.includes(issued.token), false);
    const owners = Array.from({ length: 100 }, () => randomUUID());
    const claims = await Promise.all(owners.map(owner => store().claimResolution(tokenHash(issued.token), owner, now)));
    assert.equal(claims.filter(Boolean).length, 1);
    const winner = claims.find(Boolean)!;
    assert.equal(await store().publishResolution(winner, FlightResultV1Schema.parse({ schemaVersion: "1.0", status: "unsupported",
      responseAt: new Date(now).toISOString(), refreshAfterSeconds: null, flightInstanceId: null, flight: null, candidates: [],
      error: { code: "unsupported_aircraft", message: "Invented fixture is unsupported." } }), now), true);
    assert.equal((await store().readSelection(issued.token, now))!.publicResult!.status, "unsupported");
    await assert.rejects(store().issueSelection(evidence(now - 120_000), now), /cannot receive/);
  } finally { await pg.close(); }
});

test("occurrence IDs are stable per dated leg, ambiguity choices are exact, and one detail builder wins", async () => {
  const { pg, store } = await database();
  try {
    const instance = store(), issued = await instance.issueSelection(evidence(), now);
    const first = await instance.ensureOccurrence(occurrence(), now), same = await store().ensureOccurrence(occurrence(), now + 1), next = await store().ensureOccurrence(occurrence("2026-10-05"), now + 1);
    assert.equal(first.flightInstanceId, same.flightInstanceId); assert.notEqual(first.flightInstanceId, next.flightInstanceId);
    const choices = await instance.issueChoices(tokenHash(issued.token), [first, next], now);
    assert.equal(choices.length, 2); assert.notEqual(choices[0].candidateToken, choices[1].candidateToken);
    assert.equal((await store().readChoice(choices[1].candidateToken, now))!.flightInstanceId, next.flightInstanceId);
    const owners = Array.from({ length: 100 }, () => randomUUID());
    const claims = await Promise.all(owners.map(owner => store().claimDetail(first.flightInstanceId, owner, now)));
    assert.equal(claims.filter(Boolean).length, 1);
    const flight = await createInventedDetailBuilder()(first, now);
    assert.equal(await store().publishDetail(claims.find(Boolean)!, flight, 20, now), true);
    assert.equal((await store().readDetail(first.flightInstanceId, now))!.publicFlight!.flightInstanceId, first.flightInstanceId);
  } finally { await pg.close(); }
});

test("detail revalidation has a three-attempt budget even when a last-safe snapshot exists", async () => {
  const { pg, store } = await database();
  try {
    const instance = store(), row = await instance.ensureOccurrence(occurrence(), now);
    const initial = (await instance.claimDetail(row.flightInstanceId, randomUUID(), now))!;
    assert.equal(await instance.publishDetail(initial, await createInventedDetailBuilder()(row, now), 20, now), true);
    for (const at of [now + 20_000, now + 40_000, now + 80_000]) {
      const lease = (await instance.claimDetail(row.flightInstanceId, randomUUID(), at))!;
      assert.equal(await instance.failDetail(lease, "Invented detail backend unavailable.", at), true);
    }
    const exhausted = await instance.readDetail(row.flightInstanceId, now + 160_000);
    assert.equal(exhausted!.buildAttempts, 3); assert.ok(exhausted!.publicFlight);
    assert.equal(await instance.claimDetail(row.flightInstanceId, randomUUID(), now + 160_000), null);
  } finally { await pg.close(); }
});

test("expired owners are fenced, bounded backoff exhausts, and cleanup is scoped and recreatable", async () => {
  const { pg, sql, store } = await database();
  try {
    const issued = await store().issueSelection(evidence(), now), hash = tokenHash(issued.token);
    const stale = (await store().claimResolution(hash, randomUUID(), now))!;
    const replacement = (await store().claimResolution(hash, randomUUID(), now + 5_000))!;
    const result = FlightResultV1Schema.parse({ schemaVersion: "1.0", status: "unsupported", responseAt: new Date(now + 5_000).toISOString(), refreshAfterSeconds: null,
      flightInstanceId: null, flight: null, candidates: [], error: { code: "unsupported_aircraft", message: "Invented fixture is unsupported." } });
    assert.equal(await store().publishResolution(stale, result, now + 5_000), false); assert.equal(await store().publishResolution(replacement, result, now + 5_000), true);
    const failing = await store().issueSelection({ ...evidence(), radarId: "00000000-0000-4000-8000-000000000202" }, now);
    let attemptAt = now;
    for (const waitSeconds of [20, 40, 80]) {
      const lease = (await store().claimResolution(tokenHash(failing.token), randomUUID(), attemptAt))!;
      assert.equal(await store().failResolution(lease, "Invented backend unavailable.", attemptAt), true); attemptAt += waitSeconds * 1_000;
    }
    const exhausted = (await store().readSelection(failing.token, now + 60_000))!;
    assert.equal(exhausted.resolutionAttempts, 3); assert.equal(await store().claimResolution(tokenHash(failing.token), randomUUID(), now + 60_000), null);
    const other = createPostgresFlightHandoffStore({ environment: "other34", sqlProvider: async () => sql, clock: "provided" });
    const otherToken = await other.issueSelection({ ...evidence(), environment: "other34" }, now);
    const removed = await store().cleanup(now + 14 * 24 * 60 * 60 * 1_000 + 1); assert.ok(removed.selections >= 1);
    assert.ok(await other.readSelection(otherToken.token, now));
    const recreated = await store().issueSelection(evidence(now + 14 * 24 * 60 * 60 * 1_000 + 1), now + 14 * 24 * 60 * 60 * 1_000 + 1);
    assert.ok(await store().readSelection(recreated.token, now + 14 * 24 * 60 * 60 * 1_000 + 1));
  } finally { await pg.close(); }
});

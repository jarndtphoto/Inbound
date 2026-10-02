import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import type { Sql } from "./db.ts";
import { createArrivalStateStore } from "./arrival-state-store.server.ts";
import { emptyArrivalState, updateArrivalProjection } from "./arrival-projection-state.ts";
import { clearArrivalAtisMemoryCache, expectedArrivalRunway, loadArrivalAtis } from "./arrival-runway.server.ts";

test("durable runway/side across cold instances, optimistic race, ATIS last-good cache and outage fallback", async () => {
  const pg = new PGlite();
  await pg.exec(readFileSync(new URL("../../migrations/0003_arrival_projection_state.sql", import.meta.url), "utf8"));
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0]; for (let i = 0; i < values.length; i++) query += `$${i + 1}${strings[i + 1]}`;
    return (await pg.query(query, values)).rows;
  }) as Sql;
  const store = () => createArrivalStateStore(async () => sql);
  const date = new Date(), hhmm = date.toISOString().slice(11, 16).replace(":", "");
  const atis = [{ airport: "KORD", type: "combined", datis: `ATIS ${hhmm}Z. LDG RWYS 9L, 10C, 10R.`, updatedAt: date.toISOString() }];
  const fetchSaved = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => { fetchCount++; return new Response(JSON.stringify(atis)); };
  try {
    clearArrivalAtisMemoryCache();
    const runway = await expectedArrivalRunway("KORD", { aircraft: { lat: 41.87, lon: -88.2 } }, store());
    assert.equal(runway!.runway, "10R");
    const state = updateArrivalProjection(emptyArrivalState(), { runway, live: {lat:41.87,lon:-88.2,track:270,phase:"approach",seenSec:1}, dest:runway!.threshold, landed:false, now:Date.now() }).state;
    assert.equal((await store().save("AA5012|LEX|ORD|2026-10-02", state, 0)).status, "ok");
    clearArrivalAtisMemoryCache();
    globalThis.fetch = async () => { fetchCount++; throw Error("ATIS timeout"); };
    const next = await store().load("AA5012|LEX|ORD|2026-10-02");
    const held = await expectedArrivalRunway("KORD", { aircraft:{lat:42.05,lon:-88.2}, previous:next.state.runway, windDir:270,windKt:10 }, store());
    assert.equal(held!.runway, "10R"); assert.equal(held!.source, "ATIS"); assert.equal(next.state.side, state.side);
    assert.equal(fetchCount, 1, "cold instance uses durable ATIS for first 5 minutes");
    // Optimistic guard rejects an older competing writer, and returns winner.
    const winner = { ...state, side: -1, lastFixAt: state.lastFixAt + 10_000 };
    await store().save("AA5012|LEX|ORD|2026-10-02", winner, next.version);
    const loser = await store().save("AA5012|LEX|ORD|2026-10-02", state, next.version);
    assert.equal(loser.status, "conflict_held"); assert.equal(loser.state.side, -1);
    // After five minutes, failed fetch may use ten-minute last good bulletin.
    await pg.query("update arrival_atis_cache set fetched_at = $1", [Date.now() - 6 * 60_000]);
    clearArrivalAtisMemoryCache(); assert.equal((await loadArrivalAtis("KORD", store())).length, 1);
    await pg.query("update arrival_atis_cache set fetched_at = $1", [Date.now() - 11 * 60_000]);
    clearArrivalAtisMemoryCache(); assert.equal((await loadArrivalAtis("KORD", store())).length, 0);
    const noAtis = await expectedArrivalRunway("KORD", { previous: state.runway, windDir:270,windKt:10 }, store());
    assert.equal(noAtis!.runway, "10R");
    const provider = await expectedArrivalRunway("KORD", { previous: state.runway, providerRunway:"10C" }, store());
    assert.equal(provider!.runway, "10C"); assert.equal(provider!.source, "provider");
    await store().saveAtis("KORD", [{ ...atis[0], datis: `ATIS ${hhmm}Z. LDG RWY 9L.` }]);
    clearArrivalAtisMemoryCache();
    const changed = await expectedArrivalRunway("KORD", { previous: state.runway }, store());
    assert.equal(changed!.runway, "9L", "a new arrival assignment invalidates the held runway");
    const broken = createArrivalStateStore(async () => { throw Error("DB down"); });
    assert.equal((await broken.load("x")).status, "read_failed");
    assert.equal((await broken.save("x", state, 0)).status, "write_failed");
    assert.deepEqual((await broken.load("x")).state, state);
  } finally { globalThis.fetch = fetchSaved; clearArrivalAtisMemoryCache(); await pg.close(); }
});

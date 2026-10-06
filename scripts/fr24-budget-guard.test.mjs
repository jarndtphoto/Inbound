import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createFr24Guard, setFr24GuardForTests } from "../src/lib/fr24-budget.server.ts";
import { fr24CreditsForResponse, fr24DailyCreditCap } from "../src/lib/fr24-budget.ts";
import { loadFr24Flight } from "../src/lib/fr24.server.ts";

async function testSql() {
  const pg = new PGlite({ parsers: { 20: Number } });
  await pg.waitReady;
  await pg.exec(await readFile(new URL("../migrations/0006_fr24_budget_guard.sql", import.meta.url), "utf8"));
  const sql = async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1]}`;
    return (await pg.query(text, values)).rows;
  };
  sql.query = async (text, values = []) => (await pg.query(text, values)).rows;
  return { pg, sql };
}

test("FR24 endpoint costs and emergency default cap match the account model", () => {
  const live = "/live/flight-positions/full?registrations=N1&limit=1";
  assert.deepEqual(fr24CreditsForResponse(live, { data: [] }), { credits: 1, resultCount: 0 });
  assert.deepEqual(fr24CreditsForResponse(live, { data: [{ lat: 1 }] }), { credits: 8, resultCount: 1 });
  assert.deepEqual(fr24CreditsForResponse("/flight-tracks?flight_id=x", { tracks: [{}] }), { credits: 40, resultCount: 1 });
  assert.deepEqual(fr24CreditsForResponse("/flight-summary/light", { data: [{ flight_ended: false }] }), { credits: 1, resultCount: 1 });
  assert.deepEqual(fr24CreditsForResponse("/flight-summary/full", { data: [{ flight_ended: false }] }), { credits: 2, resultCount: 1 });
  assert.equal(fr24DailyCreditCap(Date.UTC(2026, 9, 6, 12), {}), 1028);
  assert.equal(fr24DailyCreditCap(Date.UTC(2026, 9, 12, 12), {}), 1028, "the original remaining balance is not re-divided each morning");
  assert.equal(fr24DailyCreditCap(Date.UTC(2026, 9, 6, 12), { FR24_DAILY_CREDIT_CAP: "777" }), 777);
  assert.equal(fr24DailyCreditCap(Date.UTC(2026, 9, 6, 12), {
    FR24_REMAINING_CREDITS: "9000",
    FR24_CREDIT_RESET_AT: "2026-10-12T12:00:00Z",
  }), 1200, "a confirmed reset timestamp drives the remaining-credits calculation");
  assert.equal(fr24DailyCreditCap(Date.UTC(2026, 9, 6, 12), {
    FR24_CREDIT_RESET_AT: "2026-10-05T12:00:00Z",
  }), 1600, "a past configured reset switches to the conservative monthly allowance");
});

test("missing guard tables or an unreachable Neon fail closed before any FR24 request", async () => {
  const savedToken = process.env.FR24_API_TOKEN;
  const savedEnv = process.env.VERCEL_ENV;
  const realFetch = globalThis.fetch;
  let fetches = 0;
  process.env.FR24_API_TOKEN = "test-token";
  process.env.VERCEL_ENV = "production";
  globalThis.fetch = async () => {
    fetches += 1;
    return Response.json({ data: [] });
  };
  try {
    for (const failure of [
      new Error('relation "fr24_shared_cache" does not exist'),
      new Error("Neon connection unavailable"),
    ]) {
      setFr24GuardForTests({
        usage: async () => { throw failure; },
        reserve: async () => { throw failure; },
        finish: async () => { throw failure; },
        cached: async () => { throw failure; },
        acquire: async () => { throw failure; },
        store: async () => { throw failure; },
        release: async () => { throw failure; },
      });
      await assert.rejects(loadFr24Flight("AAL1007"), failure);
    }
    assert.equal(fetches, 0, "database failures must never fall through to paid FR24");
  } finally {
    setFr24GuardForTests(createFr24Guard());
    globalThis.fetch = realFetch;
    if (savedToken == null) delete process.env.FR24_API_TOKEN; else process.env.FR24_API_TOKEN = savedToken;
    if (savedEnv == null) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = savedEnv;
  }
});

test("daily reservations are atomic and every upstream completion is logged", async () => {
  const { pg, sql } = await testSql();
  const savedCap = process.env.FR24_DAILY_CREDIT_CAP;
  const savedDeployment = process.env.VERCEL_DEPLOYMENT_ID;
  const savedEnvironment = process.env.VERCEL_ENV;
  process.env.FR24_DAILY_CREDIT_CAP = "10";
  process.env.VERCEL_DEPLOYMENT_ID = "dpl_test";
  process.env.VERCEL_ENV = "production";
  try {
    const guard = createFr24Guard(async () => sql);
    const at = Date.UTC(2026, 9, 6, 16);
    const reservations = await Promise.all([guard.reserve(8, at), guard.reserve(8, at)]);
    assert.equal(reservations.filter(Boolean).length, 1, "only one concurrent worst-case call fits");
    const reservation = reservations.find(Boolean);
    await guard.finish(reservation, {
      ident: "AA1007", endpoint: "/live/flight-positions/full", credits: 8,
      statusCode: 200, resultCount: 1, errorKind: null,
    });
    assert.equal(await guard.reserve(3, at), null, "a call that could exceed the cap is blocked");
    assert.ok(await guard.reserve(2, at), "the exact remaining allowance can still be reserved");
    assert.deepEqual(await guard.usage(at), {
      day: "2026-10-06", calls: 1, credits: 8, reservedCredits: 2,
      cap: 10, remaining: 0, blocked: true,
    });
    const logs = (await pg.query("select deployment, environment, ident, endpoint, credits from fr24_call_log")).rows;
    assert.deepEqual(logs, [{ deployment: "dpl_test", environment: "production", ident: "AA1007", endpoint: "/live/flight-positions/full", credits: 8 }]);
  } finally {
    if (savedCap == null) delete process.env.FR24_DAILY_CREDIT_CAP; else process.env.FR24_DAILY_CREDIT_CAP = savedCap;
    if (savedDeployment == null) delete process.env.VERCEL_DEPLOYMENT_ID; else process.env.VERCEL_DEPLOYMENT_ID = savedDeployment;
    if (savedEnvironment == null) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = savedEnvironment;
    await pg.close();
  }
});

test("shared cache leases admit one refresher and serve the result for twenty seconds", async () => {
  const { pg, sql } = await testSql();
  try {
    const guard = createFr24Guard(async () => sql);
    const at = Date.UTC(2026, 9, 6, 16);
    const acquired = await Promise.all([
      guard.acquire("live:AA1", "/live/flight-positions/full", "AA1", "one", at),
      guard.acquire("live:AA1", "/live/flight-positions/full", "AA1", "two", at),
    ]);
    assert.equal(acquired.filter(Boolean).length, 1);
    const token = acquired[0] ? "one" : "two";
    await guard.store("live:AA1", token, { data: [{ flight: "AA1" }] }, at);
    assert.deepEqual((await guard.cached("live:AA1", 20_000, at + 19_999))?.value, { data: [{ flight: "AA1" }] });
    assert.equal(await guard.cached("live:AA1", 20_000, at + 20_001), null);
  } finally {
    await pg.close();
  }
});

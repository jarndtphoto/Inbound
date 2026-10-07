import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  createFr24PreviewSessionGuard, fr24PreviewModeEnabled, readFr24PreviewConfig,
} from "../src/lib/fr24-preview-session.server.ts";

const AT = Date.UTC(2035, 0, 1, 23, 59);
const DAY = 86_400_000;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const validEnv = (overrides = {}) => ({
  VERCEL_ENV: "preview", FR24_PREVIEW_MODE: "fr24-only", FR24_PREVIEW_ENABLED: "1",
  FR24_PREVIEW_SESSION_ID: "approved-session-1", FR24_PREVIEW_CREDIT_CAP: "80",
  FR24_PREVIEW_EXPIRES_AT: new Date(AT + 2 * DAY).toISOString(), ...overrides,
});

async function fixture(env = validEnv()) {
  const pg = new PGlite({ parsers: { 20: Number } });
  await pg.waitReady;
  await pg.exec(await readFile(new URL("../migrations/0010_fr24_preview_session.sql", import.meta.url), "utf8"));
  const sql = async (strings, ...values) => {
    let query = strings[0];
    for (let i = 0; i < values.length; i += 1) query += `$${i + 1}${strings[i + 1]}`;
    return (await pg.query(query, values)).rows;
  };
  sql.query = async (query, values = []) => (await pg.query(query, values)).rows;
  return { pg, sql, env, guard: createFr24PreviewSessionGuard(async () => sql, () => env) };
}

test("Preview configuration is explicit, disabled by default, and strictly validated", async () => {
  assert.equal(fr24PreviewModeEnabled(validEnv()), true);
  assert.equal(fr24PreviewModeEnabled(validEnv({ FR24_PREVIEW_ENABLED: undefined })), true,
    "provider mode is separate from permission to spend");
  assert.deepEqual(readFr24PreviewConfig(validEnv()), { ok: true, config: {
    sessionId: "approved-session-1", creditCap: 80, attemptCap: 10, expiresAt: AT + 2 * DAY,
  } });
  assert.equal(readFr24PreviewConfig(validEnv({ FR24_PREVIEW_ATTEMPT_CAP: "2" })).config.attemptCap, 2);
  const invalid = [
    { VERCEL_ENV: "production" }, { VERCEL_ENV: "development" }, { VERCEL_ENV: undefined },
    { FR24_PREVIEW_MODE: undefined }, { FR24_PREVIEW_MODE: "FR24-ONLY" },
    { FR24_PREVIEW_ENABLED: undefined }, { FR24_PREVIEW_ENABLED: "true" }, { FR24_PREVIEW_ENABLED: "0" },
    ...[undefined, "", "0", "-1", "7", "8.1", "NaN", "Infinity", "1e3", " 80", "80 ", "2147483648"]
      .map(FR24_PREVIEW_CREDIT_CAP => ({ FR24_PREVIEW_CREDIT_CAP })),
    ...["", "0", "-1", "11", "1.5"].map(FR24_PREVIEW_ATTEMPT_CAP => ({ FR24_PREVIEW_ATTEMPT_CAP })),
    ...[undefined, "", "2035-01-04", "2035-01-04T01:00:00", "2035-02-30T00:00:00Z", "nonsense"]
      .map(FR24_PREVIEW_EXPIRES_AT => ({ FR24_PREVIEW_EXPIRES_AT })),
    ...[undefined, "", " ", "x".repeat(129), "secret?token=x", "bad\nvalue"]
      .map(FR24_PREVIEW_SESSION_ID => ({ FR24_PREVIEW_SESSION_ID })),
  ];
  let sqlCalls = 0;
  for (const overrides of invalid) {
    const env = validEnv(overrides);
    assert.equal(readFr24PreviewConfig(env).ok, false, JSON.stringify(overrides));
    const guard = createFr24PreviewSessionGuard(async () => { sqlCalls += 1; throw new Error("must not connect"); }, () => env);
    assert.equal(await guard.reserve(8, AT), null);
    assert.equal((await guard.status(AT)).blocked, true);
  }
  assert.equal(sqlCalls, 0, "invalid configuration cannot even reach a database or a paid call");
});

test("simultaneous viewers and cold instances share one atomic allowance and in-flight gate", async () => {
  const { pg, sql, env } = await fixture(validEnv({ FR24_PREVIEW_CREDIT_CAP: "32" }));
  try {
    const viewers = Array.from({ length: 12 }, () => createFr24PreviewSessionGuard(async () => sql, () => env));
    for (let cycle = 0; cycle < 4; cycle += 1) {
      const reservations = (await Promise.all(viewers.map(guard => guard.reserve(8, AT + cycle)))).filter(Boolean);
      assert.equal(reservations.length, 1, "only one request can be dispatched while another is unfinished");
      const beforeFinish = await viewers[0].status(AT + cycle);
      assert.equal(beforeFinish.creditsConsumed, (cycle + 1) * 8, "worst-case cost is spent before dispatch");
      assert.equal(beforeFinish.attempts, cycle + 1);
      await viewers[cycle].finish(reservations[0], { statusCode: 200 }, AT + cycle);
    }
    assert.deepEqual(await Promise.all(viewers.map(guard => guard.reserve(8, AT + 5))), viewers.map(() => null));
    const status = await viewers[0].status(AT + 5);
    assert.equal(status.state, "budget_exhausted");
    assert.equal(status.remainingCredits, 0);
    assert.equal(status.remainingAttempts, 0);
    assert.equal(status.inFlight, false);
    assert.equal((await pg.query("select count(*)::integer as count from fr24_preview_reservations")).rows[0].count, 4);
  } finally { await pg.close(); }
});

test("attempt ceiling is independent of credits and every failed attempt remains fully charged", async () => {
  const { pg, guard } = await fixture(validEnv({ FR24_PREVIEW_ATTEMPT_CAP: "2" }));
  try {
    for (const details of [{ statusCode: null, errorKind: "timeout" }, { statusCode: 429, errorKind: "429" }]) {
      const reservation = await guard.reserve(1, AT);
      assert.ok(reservation);
      await guard.finish(reservation, details, AT);
      await guard.finish(reservation, details, AT + 1);
    }
    const status = await guard.status(AT + 2);
    assert.equal(status.state, "attempt_limit");
    assert.equal(status.creditsConsumed, 2);
    assert.equal(status.creditsReserved, 2);
    assert.equal(status.remainingCredits, 78);
    assert.equal(status.attempts, 2, "duplicate completion does not add attempts or refund credits");
    assert.equal(status.lastStatusCode, 429);
    assert.equal(await guard.reserve(1, AT + 2), null);
  } finally { await pg.close(); }
});

test("session allowance cannot reset at midnight or after redeployment and unfinished calls stay closed", async () => {
  const { pg, sql, env, guard } = await fixture(validEnv({ FR24_PREVIEW_CREDIT_CAP: "16" }));
  try {
    const reservation = await guard.reserve(8, AT);
    assert.ok(reservation);
    const redeployed = createFr24PreviewSessionGuard(async () => sql, () => ({ ...env, VERCEL_DEPLOYMENT_ID: "another-build" }));
    assert.equal(await redeployed.reserve(8, AT + DAY), null, "unfinished request cannot auto-release after a day");
    assert.equal((await redeployed.status(AT + DAY)).state, "in_flight");
    await redeployed.finish({ ...reservation, reservationId: "wrong-token" }, { statusCode: 200 }, AT + DAY);
    assert.equal((await guard.status(AT + DAY)).inFlight, true, "stale completion cannot release a current reservation");
    await redeployed.finish(reservation, { statusCode: null, errorKind: "dailybudget" }, AT + DAY);
    const next = await redeployed.reserve(8, AT + DAY);
    assert.ok(next);
    await guard.finish(next, { statusCode: 500, errorKind: "http" }, AT + DAY);
    const anotherInstance = createFr24PreviewSessionGuard(async () => sql, () => env);
    assert.equal(await anotherInstance.reserve(8, AT + DAY), null);
    assert.equal((await anotherInstance.status(AT + DAY)).creditsConsumed, 16);
  } finally { await pg.close(); }
});

test("configured cap, attempt ceiling, expiry and 402 stop are immutable for a session ID", async () => {
  const { pg, sql, env, guard } = await fixture();
  try {
    assert.equal((await guard.status(AT)).state, "ready", "first observation binds the approval parameters");
    for (const change of [
      { FR24_PREVIEW_CREDIT_CAP: "160" }, { FR24_PREVIEW_CREDIT_CAP: "16" },
      { FR24_PREVIEW_ATTEMPT_CAP: "1" }, { FR24_PREVIEW_EXPIRES_AT: new Date(AT + 3 * DAY).toISOString() },
    ]) {
      const changed = createFr24PreviewSessionGuard(async () => sql, () => ({ ...env, ...change }));
      const status = await changed.status(AT);
      assert.equal(status.state, "config_mismatch");
      assert.equal(status.creditCap, 80, "diagnostics retain actual persisted allowance");
      assert.equal(status.expiresAt, AT + 2 * DAY);
      assert.equal(await changed.reserve(8, AT), null);
    }
    await assert.rejects(pg.query("update fr24_preview_sessions set credit_cap = 160"), /cannot be renewed/);
    await assert.rejects(pg.query("update fr24_preview_sessions set expires_at = expires_at + 1000"), /cannot be renewed/);
    const reservation = await guard.reserve(8, AT);
    await guard.finish(reservation, { statusCode: 402 }, AT);
    await assert.rejects(pg.query("update fr24_preview_sessions set stopped_402 = false"), /cannot be renewed/);
    await assert.rejects(pg.query("update fr24_preview_sessions set credits_consumed = 0"), /cannot be renewed/);
    await assert.rejects(pg.query("update fr24_preview_sessions set attempts = 0"), /cannot be renewed/);
  } finally { await pg.close(); }
});

test("absolute expiry blocks at its boundary and the database clock defeats stale server time", async () => {
  const { pg, sql, env, guard } = await fixture(validEnv({ FR24_PREVIEW_EXPIRES_AT: new Date(AT + 1_000).toISOString() }));
  try {
    const reservation = await guard.reserve(8, AT + 999);
    assert.ok(reservation);
    await guard.finish(reservation, { statusCode: 200 }, AT + 999);
    assert.equal(await guard.reserve(8, AT + 1_000), null);
    assert.equal((await guard.status(AT + 1_000)).state, "expired");
    assert.equal((await createFr24PreviewSessionGuard(async () => sql, () => env).status(AT + DAY)).state, "expired");
    const staleNow = Date.now() - 60_000;
    const past = createFr24PreviewSessionGuard(async () => sql, () => validEnv({
      FR24_PREVIEW_SESSION_ID: "past-session", FR24_PREVIEW_EXPIRES_AT: new Date(staleNow + 1000).toISOString(),
    }));
    assert.equal(await past.reserve(8, staleNow), null, "an old now value cannot extend the session");
    assert.equal((await past.status(staleNow)).state, "expired");
  } finally { await pg.close(); }
});

test("dispatch grant is one-shot, token-fenced and works for the final approved attempt", async () => {
  const { pg, sql, env, guard } = await fixture(validEnv({ FR24_PREVIEW_CREDIT_CAP: "8" }));
  try {
    const reservation = await guard.reserve(8, AT);
    assert.ok(reservation);
    assert.equal((await guard.status(AT)).state, "budget_exhausted");
    assert.equal(await guard.canDispatch({ ...reservation, reservationId: "wrong" }, AT), false);
    assert.equal(await guard.canDispatch({ ...reservation, maximum: 1 }, AT), false);
    const grants = await Promise.all(Array.from({ length: 10 }, () =>
      createFr24PreviewSessionGuard(async () => sql, () => env).canDispatch(reservation, AT)));
    assert.equal(grants.filter(Boolean).length, 1, "one reserved attempt cannot authorize multiple dispatches");
    await guard.finish(reservation, { statusCode: 200 }, AT);
    assert.equal(await guard.canDispatch(reservation, AT), false);
    const receipt = (await pg.query("select dispatched_at, finished_at from fr24_preview_reservations")).rows[0];
    assert.equal(receipt.dispatched_at, AT);
    assert.equal(receipt.finished_at, AT);
  } finally { await pg.close(); }
});

test("slow preflight, disabled config and database failures cannot dispatch an existing reservation", async () => {
  const { pg, sql, env, guard } = await fixture(validEnv({ FR24_PREVIEW_EXPIRES_AT: new Date(AT + 1000).toISOString() }));
  try {
    const reservation = await guard.reserve(8, AT);
    assert.ok(reservation);
    for (const change of [
      { FR24_PREVIEW_ENABLED: "0" }, { VERCEL_ENV: "production" }, { FR24_PREVIEW_CREDIT_CAP: "160" },
      { FR24_PREVIEW_EXPIRES_AT: new Date(AT + DAY).toISOString() },
      { FR24_PREVIEW_SESSION_ID: "another-session" },
    ]) {
      const changed = createFr24PreviewSessionGuard(async () => sql, () => ({ ...env, ...change }));
      assert.equal(await changed.canDispatch(reservation, AT), false);
    }
    const unavailable = createFr24PreviewSessionGuard(async () => { throw new Error("database unavailable"); }, () => env);
    assert.equal(await unavailable.canDispatch(reservation, AT), false);
    assert.equal((await guard.status(AT)).inFlight, true);
    assert.equal(await guard.canDispatch(reservation, AT + 1000), false,
      "expiry crossed while waiting for daily reservation must block dispatch");
    assert.equal((await pg.query("select dispatched_at from fr24_preview_reservations")).rows[0].dispatched_at, null);
    assert.equal((await guard.status(AT + 1000)).creditsConsumed, 8, "expired reservation is never refunded");
  } finally { await pg.close(); }
});

test("402 persists across viewers, day rollover and redeploy, even if config changed in flight", async () => {
  const { pg, sql, env, guard } = await fixture();
  try {
    const reservation = await guard.reserve(8, AT);
    assert.ok(reservation);
    const disabledDuringCall = createFr24PreviewSessionGuard(async () => sql, () => validEnv({ FR24_PREVIEW_ENABLED: "0" }));
    await disabledDuringCall.finish(reservation, { statusCode: 402, errorKind: "http" }, AT);
    await guard.finish(reservation, { statusCode: 200 }, AT + 1000);
    const cold = createFr24PreviewSessionGuard(async () => sql, () => env);
    const status = await cold.status(AT + DAY);
    assert.equal(status.state, "stopped_402");
    assert.equal(status.stopped402, true);
    assert.equal(status.lastStatusCode, 402);
    assert.equal(status.lastErrorKind, "402");
    assert.equal(status.creditsConsumed, 8);
    assert.equal(status.attempts, 1);
    assert.equal(status.inFlight, false);
    assert.equal(await cold.reserve(8, AT + DAY), null);
  } finally { await pg.close(); }
});

test("failed finish leaves the session closed and token fencing rejects unrelated 402 completions", async () => {
  const { pg, sql, env, guard } = await fixture();
  try {
    const reservation = await guard.reserve(8, AT);
    await guard.finish({ ...reservation, reservationId: "unknown" }, { statusCode: 402 }, AT);
    assert.equal((await guard.status(AT)).stopped402, false);
    const failed = createFr24PreviewSessionGuard(async () => { throw new Error("database offline"); }, () => env);
    await assert.rejects(failed.finish(reservation, { statusCode: 402 }, AT), /database offline/);
    const cold = createFr24PreviewSessionGuard(async () => sql, () => env);
    assert.equal(await cold.reserve(8, AT + DAY), null);
    assert.equal((await cold.status(AT + DAY)).state, "in_flight");
    await cold.finish(reservation, { statusCode: 402 }, AT + DAY);
    assert.equal((await guard.status(AT + DAY)).state, "stopped_402");
  } finally { await pg.close(); }
});

test("unknown outcome or receipt failures never refund and diagnostics contain no arbitrary error text", async () => {
  const { pg, guard } = await fixture();
  try {
    const reservation = await guard.reserve(8, AT);
    await guard.finish(reservation, { statusCode: null, errorKind: "Bearer private-api-token in upstream error" }, AT);
    const status = await guard.status(AT);
    assert.equal(status.creditsConsumed, 8);
    assert.equal(status.lastErrorKind, "error");
    assert.equal(status.lastStatusCode, null);
    assert.equal(status.inFlight, false);
    assert.equal(JSON.stringify(status).includes("private-api-token"), false);
    assert.equal((await pg.query("select error_kind from fr24_preview_reservations")).rows[0].error_kind, "error");
  } finally { await pg.close(); }
});

test("missing database, schema or invalid reservation inputs always fail closed", async () => {
  const env = validEnv();
  const unavailable = createFr24PreviewSessionGuard(async () => { throw new Error("secret database address"); }, () => env);
  assert.equal(await unavailable.reserve(8, AT), null);
  const status = await unavailable.status(AT);
  assert.equal(status.state, "database_unavailable");
  assert.equal(JSON.stringify(status).includes("secret"), false);
  let sqlCalls = 0;
  const neverSql = createFr24PreviewSessionGuard(async () => { sqlCalls += 1; throw new Error("must not connect"); }, () => env);
  for (const maximum of [0, -1, 0.5, NaN, Infinity, MAX_SAFE_INTEGER, 81]) {
    assert.equal(await neverSql.reserve(maximum, AT), null);
  }
  for (const now of [NaN, Infinity, -1, 0.5]) assert.equal(await neverSql.reserve(8, now), null);
  assert.equal(sqlCalls, 0);
  const oldDatabaseUrl = process.env.DATABASE_URL;
  try {
    delete process.env.DATABASE_URL;
    const noDurableDatabase = createFr24PreviewSessionGuard(undefined, () => env);
    assert.equal(await noDurableDatabase.reserve(8, AT), null);
    assert.equal((await noDurableDatabase.status(AT)).state, "database_unavailable",
      "deployed Preview cannot fall back to an in-memory allowance");
  } finally {
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
  }
});

test("missing receipt table rolls back the atomic reservation instead of opening an untracked allowance", async () => {
  const { pg, guard } = await fixture();
  try {
    await pg.exec("drop table fr24_preview_reservations");
    assert.equal(await guard.reserve(8, AT), null);
    const status = await guard.status(AT);
    assert.equal(status.creditsConsumed, 0);
    assert.equal(status.attempts, 0);
    assert.equal(status.inFlight, false);
    await pg.exec("drop table fr24_preview_sessions cascade");
    assert.equal((await guard.status(AT)).state, "database_unavailable");
    assert.equal(await guard.reserve(8, AT), null);
  } finally { await pg.close(); }
});

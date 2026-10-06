import type { Sql } from "./db.ts";
import { fr24DailyCreditCap, fr24Endpoint, type Fr24Endpoint } from "./fr24-budget.ts";

export type Fr24UsageDiagnostics = {
  day: string;
  calls: number;
  credits: number;
  reservedCredits: number;
  cap: number;
  remaining: number;
  blocked: boolean;
};

type CacheRow = { payload: unknown; fetched_at: number | null; refresh_token: string | null; refresh_expires_at: number | null };
type UsageRow = { calls: number; credits: number; reserved_credits: number; credit_cap: number };
type Reservation = { day: string; maximum: number; cap: number };

function chicagoDay(now: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(now));
  const value = (kind: string) => parts.find((part) => part.type === kind)?.value ?? "00";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function deploymentInfo() {
  return {
    deployment: process.env.VERCEL_DEPLOYMENT_ID?.trim() || process.env.VERCEL_URL?.trim() || "local",
    environment: process.env.VERCEL_ENV?.trim() || "development",
  };
}

const defaultSqlProvider = async (): Promise<Sql> => (await import("./db.ts")).getSql();

export function createFr24Guard(sqlProvider: () => Promise<Sql> = defaultSqlProvider) {
  async function usage(now = Date.now()): Promise<Fr24UsageDiagnostics> {
    const day = chicagoDay(now);
    const cap = fr24DailyCreditCap(now);
    const sql = await sqlProvider();
    const rows = await sql<UsageRow>`select calls, credits, reserved_credits, credit_cap from fr24_daily_usage where usage_day = ${day}`;
    const row = rows[0];
    const effectiveCap = cap;
    const calls = row?.calls ?? 0, credits = row?.credits ?? 0, reservedCredits = row?.reserved_credits ?? 0;
    return { day, calls, credits, reservedCredits, cap: effectiveCap,
      remaining: Math.max(0, effectiveCap - credits - reservedCredits), blocked: credits + reservedCredits >= effectiveCap };
  }

  async function reserve(maximum: number, now = Date.now()): Promise<Reservation | null> {
    const day = chicagoDay(now), cap = fr24DailyCreditCap(now);
    const sql = await sqlProvider();
    const rows = await sql<UsageRow>`
      insert into fr24_daily_usage (usage_day, calls, credits, reserved_credits, credit_cap, updated_at)
      select ${day}, 0, 0, ${maximum}, ${cap}, now()
      where ${maximum}::integer <= ${cap}::integer
      on conflict (usage_day) do update set
        reserved_credits = fr24_daily_usage.reserved_credits + ${maximum},
        credit_cap = excluded.credit_cap,
        updated_at = now()
      where fr24_daily_usage.credits + fr24_daily_usage.reserved_credits + ${maximum}
        <= excluded.credit_cap
      returning calls, credits, reserved_credits, credit_cap`;
    return rows[0] ? { day, maximum, cap: rows[0].credit_cap } : null;
  }

  async function finish(reservation: Reservation, details: {
    ident: string; endpoint: Fr24Endpoint; credits: number; statusCode: number | null;
    resultCount: number | null; errorKind: string | null;
  }) {
    const sql = await sqlProvider();
    const meta = deploymentInfo();
    await sql.query(`
      with usage as (
        update fr24_daily_usage set
          calls = calls + 1,
          credits = credits + $1,
          reserved_credits = greatest(0, reserved_credits - $2),
          updated_at = now()
        where usage_day = $3
      )
      insert into fr24_call_log
        (usage_day, deployment, environment, ident, endpoint, credits, status_code, result_count, error_kind)
      values ($3, $4, $5, $6, $7, $1, $8, $9, $10)
    `, [details.credits, reservation.maximum, reservation.day, meta.deployment, meta.environment,
      details.ident, details.endpoint, details.statusCode, details.resultCount, details.errorKind]);
  }

  async function cached(cacheKey: string, maxAgeMs: number, now = Date.now()): Promise<{ value: unknown; ageMs: number } | null> {
    const sql = await sqlProvider();
    const rows = await sql<CacheRow>`select payload, fetched_at, refresh_token, refresh_expires_at from fr24_shared_cache where cache_key = ${cacheKey}`;
    const row = rows[0], ageMs = row?.fetched_at == null ? Infinity : now - row.fetched_at;
    return row?.payload != null && ageMs >= 0 && ageMs <= maxAgeMs ? { value: row.payload, ageMs } : null;
  }

  async function acquire(cacheKey: string, endpoint: Fr24Endpoint, ident: string, token: string, now = Date.now()): Promise<boolean> {
    const sql = await sqlProvider();
    const rows = await sql<{ refresh_token: string }>`
      insert into fr24_shared_cache (cache_key, endpoint, ident, refresh_token, refresh_expires_at, updated_at)
      values (${cacheKey}, ${endpoint}, ${ident}, ${token}, ${now + 8_000}, now())
      on conflict (cache_key) do update set
        endpoint = excluded.endpoint, ident = excluded.ident,
        refresh_token = excluded.refresh_token, refresh_expires_at = excluded.refresh_expires_at,
        updated_at = now()
      where fr24_shared_cache.refresh_token is null
        or fr24_shared_cache.refresh_expires_at is null
        or fr24_shared_cache.refresh_expires_at <= ${now}
      returning refresh_token`;
    return rows[0]?.refresh_token === token;
  }

  async function store(cacheKey: string, token: string, value: unknown, now = Date.now()) {
    const sql = await sqlProvider();
    await sql.query(`update fr24_shared_cache set payload = $1::jsonb, fetched_at = $2,
      refresh_token = null, refresh_expires_at = null, updated_at = now()
      where cache_key = $3 and refresh_token = $4`, [JSON.stringify(value ?? null), now, cacheKey, token]);
  }

  async function release(cacheKey: string, token: string) {
    const sql = await sqlProvider();
    await sql`update fr24_shared_cache set refresh_token = null, refresh_expires_at = null, updated_at = now()
      where cache_key = ${cacheKey} and refresh_token = ${token}`;
  }

  return { usage, reserve, finish, cached, acquire, store, release };
}

type Fr24Guard = ReturnType<typeof createFr24Guard>;
let guard: Fr24Guard = createFr24Guard();

/** Test seam for exercising FR24 lookup selection without booting a database. */
export function setFr24GuardForTests(next: Fr24Guard) {
  guard = next;
}

export const fr24UsageToday: Fr24Guard["usage"] = (...args) => guard.usage(...args);
export const reserveFr24Credits: Fr24Guard["reserve"] = (...args) => guard.reserve(...args);
export const finishFr24Call: Fr24Guard["finish"] = (...args) => guard.finish(...args);
export const readFr24Cache: Fr24Guard["cached"] = (...args) => guard.cached(...args);
export const acquireFr24Cache: Fr24Guard["acquire"] = (...args) => guard.acquire(...args);
export const storeFr24Cache: Fr24Guard["store"] = (...args) => guard.store(...args);
export const releaseFr24Cache: Fr24Guard["release"] = (...args) => guard.release(...args);
export { fr24Endpoint };

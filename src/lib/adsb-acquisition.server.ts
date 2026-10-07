import type { Sql } from "./db.ts";

/** Demand-driven acquisition for free sources only. No paid-provider imports. */
export type FreeAdsbProvider = "fi" | "lol" | "al" | "trace-airtraffic" | "trace-fi" | "trace-al";
export type AcquisitionStatus = "ok" | "403" | "429" | "timeout" | "error" | "backoff" | "busy" | "unavailable";
export type AdsbAcquisition = {
  data: unknown; receivedAt: number | null; status: AcquisitionStatus;
  cache: boolean; retryAt?: number;
};
export type AdsbRequest = { provider: FreeAdsbProvider; url: string; timeoutMs: number };
const HOSTS: Record<FreeAdsbProvider, string> = {
  fi: "opendata.adsb.fi", lol: "api.adsb.lol", al: "api.airplanes.live",
  "trace-airtraffic": "globe.theairtraffic.com", "trace-fi": "globe.adsb.fi", "trace-al": "globe.airplanes.live",
};
const FRESH_MS = 5_000, RETAIN_MS = 120_000, LEASE_MS = 10_000;
type CacheRow = { payload: unknown; received_at: number | null; fresh_until: number; retain_until: number; refresh_expires_at: number };
const empty = (status: AcquisitionStatus, retryAt?: number): AdsbAcquisition => ({ data: null, receivedAt: null, status, cache: false, retryAt });

export function retryAfterMs(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

export function createAdsbAcquisitionStore(sqlProvider: () => Promise<Sql>) {
  async function read(key: string) {
    const sql = await sqlProvider();
    return (await sql<CacheRow>`select payload, received_at, fresh_until, retain_until, refresh_expires_at
      from adsb_shared_cache where cache_key = ${key}`)[0];
  }
  async function acquire(key: string, provider: FreeAdsbProvider, token: string) {
    const sql = await sqlProvider();
    await sql`insert into adsb_provider_gate(provider) values (${provider}) on conflict do nothing`;
    // Updating the provider row serializes admissions against cooldown writes.
    // Distinct keys remain independent: no global mutex that starves alias lookups.
    const rows = await sql.query<{ acquired_at: number }>(`
      with gate as (
        update adsb_provider_gate set admitted_at = floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
          window_at = case when window_at + 1000 <= floor(extract(epoch from clock_timestamp()) * 1000)::bigint
            then floor(extract(epoch from clock_timestamp()) * 1000)::bigint else window_at end,
          window_calls = case when window_at + 1000 <= floor(extract(epoch from clock_timestamp()) * 1000)::bigint then 1 else window_calls + 1 end
        where provider = $2 and cooldown_until <= floor(extract(epoch from clock_timestamp()) * 1000)::bigint
          and (window_calls < 2 or window_at + 1000 <= floor(extract(epoch from clock_timestamp()) * 1000)::bigint)
        returning admitted_at
      ), claim as (
        insert into adsb_shared_cache(cache_key, provider, refresh_token, refresh_expires_at)
        select $1, $2, $3, admitted_at + $4 from gate
        on conflict(cache_key) do update set refresh_token = excluded.refresh_token,
          refresh_expires_at = excluded.refresh_expires_at
        where adsb_shared_cache.refresh_expires_at <= excluded.refresh_expires_at - $4
          and adsb_shared_cache.fresh_until <= excluded.refresh_expires_at - $4
        returning cache_key
      ) select admitted_at as acquired_at from gate where exists(select 1 from claim)
    `, [key, provider, token, LEASE_MS]);
    return rows[0]?.acquired_at ?? null;
  }
  async function cooldown(provider: FreeAdsbProvider) {
    const sql = await sqlProvider();
    return (await sql<{ cooldown_until: number }>`select cooldown_until from adsb_provider_gate where provider = ${provider}`)[0]?.cooldown_until ?? 0;
  }
  async function admissionRetryAt(provider: FreeAdsbProvider) {
    const sql = await sqlProvider();
    return (await sql<{ retry_at: number }>`select greatest(cooldown_until,
      case when window_calls >= 2 then window_at + 1000 else 0 end) as retry_at
      from adsb_provider_gate where provider=${provider}`)[0]?.retry_at ?? 0;
  }
  async function complete(key: string, provider: FreeAdsbProvider, token: string, data: unknown, receivedAt: number, acquiredAt: number) {
    const sql = await sqlProvider();
    // Token fencing prevents a late, expired owner from overwriting its successor.
    await sql.query(`update adsb_shared_cache set payload=$4::jsonb, received_at=$5,
      fresh_until=$5::bigint+$6::bigint, retain_until=$5::bigint+$7::bigint, refresh_token=null, refresh_expires_at=0
      where cache_key=$1 and provider=$2 and refresh_token=$3
        and refresh_expires_at > floor(extract(epoch from clock_timestamp()) * 1000)::bigint`,
    [key, provider, token, JSON.stringify(data), receivedAt, FRESH_MS, RETAIN_MS]);
    // A request admitted before a newer failure cannot reset its failure history.
    await sql`update adsb_provider_gate set failures=0 where provider=${provider} and last_failure_at < ${acquiredAt}`;
  }
  async function fail(provider: FreeAdsbProvider, status: AcquisitionStatus, retryMs = 0) {
    const sql = await sqlProvider();
    await sql.query(`update adsb_provider_gate set failures=least(failures+1, 1000),
      last_failure_at=floor(extract(epoch from clock_timestamp()) * 1000)::bigint,
      cooldown_until=greatest(cooldown_until, floor(extract(epoch from clock_timestamp()) * 1000)::bigint +
        greatest($3::bigint, case when $2='403' then 1800000 when $2='429' then
          case when failures=0 then 60000 when failures=1 then 120000 else 300000 end
          else case when failures=0 then 6000 when failures=1 then 15000 else 40000 end end))
      where provider=$1`, [provider, status, Math.ceil(retryMs)]);
  }
  async function release(key: string, token: string) {
    const sql = await sqlProvider();
    await sql`update adsb_shared_cache set refresh_token=null, refresh_expires_at=0 where cache_key=${key} and refresh_token=${token}`;
  }
  // Six providers admit <=720 new keys/minute; 1024 amortizes above that
  // maximum while keeping each demand-driven cleanup bounded.
  async function cleanup() {
    const sql = await sqlProvider();
    await sql`delete from adsb_shared_cache where cache_key in (select cache_key from adsb_shared_cache
      where retain_until < floor(extract(epoch from clock_timestamp()) * 1000)::bigint
        and refresh_expires_at < floor(extract(epoch from clock_timestamp()) * 1000)::bigint
      order by retain_until limit 1024)
      and retain_until < floor(extract(epoch from clock_timestamp()) * 1000)::bigint
      and refresh_expires_at < floor(extract(epoch from clock_timestamp()) * 1000)::bigint`;
  }
  return { read, acquire, cooldown, admissionRetryAt, complete, fail, release, cleanup };
}

type Store = ReturnType<typeof createAdsbAcquisitionStore>;
export function createAdsbAcquirer(store: Store, options: {
  fetch?: typeof fetch; now?: () => number; wait?: (ms: number) => Promise<void>;
} = {}) {
  const clock = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const pending = new Map<string, Promise<AdsbAcquisition>>();
  const local = new Map<string, AdsbAcquisition>();
  let cleanupAfter = 0;
  const cached = (row: CacheRow | undefined, maxAge: number, status: AcquisitionStatus): AdsbAcquisition | null => {
    const now = clock();
    return row?.payload != null && row.received_at != null && now >= row.received_at
      && now - row.received_at <= maxAge && row.retain_until > now
      ? { data: row.payload, receivedAt: row.received_at, status, cache: true } : null;
  };
  async function run(request: AdsbRequest, key: string): Promise<AdsbAcquisition> {
    let token: string | null = null;
    try {
      let row = await store.read(key);
      const hit = cached(row, FRESH_MS, "ok");
      if (hit) return hit;
      token = crypto.randomUUID();
      let acquiredAt = await store.acquire(key, request.provider, token);
      // Bounded admission retries let distinct keys progress without a global
      // in-flight mutex. The SQL fixed-window cap admits at most two per second.
      for (let attempt = 0; acquiredAt == null && attempt < 2; attempt += 1) {
        const cooldownUntil = await store.cooldown(request.provider);
        if (cooldownUntil > clock()) break;
        row = await store.read(key);
        if (cached(row, FRESH_MS, "ok")) break;
        if ((row?.refresh_expires_at ?? 0) > clock()) break;
        const retryAt = await store.admissionRetryAt(request.provider);
        if (retryAt <= clock()) break;
        await wait(Math.min(1100, Math.max(1, retryAt - clock() + 10)));
        acquiredAt = await store.acquire(key, request.provider, token);
      }
      if (acquiredAt == null) {
        const retryAt = await store.cooldown(request.provider);
        if (retryAt > clock()) return { ...(cached(row, RETAIN_MS, "backoff") ?? empty("backoff")), retryAt };
        // Bounded shared-cache wait, never an unguarded second provider request.
        for (const delay of [100, 200, 400, 800]) {
          await wait(delay);
          row = await store.read(key);
          const shared = cached(row, FRESH_MS, "ok");
          if (shared) return shared;
        }
        return { ...(cached(row, RETAIN_MS, "busy") ?? empty("busy")), retryAt: Math.max(row?.refresh_expires_at ?? 0, await store.admissionRetryAt(request.provider), clock() + 1000) };
      }
      // Snapshot age is anchored once, before HTTP, including network latency.
      const receivedAt = clock();
      try {
        let response: Response | undefined;
        let data: unknown = null;
        let failure: AcquisitionStatus | null = null;
        try {
          response = await (options.fetch ?? globalThis.fetch)(request.url, {
            headers: { Accept: "application/json", "User-Agent": "Inbound/1.0 free-adsb-acquisition" },
            redirect: "error",
            signal: AbortSignal.timeout(Math.min(4000, Math.max(1, request.timeoutMs))),
          });
          if (response.ok) data = await response.json();
          else failure = response.status === 429 ? "429" : response.status === 403 ? "403" : "error";
        } catch (error) {
          failure = error instanceof Error && /abort|timeout/i.test(`${error.name} ${error.message}`) ? "timeout" : "error";
        }
        if (failure) {
          await store.fail(request.provider, failure, retryAfterMs(response?.headers.get("retry-after") ?? null, clock()));
          return { ...(cached(row, RETAIN_MS, failure) ?? empty(failure)), retryAt: await store.cooldown(request.provider) };
        }
        // Coordination failures must not be recorded as provider failures.
        await store.complete(key, request.provider, token, data, receivedAt, acquiredAt);
        if (clock() >= cleanupAfter) {
          cleanupAfter = clock() + 60_000;
          await store.cleanup().catch(() => undefined);
        }
        return { data, receivedAt, status: "ok", cache: false };
      } finally {
        await store.release(key, token);
      }
    } catch {
      // A missing migration/unreachable coordinator must never become permission
      // for one unguarded request per viewer or cold instance.
      return empty("unavailable");
    }
  }
  return async function acquire(request: AdsbRequest): Promise<AdsbAcquisition> {
    let url: URL;
    try { url = new URL(request.url); } catch { return empty("unavailable"); }
    if (url.protocol !== "https:" || url.hostname !== HOSTS[request.provider] || url.username || url.password || url.port) {
      return empty("unavailable");
    }
    const key = `${request.provider}:${url.href}`;
    const hit = local.get(key);
    if (hit?.receivedAt != null && clock() >= hit.receivedAt && clock() - hit.receivedAt < FRESH_MS) return { ...hit, cache: true };
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= 256) return empty("busy", clock() + 1000);
    const work = run(request, key).then(result => {
      if (result.status === "ok" && result.receivedAt != null) {
        if (local.size >= 256) local.delete(local.keys().next().value!);
        local.set(key, result);
      }
      return result;
    }).finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
  };
}

/** Abort only this viewer's wait. Never cancel another viewer's shared fetch. */
export function waitForAdsbViewer(work: Promise<AdsbAcquisition>, signal?: AbortSignal): Promise<AdsbAcquisition | null> {
  if (!signal) return work;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); resolve(null); };
    signal.addEventListener("abort", abort, { once: true });
    work.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

const defaultStore = createAdsbAcquisitionStore(async () => {
  if ((process.env.VERCEL || process.env.VERCEL_ENV || process.env.NODE_ENV === "production") && !process.env.DATABASE_URL?.trim()) {
    throw new Error("Shared ADS-B coordination requires the configured database in deployment");
  }
  return (await import("./db.ts")).getSql();
});
export const acquireFreeAdsb = createAdsbAcquirer(defaultStore);

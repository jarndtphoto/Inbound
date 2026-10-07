import type { Sql } from "./db.ts";

export const FLIGHT_STATE_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const ATIS_RETENTION_MS = 24 * 60 * 60_000;
export const CLEANUP_INTERVAL_MS = 6 * 60 * 60_000;
export const CLEANUP_BATCH_LIMIT = 1000;
export type FlightStateCleanup = (sql: Sql) => Promise<void>;
type Throttle = { nextRunAtMs: number | null };
type Options = {
  now?: () => number;
  onError?: (table: string, error: unknown) => void;
  throttle?: Throttle;
};

/** Called after a successful write, never by reads or DB initialization. */
export function createFlightStateCleanup(options: Options = {}): FlightStateCleanup {
  const throttle = options.throttle ?? { nextRunAtMs: null };
  const logFailure = (table: string, error: unknown) => {
    // Logging must not change the successful flight write's result either.
    try {
      if (options.onError) options.onError(table, error);
      else console.error("[flight-state-cleanup] failed", { table, error });
    } catch { /* Best effort, including the logger. */ }
  };
  return async (sql) => {
    try {
      const now = options.now?.() ?? Date.now();
      if (!Number.isFinite(now) || (throttle.nextRunAtMs != null && now < throttle.nextRunAtMs)) return;
      // Reserve before the first await. Concurrent writes and failed attempts
      // share the same six-hour budget; a failure cannot create a retry storm.
      throttle.nextRunAtMs = now + CLEANUP_INTERVAL_MS;
      const flightCutoff = new Date(now - FLIGHT_STATE_RETENTION_MS).toISOString();
      const atisCutoff = now - ATIS_RETENTION_MS;
      const deletes = [
        { table: "flight_phase_state", run: () => sql`
          with stale as (
            select land_key from public.flight_phase_state
            where updated_at < ${flightCutoff}::timestamptz
            order by updated_at, land_key limit ${CLEANUP_BATCH_LIMIT}
            for update skip locked
          )
          delete from public.flight_phase_state as target using stale
          where target.land_key = stale.land_key and target.updated_at < ${flightCutoff}::timestamptz` },
        { table: "arrival_projection_state", run: () => sql`
          with stale as (
            select land_key from public.arrival_projection_state
            where updated_at < ${flightCutoff}::timestamptz
            order by updated_at, land_key limit ${CLEANUP_BATCH_LIMIT}
            for update skip locked
          )
          delete from public.arrival_projection_state as target using stale
          where target.land_key = stale.land_key and target.updated_at < ${flightCutoff}::timestamptz` },
        { table: "flight_route_state", run: () => sql`
          with stale as (
            select land_key from public.flight_route_state
            where updated_at < ${flightCutoff}::timestamptz
            order by updated_at, land_key limit ${CLEANUP_BATCH_LIMIT}
            for update skip locked
          )
          delete from public.flight_route_state as target using stale
          where target.land_key = stale.land_key and target.updated_at < ${flightCutoff}::timestamptz` },
        { table: "flight_ground_state", run: () => sql`
          with stale as (
            select land_key from public.flight_ground_state
            where updated_at < ${flightCutoff}::timestamptz
            order by updated_at, land_key limit ${CLEANUP_BATCH_LIMIT}
            for update skip locked
          )
          delete from public.flight_ground_state as target using stale
          where target.land_key = stale.land_key and target.updated_at < ${flightCutoff}::timestamptz` },
        { table: "arrival_atis_cache", run: () => sql`
          with stale as (
            select airport from public.arrival_atis_cache
            where fetched_at < ${atisCutoff}
            order by fetched_at, airport limit ${CLEANUP_BATCH_LIMIT}
            for update skip locked
          )
          delete from public.arrival_atis_cache as target using stale
          where target.airport = stale.airport and target.fetched_at < ${atisCutoff}` },
      ];
      // A failure in one table must not suppress the remaining bounded deletes.
      for (const entry of deletes) {
        try { await entry.run(); }
        catch (error) { logFailure(entry.table, error); }
      }
    } catch (error) { logFailure("run", error); }
  };
}

// Keep one reservation across all stores and dev HMR instances in this server.
// Other serverless processes have their own budget, as requested.
const globalRef = globalThis as typeof globalThis & { __flightStateCleanupThrottle__?: Throttle };
globalRef.__flightStateCleanupThrottle__ ??= { nextRunAtMs: null };
export const cleanupFlightStateRows = createFlightStateCleanup({ throttle: globalRef.__flightStateCleanupThrottle__ });

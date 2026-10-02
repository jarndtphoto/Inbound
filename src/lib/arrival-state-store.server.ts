import type { Sql } from "./db.ts";
import { emptyArrivalState, type ArrivalProjectionState } from "./arrival-projection-state.ts";
import type { AtisEntry } from "./arrival-runway.ts";

type Row = { state: ArrivalProjectionState; version: number };
/** Injecting the SQL connection lets tests exercise actual Postgres semantics
 * with fresh store instances, without relying on any serverless module maps. */
export function createArrivalStateStore(sqlProvider: () => Promise<Sql>) {
  const fallback = new Map<string, ArrivalProjectionState>();
  return {
    async load(key: string) {
      try {
        const sql = await sqlProvider();
        const rows = await sql<Row>`select state, version from arrival_projection_state where land_key = ${key}`;
        return { state: rows[0]?.state ?? emptyArrivalState(), version: rows[0]?.version ?? 0, status: "ok" as const };
      } catch (error) {
        console.error("[arrival-state] load failed", error);
        return { state: fallback.get(key) ?? emptyArrivalState(), version: 0, status: "read_failed" as const };
      }
    },
    async save(key: string, state: ArrivalProjectionState, version: number) {
      try {
        const sql = await sqlProvider();
        const rows = await sql<Row>`insert into arrival_projection_state (land_key, state, version)
          values (${key}, ${JSON.stringify(state)}::jsonb, 1)
          on conflict (land_key) do update set state = excluded.state,
            version = arrival_projection_state.version + 1, updated_at = now()
          where arrival_projection_state.version = ${version}
          returning state, version`;
        if (rows[0]) { fallback.delete(key); return { ...rows[0], status: "ok" as const }; }
        // A concurrent winner owns the path and side. Never blindly overwrite
        // it with our older snapshot; return it for this response as well.
        const current = await this.load(key);
        if (current.status === "read_failed") return { state, version, status: "write_failed" as const };
        return { ...current, status: "conflict_held" as const };
      } catch (error) {
        console.error("[arrival-state] save failed", error);
        if (fallback.size >= 100) fallback.delete(fallback.keys().next().value!);
        fallback.set(key, state);
        return { state, version, status: "write_failed" as const };
      }
    },
    async loadAtis(airport: string, now = Date.now(), maxAgeMs = 10 * 60_000) {
      try {
        const sql = await sqlProvider();
        const rows = await sql<{ entries: AtisEntry[] }>`select entries from arrival_atis_cache
          where airport = ${airport} and fetched_at >= ${now - maxAgeMs} and fetched_at <= ${now}`;
        return rows[0]?.entries ?? [];
      } catch { return []; }
    },
    async saveAtis(airport: string, entries: AtisEntry[], now = Date.now()) {
      if (!entries.length) return;
      try {
        const sql = await sqlProvider();
        await sql`insert into arrival_atis_cache (airport, entries, fetched_at)
          values (${airport}, ${JSON.stringify(entries)}::jsonb, ${now})
          on conflict (airport) do update set entries = excluded.entries, fetched_at = excluded.fetched_at
          where arrival_atis_cache.fetched_at < excluded.fetched_at`;
      } catch (error) { console.error("[arrival-atis] cache write failed", error); }
    },
  };
}
export const arrivalStateStore = createArrivalStateStore(async () => (await import("./db")).getSql());

import type { Sql } from "./db.ts";
import { cleanupFlightStateRows, type FlightStateCleanup } from "./flight-state-retention.server.ts";
import { emptyRouteMemory, mergeRouteMemory, routeLeg, sameRouteLeg, routeMemoryEqual, sanitizeRouteMemory, type RouteLeg, type RouteMemory } from "./route-memory.ts";

type Row = { state: RouteMemory; version: number };
type Result = Row & { status: "ok" | "read_failed" | "write_failed" | "conflict_resolved" | "conflict_held" };
type Loaded = Result & { storedState: RouteMemory };

export function createRouteMemoryStore(sqlProvider: () => Promise<Sql>, cleanup: FlightStateCleanup = cleanupFlightStateRows) {
  async function read(key: string, leg: RouteLeg): Promise<Row> {
    const sql = await sqlProvider();
    const rows = await sql<Row>`select state, version from flight_route_state where land_key = ${key}`;
    return rows[0] && sameRouteLeg(rows[0].state.leg, leg) ? rows[0] : { state: emptyRouteMemory(leg), version: 0 };
  }
  async function save(key: string, state: RouteMemory, expectedVersion: number): Promise<Result> {
    if (!key) return { state: sanitizeRouteMemory(state), version: expectedVersion, status: "ok" };
    let merged = sanitizeRouteMemory(state), version = expectedVersion;
    try {
      const sql = await sqlProvider();
      // Merge before every CAS, including a current-version write. Weak polls
      // never overwrite stronger facts; retries merge a concurrent winner.
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await read(key, state.leg);
        merged = mergeRouteMemory(current.state, merged);
        if (routeMemoryEqual(merged, current.state))
          return { ...current, status: attempt ? "conflict_resolved" : "ok" };
        const rows = await sql<Row>`insert into flight_route_state (land_key, state, version)
          values (${key}, ${JSON.stringify(merged)}::jsonb, 1)
          on conflict (land_key) do update set state = excluded.state,
            version = flight_route_state.version + 1, updated_at = now()
          where flight_route_state.version = ${version}
          returning state, version`;
        if (rows[0]) { await cleanup(sql); return { ...rows[0], status: attempt ? "conflict_resolved" : "ok" }; }
        version = (await read(key, state.leg)).version;
      }
      const held = await read(key, state.leg);
      return { ...held, state: sanitizeRouteMemory(held.state), status: "conflict_held" };
    } catch (error) {
      console.error("[route-memory] save failed", { key, error });
      return { state: merged, version, status: "write_failed" };
    }
  }
  async function load(key: string, leg: RouteLeg, trustedLegacyKeys: string[] = []): Promise<Loaded> {
    const empty = emptyRouteMemory(leg);
    if (!key) return { state: empty, storedState: empty, version: 0, status: "ok" };
    try {
      let current = await read(key, leg);
      const storedState = current.state;
      current = { ...current, state: sanitizeRouteMemory(current.state) };
      // These exact same-leg alias/fallback keys come from server identity
      // validation. Never discover neighboring dates or provider-ID rows.
      for (const alias of [...new Set(trustedLegacyKeys)].filter(k => k !== key && k.startsWith("leg:"))) {
        const aliasLeg = routeLeg(alias, leg.origin, leg.destination);
        if (!aliasLeg) continue;
        const legacy = await read(alias, aliasLeg);
        if (legacy.version) current = { ...current, state: mergeRouteMemory(current.state, { ...legacy.state, leg }) };
      }
      // Carry aliases in memory. The caller compares against the actual stored
      // row and folds them with this poll's facts in its one final CAS save.
      return { ...current, storedState, status: "ok" };
    } catch (error) {
      console.error("[route-memory] load failed", { key, error });
      return { state: empty, storedState: empty, version: 0, status: "read_failed" };
    }
  }
  return { load, save };
}
export const routeMemoryStore = createRouteMemoryStore(async () => (await import("./db.ts")).getSql());

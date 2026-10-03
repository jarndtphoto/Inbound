import type { Sql } from "./db.ts";
import { legacyProviderPattern, legacyProviderBelongsToLeg } from "./flight-identity.ts";
import { EMPTY_PHASE_STATE, mergeForward, phaseStateEqual } from "./flight-phase-state-logic";
import type { PhaseState, PushLatch, TaxiOutLatch, ConfirmedTakeoff } from "./flight-phase-state-logic";

export type { PushLatch, TaxiOutLatch, PhaseState, ConfirmedTakeoff };
export { phaseStateEqual } from "./flight-phase-state-logic";
export type LoadResult = { state: PhaseState; version: number; status: "ok" | "read_failed" };
export type SaveStatus = "ok" | "conflict_resolved" | "conflict_dropped" | "write_failed";

type Row = {
  push_unix: number | null;
  push_source: string | null;
  push_live: boolean | null;
  push_at: number | null;
  taxi_out_at: number | null;
  version: number;
  confirmed_takeoff: ConfirmedTakeoff | null;
  land_key?: string;
};

function stateFromRow(row: Row | undefined): { state: PhaseState; version: number } {
  if (!row) return { state: { ...EMPTY_PHASE_STATE }, version: 0 };
  return {
    state: {
      push: row.push_unix != null
        ? { unix: row.push_unix, source: row.push_source, live: Boolean(row.push_live), at: row.push_at ?? row.push_unix }
        : null,
      taxiOut: row.taxi_out_at != null ? { at: row.taxi_out_at } : null,
      ...(row.confirmed_takeoff ? { confirmedTakeoff: row.confirmed_takeoff } : {}),
    },
    version: row.version,
  };
}

/** SQL injection keeps actual CAS and legacy-fold races testable across cold stores. */
export function createFlightPhaseStateStore(sqlProvider: () => Promise<Sql>) {
  async function read(key: string) {
    const sql = await sqlProvider();
    const rows = await sql<Row>`select push_unix, push_source, push_live, push_at, taxi_out_at, confirmed_takeoff, version
      from flight_phase_state where land_key = ${key}`;
    return stateFromRow(rows[0]);
  }
  async function writeOnce(landKey: string, next: PhaseState, expectedVersion: number): Promise<Row | undefined> {
    const sql = await sqlProvider();
    const rows = await sql<Row>`
      insert into flight_phase_state (land_key, push_unix, push_source, push_live, push_at, taxi_out_at, confirmed_takeoff, version, updated_at)
      values (${landKey}, ${next.push?.unix ?? null}, ${next.push?.source ?? null}, ${next.push?.live ?? null}, ${next.push?.at ?? null}, ${next.taxiOut?.at ?? null}, ${next.confirmedTakeoff ? JSON.stringify(next.confirmedTakeoff) : null}::jsonb, 1, now())
      on conflict (land_key) do update set
        push_unix = excluded.push_unix, push_source = excluded.push_source,
        push_live = excluded.push_live, push_at = excluded.push_at, taxi_out_at = excluded.taxi_out_at, confirmed_takeoff = excluded.confirmed_takeoff,
        version = flight_phase_state.version + 1, updated_at = now()
      where flight_phase_state.version = ${expectedVersion}
      returning push_unix, push_source, push_live, push_at, taxi_out_at, confirmed_takeoff, version`;
    return rows[0];
  }
  async function save(landKey: string, next: PhaseState, expectedVersion: number): Promise<SaveStatus> {
    if (!landKey) return "ok";
    try {
      // Even a write with the current version may omit previously confirmed
      // evidence. Merge it before the CAS; a racing writer still uses the retry.
      const prior = await read(landKey);
      if (await writeOnce(landKey, mergeForward(prior.state, next), expectedVersion)) return "ok";
      const current = await read(landKey);
      if (await writeOnce(landKey, mergeForward(current.state, next), current.version)) return "conflict_resolved";
      console.error("[flight-phase-state] save conflict retry also lost the race", { landKey });
      return "conflict_dropped";
    } catch (err) { console.error("[flight-phase-state] save failed", err); return "write_failed"; }
  }
  async function load(landKey: string, legacyKeys: string[] = [], recentLegacyKeys: string[] = []): Promise<LoadResult> {
    if (!landKey) return { state: { ...EMPTY_PHASE_STATE }, version: 0, status: "ok" };
    try {
      let current = await read(landKey);
      // An unvalidated poll may update its separate row after the canonical
      // row exists. Reconcile that row on later validated polls as well.
      const carryKeys = current.version === 0 ? legacyKeys : legacyKeys.filter(key => key.startsWith("leg:unvalidated:"));
      if (carryKeys.length || recentLegacyKeys.length) {
        const sql = await sqlProvider();
        const candidates = await sql<Row>`select land_key, push_unix, push_source, push_live, push_at, taxi_out_at, confirmed_takeoff, version
          from flight_phase_state where land_key = any(${carryKeys.filter(key => key !== landKey)}::text[])
            or land_key like ${current.version === 0 ? legacyProviderPattern(landKey) : ""}
            or (land_key = any(${recentLegacyKeys}::text[]) and updated_at >= now() - interval '18 hours' and updated_at <= now())`;
        const legacy = candidates.filter(row => carryKeys.includes(row.land_key!) || recentLegacyKeys.includes(row.land_key!) || (current.version === 0 && legacyProviderBelongsToLeg(row.land_key!, landKey)));
        if (legacy.length) {
          const merged = legacy.reduce((state, row) => mergeForward(state, stateFromRow(row).state), current.state);
          if (current.version > 0 && phaseStateEqual(current.state, merged)) return { ...current, status: "ok" };
          const status = await save(landKey, merged, current.version);
          if (status === "ok" || status === "conflict_resolved") {
            // Legacy rows stay intact; only future polls write the canonical key.
            current = await read(landKey);
          } else return { state: merged, version: current.version, status: "read_failed" };
        }
      }
      return { ...current, status: "ok" };
    } catch (err) {
      console.error("[flight-phase-state] load failed", err);
      return { state: { ...EMPTY_PHASE_STATE }, version: 0, status: "read_failed" };
    }
  }
  return { load, save };
}

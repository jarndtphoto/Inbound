import { getSql } from "./db";
import { EMPTY_PHASE_STATE, mergeForward } from "./flight-phase-state-logic";
import type { PhaseState, PushLatch, TaxiOutLatch } from "./flight-phase-state-logic";

export type { PushLatch, TaxiOutLatch, PhaseState };
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
};

function stateFromRow(row: Row | undefined): { state: PhaseState; version: number } {
  if (!row) return { state: { ...EMPTY_PHASE_STATE }, version: 0 };
  return {
    state: {
      push: row.push_unix != null
        ? { unix: row.push_unix, source: row.push_source, live: Boolean(row.push_live), at: row.push_at ?? row.push_unix }
        : null,
      taxiOut: row.taxi_out_at != null ? { at: row.taxi_out_at } : null,
    },
    version: row.version,
  };
}

/**
 * Durable replacement for the in-memory pushLatch / taxiOutLatch Maps that
 * used to live at module scope in story.server.ts. Those Maps lived in
 * serverless function process memory, which Vercel does not keep durable or
 * shared across cold starts or concurrent instances -- this is why
 * pushback/taxi-out detection could silently "forget" a flight's progress
 * depending on which instance happened to answer a given poll.
 * flight_phase_state (see migrations/0002_flight_phase_state.sql) is the
 * single durable source of truth instead, keyed by the same landKey
 * (flightInstanceKey()) story.server.ts already computes per flight instance.
 *
 * Usage inside buildStory(): one loadPhaseState() right after landKey is
 * known, ordinary local mutation of the returned value exactly the way the
 * old Maps were read/written, then one AWAITED savePhaseState() right before
 * returning (only if the value actually changed) -- fire-and-forget was
 * tried first and rejected: Vercel is free to suspend the invocation the
 * instant the response finishes, and an un-awaited write can simply never
 * happen, silently reproducing the exact bug this table exists to fix.
 *
 * savePhaseState is a conditional UPDATE guarded by `version` (loaded at the
 * same time as the state). Two near-simultaneous polls for the same flight
 * can both load the same row, compute independently, and race to write it
 * back; without a guard the slower write can blindly overwrite a newer,
 * more-advanced observation. The loser's write instead affects zero rows,
 * gets one retry merged against the fresh row (mergeForward), and only
 * *drops* if even that retry loses the race too -- rare enough in practice
 * that logging and moving on beats blocking the response on a loop.
 *
 * A load or save failure (DB outage, missing migration, etc.) must not break
 * flight loading -- both fall back to behaving like an empty/no-op Map did
 * before this existed, and log rather than throw.
 */
export async function loadPhaseState(landKey: string): Promise<LoadResult> {
  if (!landKey) return { state: { ...EMPTY_PHASE_STATE }, version: 0, status: "ok" };
  try {
    const sql = await getSql();
    const rows = await sql<Row>`select push_unix, push_source, push_live, push_at, taxi_out_at, version
       from flight_phase_state where land_key = ${landKey}`;
    const { state, version } = stateFromRow(rows[0]);
    return { state, version, status: "ok" };
  } catch (err) {
    console.error("[flight-phase-state] load failed", err);
    return { state: { ...EMPTY_PHASE_STATE }, version: 0, status: "read_failed" };
  }
}

async function writeOnce(landKey: string, next: PhaseState, expectedVersion: number): Promise<Row | undefined> {
  const sql = await getSql();
  const rows = await sql<Row>`
    insert into flight_phase_state (land_key, push_unix, push_source, push_live, push_at, taxi_out_at, version, updated_at)
    values (${landKey}, ${next.push?.unix ?? null}, ${next.push?.source ?? null}, ${next.push?.live ?? null}, ${next.push?.at ?? null}, ${next.taxiOut?.at ?? null}, 1, now())
    on conflict (land_key) do update set
      push_unix = excluded.push_unix,
      push_source = excluded.push_source,
      push_live = excluded.push_live,
      push_at = excluded.push_at,
      taxi_out_at = excluded.taxi_out_at,
      version = flight_phase_state.version + 1,
      updated_at = now()
    where flight_phase_state.version = ${expectedVersion}
    returning push_unix, push_source, push_live, push_at, taxi_out_at, version
  `;
  return rows[0];
}

export async function savePhaseState(landKey: string, next: PhaseState, expectedVersion: number): Promise<SaveStatus> {
  if (!landKey) return "ok";
  try {
    const written = await writeOnce(landKey, next, expectedVersion);
    if (written) return "ok";

    // Lost the version race. Read whatever the winner left, merge forward
    // (prefer more/newer information on each field independently) rather
    // than either blindly reapplying our stale view or silently dropping
    // this observation, and retry exactly once against the fresh version.
    const sql = await getSql();
    const currentRows = await sql<Row>`select push_unix, push_source, push_live, push_at, taxi_out_at, version
       from flight_phase_state where land_key = ${landKey}`;
    const current = stateFromRow(currentRows[0]);
    const merged = mergeForward(current.state, next);
    const retried = await writeOnce(landKey, merged, current.version);
    if (retried) return "conflict_resolved";
    console.error("[flight-phase-state] save conflict retry also lost the race", { landKey });
    return "conflict_dropped";
  } catch (err) {
    console.error("[flight-phase-state] save failed", err);
    return "write_failed";
  }
}

import { getSql } from "./db";

export type PushLatch = { unix: number; source: string | null; live: boolean; at: number } | null;
export type TaxiOutLatch = { at: number } | null;
export type PhaseState = { push: PushLatch; taxiOut: TaxiOutLatch };

const EMPTY: PhaseState = { push: null, taxiOut: null };

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
 * old Maps were read/written, then one savePhaseState() right before
 * returning (only if the value actually changed).
 *
 * A load or save failure (DB outage, missing migration, etc.) must not break
 * flight loading -- both fall back to behaving like an empty/no-op Map did
 * before this existed, and log rather than throw.
 */
export async function loadPhaseState(landKey: string): Promise<PhaseState> {
  if (!landKey) return { ...EMPTY };
  try {
    const sql = await getSql();
    const rows = await sql<{
      push_unix: number | null;
      push_source: string | null;
      push_live: boolean | null;
      push_at: number | null;
      taxi_out_at: number | null;
    }>`select push_unix, push_source, push_live, push_at, taxi_out_at
       from flight_phase_state where land_key = ${landKey}`;
    const row = rows[0];
    if (!row) return { ...EMPTY };
    return {
      push: row.push_unix != null
        ? { unix: row.push_unix, source: row.push_source, live: Boolean(row.push_live), at: row.push_at ?? row.push_unix }
        : null,
      taxiOut: row.taxi_out_at != null ? { at: row.taxi_out_at } : null,
    };
  } catch (err) {
    console.error("[flight-phase-state] load failed", err);
    return { ...EMPTY };
  }
}

export async function savePhaseState(landKey: string, next: PhaseState): Promise<void> {
  if (!landKey) return;
  try {
    const sql = await getSql();
    await sql`
      insert into flight_phase_state (land_key, push_unix, push_source, push_live, push_at, taxi_out_at, updated_at)
      values (${landKey}, ${next.push?.unix ?? null}, ${next.push?.source ?? null}, ${next.push?.live ?? null}, ${next.push?.at ?? null}, ${next.taxiOut?.at ?? null}, now())
      on conflict (land_key) do update set
        push_unix = excluded.push_unix,
        push_source = excluded.push_source,
        push_live = excluded.push_live,
        push_at = excluded.push_at,
        taxi_out_at = excluded.taxi_out_at,
        updated_at = now()
    `;
  } catch (err) {
    console.error("[flight-phase-state] save failed", err);
  }
}

/** Cheap dirty-check so buildStory only writes back when a latch actually changed. */
export function phaseStateEqual(a: PhaseState, b: PhaseState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

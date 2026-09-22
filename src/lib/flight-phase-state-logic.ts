// Pure, dependency-free logic for flight-phase-state.server.ts, split out so
// it can be unit-tested under plain `node --test` without pulling in db.ts.
// db.ts's PGLite fallback calls `import.meta.glob` (a Vite build-time macro)
// eagerly at module load whenever DATABASE_URL is unset, which is not
// available outside a Vite context -- importing db.ts (even transitively)
// from a plain Node test process throws before any assertion runs. Keep
// anything here free of "./db" and any other server-only import.

export type PushLatch = { unix: number; source: string | null; live: boolean; at: number } | null;
export type TaxiOutLatch = { at: number } | null;
export type PhaseState = { push: PushLatch; taxiOut: TaxiOutLatch };

export const EMPTY_PHASE_STATE: PhaseState = { push: null, taxiOut: null };

/**
 * Prefer whichever side has more/newer information -- used only to resolve a
 * write that lost the optimistic-concurrency race in savePhaseState, never on
 * the normal (uncontended) path. Each field is resolved independently: a
 * missing push on one side never discards a present push on the other, and
 * between two present values the numerically later one wins.
 */
export function mergeForward(a: PhaseState, b: PhaseState): PhaseState {
  const push = !a.push ? b.push : !b.push ? a.push : (a.push.unix >= b.push.unix ? a.push : b.push);
  const taxiOut = !a.taxiOut ? b.taxiOut : !b.taxiOut ? a.taxiOut : (a.taxiOut.at >= b.taxiOut.at ? a.taxiOut : b.taxiOut);
  return { push, taxiOut };
}

/** Cheap dirty-check so buildStory only writes back when a latch actually changed. */
export function phaseStateEqual(a: PhaseState, b: PhaseState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

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
 * Resolve two competing PushLatch observations -- used only to merge a write
 * that lost the optimistic-concurrency race in savePhaseState, never on the
 * normal (uncontended) path, where reconcilePushLatch/choosePushEvidence in
 * story.server.ts already own this decision.
 *
 * Deliberately NOT "later wins": story.server.ts's existing push-detection
 * logic treats an *earlier* confirmed observation as the more trustworthy one
 * (choosePushEvidence: "Preserve the earliest actual evidence. A later
 * provider OUT value can confirm the event, but must not replace an earlier
 * physical stand exit."; reconcilePushLatch's default is
 * `prior.unix <= selected.unix ? prior : selected`). A later timestamp
 * usually just means a slower/laggier detection of the same event, not a
 * better one. This mirrors that: a `provider_actual` record outranks a
 * track/live detection (matching choosePushEvidence's provider preference),
 * and otherwise the earlier `unix` wins. This intentionally does not
 * reproduce reconcilePushLatch's narrow "copied schedule estimate corrected
 * by a materially later live detection" exception, which needs gate-out
 * schedule context PhaseState doesn't carry -- out of scope for a rare
 * conflict-resolution path.
 */
function resolvePush(a: PushLatch, b: PushLatch): PushLatch {
  if (!a) return b;
  if (!b) return a;
  const aAuthoritative = a.source === "provider_actual";
  const bAuthoritative = b.source === "provider_actual";
  if (aAuthoritative !== bAuthoritative) return aAuthoritative ? a : b;
  return a.unix <= b.unix ? a : b;
}

/**
 * Prefer whichever side has more/newer information -- used only to resolve a
 * write that lost the optimistic-concurrency race in savePhaseState, never on
 * the normal (uncontended) path. Each field is resolved independently: a
 * missing value on one side never discards a present value on the other.
 *
 * taxiOut has no earlier-is-truer property the way push does: it's not a
 * physical-event timestamp with a "true" moment to converge on, it's "when
 * this server last confirmed taxi was underway" -- story.server.ts's
 * single-writer path (see the `taxiOutLatchValue = { at: Date.now() / 1e3 }`
 * assignment) already refreshes it to the current poll time on every poll
 * where taxi is still observed, uncontested. Preferring the later `at` here
 * on a conflict is consistent with that, not a special case for it.
 */
export function mergeForward(a: PhaseState, b: PhaseState): PhaseState {
  const push = resolvePush(a.push, b.push);
  const taxiOut = !a.taxiOut ? b.taxiOut : !b.taxiOut ? a.taxiOut : (a.taxiOut.at >= b.taxiOut.at ? a.taxiOut : b.taxiOut);
  return { push, taxiOut };
}

/** Cheap dirty-check so buildStory only writes back when a latch actually changed. */
export function phaseStateEqual(a: PhaseState, b: PhaseState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

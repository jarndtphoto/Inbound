// Pure, dependency-free logic for flight-phase-state.server.ts, split out so
// it can be unit-tested under plain `node --test` without pulling in db.ts.
// db.ts's PGLite fallback calls `import.meta.glob` (a Vite build-time macro)
// eagerly at module load whenever DATABASE_URL is unset, which is not
// available outside a Vite context -- importing db.ts (even transitively)
// from a plain Node test process throws before any assertion runs. Keep
// anything here free of "./db" and any other server-only import.

export type PushLatch = { unix: number; source: string | null; live: boolean; at: number } | null;
export type TaxiOutLatch = { at: number } | null;
export type TakeoffRevocation = { time: number; at: number };
// Revocations stay in the existing JSONB even when no active latch remains.
// That lets CAS/legacy merges reject a stale copy of the same provider stamp.
export type ConfirmedTakeoff = { time: number | null; source: "provider_actual" | "observed_airborne"; confirmedAt: number;
  observedAt?: number; revocations?: TakeoffRevocation[] };
export type PhaseState = { push: PushLatch; taxiOut: TaxiOutLatch; confirmedTakeoff?: ConfirmedTakeoff;
  // Proven prior-tail segments cannot become this leg's detected push again.
  // Provider actuals are independently scoped to the dated leg.
  pushNotBeforeUnix?: number };

export const EMPTY_PHASE_STATE: PhaseState = { push: null, taxiOut: null };

/** Scope evidence only advances; callers predating this field cannot erase it. */
export function mergePushNotBeforeUnix(a?: number, b?: number): number | undefined {
  const values = [a, b].filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return values.length ? Math.max(...values) : undefined;
}

/** Tail-trace attribution cannot revoke provider actuals or contemporaneous same-leg live proof. */
export function pushWithinScope(push: PushLatch, pushNotBeforeUnix?: number): PushLatch {
  return push && push.source !== "provider_actual" && push.source !== "live_detected" && pushNotBeforeUnix != null && push.unix < pushNotBeforeUnix
    ? null : push;
}

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
  const pushNotBeforeUnix = mergePushNotBeforeUnix(a.pushNotBeforeUnix, b.pushNotBeforeUnix);
  const push = resolvePush(pushWithinScope(a.push, pushNotBeforeUnix), pushWithinScope(b.push, pushNotBeforeUnix));
  const taxiOut = !a.taxiOut ? b.taxiOut : !b.taxiOut ? a.taxiOut : (a.taxiOut.at >= b.taxiOut.at ? a.taxiOut : b.taxiOut);
  const confirmedTakeoff = mergeConfirmedTakeoff(a.confirmedTakeoff, b.confirmedTakeoff);
  return { push, taxiOut, ...(confirmedTakeoff ? { confirmedTakeoff } : {}),
    ...(pushNotBeforeUnix != null ? { pushNotBeforeUnix } : {}) };
}

/** Cheap dirty-check so buildStory only writes back when a latch actually changed. */
export function phaseStateEqual(a: PhaseState, b: PhaseState): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Observed proof is permanent; rejected provider stamps merge as tombstones. */
export function mergeConfirmedTakeoff(a?: ConfirmedTakeoff, b?: ConfirmedTakeoff): ConfirmedTakeoff | undefined {
  if (!a) return b;
  if (!b) return a;
  const revocations = [...a.revocations ?? [], ...b.revocations ?? []].reduce<TakeoffRevocation[]>((all, item) => {
    const prior = all.find(r => r.time === item.time);
    if (prior) prior.at = Math.min(prior.at, item.at); else all.push({ ...item });
    return all;
  }, []).sort((x, y) => x.time - y.time);
  const observations = [a, b].flatMap(x => x.observedAt != null ? [x.observedAt]
    : x.source === "observed_airborne" ? [x.confirmedAt] : []);
  const observedAt = observations.length ? Math.min(...observations) : undefined;
  const actuals = [a, b].filter(x => x.source === "provider_actual" && x.time != null);
  const accepted = actuals.filter(x => !revocations.some(r => r.time === x.time));
  const clocks = accepted.length ? accepted : actuals;
  return { source: actuals.length ? "provider_actual" : "observed_airborne",
    time: clocks.length ? Math.min(...clocks.map(x => x.time!)) : null,
    confirmedAt: Math.min(a.confirmedAt, b.confirmedAt),
    ...(observedAt != null && actuals.length ? { observedAt } : {}),
    ...(revocations.length ? { revocations } : {}) };
}

export function activeConfirmedTakeoff(c?: ConfirmedTakeoff): ConfirmedTakeoff | undefined {
  if (!c) return;
  if (c.source === "provider_actual" && c.revocations?.some(r => r.time === c.time))
    return c.observedAt != null ? { ...c, source: "observed_airborne", time: null } : undefined;
  return c;
}

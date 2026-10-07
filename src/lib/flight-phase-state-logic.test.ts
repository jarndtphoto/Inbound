import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_PHASE_STATE, activeConfirmedTakeoff, mergeForward, phaseStateEqual, type PhaseState } from "./flight-phase-state-logic.ts";

const push = (unix: number, source: string | null = "track_detected", live = true, at = unix): PhaseState["push"] => ({ unix, source, live, at });
const taxi = (at: number): PhaseState["taxiOut"] => ({ at });
const state = (push_: PhaseState["push"], taxi_: PhaseState["taxiOut"]): PhaseState => ({ push: push_, taxiOut: taxi_ });

describe("mergeForward", () => {
  it("keeps a present push when the other side has none", () => {
    const a = state(push(100), null);
    const b = state(null, null);
    assert.deepEqual(mergeForward(a, b), a);
    assert.deepEqual(mergeForward(b, a), a);
  });

  it("keeps a present taxiOut when the other side has none", () => {
    const a = state(null, taxi(100));
    const b = state(null, null);
    assert.deepEqual(mergeForward(a, b), a);
    assert.deepEqual(mergeForward(b, a), a);
  });

  it("prefers the earlier push when both sides have one and neither is provider_actual", () => {
    // choosePushEvidence/reconcilePushLatch in story.server.ts both treat an
    // earlier confirmed observation as the more trustworthy one -- a later
    // detection of the same event isn't "better," just laggier. The conflict
    // merge mirrors that instead of independently inventing a "later wins"
    // rule.
    const earlier = state(push(100), null);
    const later = state(push(200), null);
    assert.deepEqual(mergeForward(earlier, later), earlier);
    assert.deepEqual(mergeForward(later, earlier), earlier);
  });

  it("prefers a provider_actual push over a later-or-earlier track/live detection", () => {
    const authoritative = state(push(150, "provider_actual"), null);
    const earlierTrack = state(push(100, "track_detected"), null);
    const laterTrack = state(push(200, "live_detected"), null);
    assert.deepEqual(mergeForward(authoritative, earlierTrack), authoritative);
    assert.deepEqual(mergeForward(earlierTrack, authoritative), authoritative);
    assert.deepEqual(mergeForward(authoritative, laterTrack), authoritative);
    assert.deepEqual(mergeForward(laterTrack, authoritative), authoritative);
  });

  it("falls back to earliest-wins between two provider_actual records", () => {
    const earlier = state(push(100, "provider_actual"), null);
    const later = state(push(200, "provider_actual"), null);
    assert.deepEqual(mergeForward(earlier, later), earlier);
    assert.deepEqual(mergeForward(later, earlier), earlier);
  });

  it("prefers the numerically later taxiOut when both sides have one", () => {
    const earlier = state(null, taxi(100));
    const later = state(null, taxi(200));
    assert.deepEqual(mergeForward(earlier, later), later);
    assert.deepEqual(mergeForward(later, earlier), later);
  });

  it("resolves push and taxiOut independently, never all-or-nothing", () => {
    // a has the later push but no taxi; b has the earlier (preferred) push and the only taxi.
    const a = state(push(200), null);
    const b = state(push(100), taxi(50));
    const merged = mergeForward(a, b);
    assert.deepEqual(merged.push, push(100));
    assert.deepEqual(merged.taxiOut, taxi(50));
  });

  it("returns an empty state when both sides are empty", () => {
    assert.deepEqual(mergeForward(EMPTY_PHASE_STATE, EMPTY_PHASE_STATE), EMPTY_PHASE_STATE);
  });
});

describe("phaseStateEqual", () => {
  it("treats two empty states as equal", () => {
    assert.ok(phaseStateEqual(EMPTY_PHASE_STATE, { push: null, taxiOut: null }));
  });

  it("treats identical non-empty states as equal", () => {
    assert.ok(phaseStateEqual(state(push(100), taxi(50)), state(push(100), taxi(50))));
  });

  it("treats a changed push as not equal", () => {
    assert.ok(!phaseStateEqual(state(push(100), null), state(push(200), null)));
  });

  it("treats a changed taxiOut as not equal", () => {
    assert.ok(!phaseStateEqual(state(null, taxi(50)), state(null, taxi(60))));
  });

  it("treats a present vs. absent field as not equal", () => {
    assert.ok(!phaseStateEqual(state(push(100), null), state(null, null)));
  });

  it("persists a newly proven push scope even without another latch change", () => {
    assert.ok(!phaseStateEqual(EMPTY_PHASE_STATE, { ...EMPTY_PHASE_STATE, pushNotBeforeUnix: 150 }));
  });
});

describe("durable push scope", () => {
  it("rejects a prior-tail detected push before the newly proven boundary in either order", () => {
    const stale = state(push(100), null);
    const scoped = { ...EMPTY_PHASE_STATE, pushNotBeforeUnix: 150 };
    assert.deepEqual(mergeForward(stale, scoped), scoped);
    assert.deepEqual(mergeForward(scoped, stale), scoped);
  });

  it("keeps the maximum boundary through older or boundary-free states", () => {
    const scoped = { ...state(push(200), null), pushNotBeforeUnix: 150 };
    const stale = { ...state(push(100), null), pushNotBeforeUnix: 90 };
    assert.deepEqual(mergeForward(scoped, stale), scoped);
    assert.deepEqual(mergeForward(stale, scoped), scoped);
    assert.deepEqual(mergeForward(scoped, state(push(100), null)), scoped);
  });

  it("never rejects a provider actual based on physical trace scope", () => {
    const provider = state(push(100, "provider_actual"), null);
    const scoped = { ...EMPTY_PHASE_STATE, pushNotBeforeUnix: 150 };
    const expected = { ...provider, pushNotBeforeUnix: 150 };
    assert.deepEqual(mergeForward(provider, scoped), expected);
    assert.deepEqual(mergeForward(scoped, provider), expected);
  });

  it("preserves the earliest valid physical push, including one exactly at the boundary", () => {
    const early = { ...state(push(150), null), pushNotBeforeUnix: 150 };
    const later = state(push(200, "live_detected"), null);
    assert.deepEqual(mergeForward(early, later), early);
    assert.deepEqual(mergeForward(later, early), early);
  });

  it("keeps the old state shape when scope evidence is absent", () => {
    const earlier = state(push(100), null);
    const later = state(push(200), null);
    assert.deepEqual(mergeForward(earlier, later), earlier);
    assert.ok(!Object.hasOwn(mergeForward(earlier, later), "pushNotBeforeUnix"));
  });
});


describe("confirmed takeoff merge", () => {
  const empty = { push: null, taxiOut: null };
  const observed = { ...empty, confirmedTakeoff: { time: null, source: "observed_airborne" as const, confirmedAt: 120 } };
  const actual = { ...empty, confirmedTakeoff: { time: 100, source: "provider_actual" as const, confirmedAt: 130 } };
  it("never erases confirmation with an empty or stale ground state", () => {
    assert.deepEqual(mergeForward(observed, empty), observed);
    assert.deepEqual(mergeForward(empty, observed), observed);
  });
  it("keeps provider actual time over observed and the first confirmation, in either order", () => {
    const expected = { ...actual, confirmedTakeoff: { ...actual.confirmedTakeoff, confirmedAt: 120, observedAt: 120 } };
    assert.deepEqual(mergeForward(actual, observed), expected);
    assert.deepEqual(mergeForward(observed, actual), expected);
  });
  it("observations keep a null event time and confirmations merge associatively", () => {
    const later = { ...observed, confirmedTakeoff: { ...observed.confirmedTakeoff, confirmedAt: 150 } };
    assert.equal(mergeForward(observed, later).confirmedTakeoff!.time, null);
    assert.deepEqual(mergeForward(mergeForward(actual, later), observed), mergeForward(actual, mergeForward(later, observed)));
  });
  it("revoked stamps cannot return through a merge, corrected stamps can, and observed proof is retained", () => {
    const revoked = { ...actual, confirmedTakeoff: { ...actual.confirmedTakeoff, revocations: [{ time: 100, at: 150 }] } };
    assert.equal(activeConfirmedTakeoff(mergeForward(actual, revoked).confirmedTakeoff), undefined);
    const corrected = { ...actual, confirmedTakeoff: { ...actual.confirmedTakeoff, time: 160, confirmedAt: 170 } };
    const combined = mergeForward(revoked, corrected);
    assert.equal(activeConfirmedTakeoff(combined.confirmedTakeoff)?.time, 160);
    assert.equal(activeConfirmedTakeoff(mergeForward(combined, actual).confirmedTakeoff)?.time, 160);
    const permanent = mergeForward(revoked, observed);
    assert.equal(activeConfirmedTakeoff(permanent.confirmedTakeoff)?.source, "observed_airborne");
    assert.deepEqual(mergeForward(mergeForward(revoked, corrected), observed), mergeForward(revoked, mergeForward(corrected, observed)));
  });

});

it("trace attribution fences preserve contemporaneous live-detected proof", () => {
  const observed = { ...state(push(100, "live_detected"), null), pushNotBeforeUnix: 150 };
  assert.deepEqual(mergeForward(observed, { ...EMPTY_PHASE_STATE, pushNotBeforeUnix: 140 }), observed);
});

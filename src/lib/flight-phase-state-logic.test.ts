import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EMPTY_PHASE_STATE, mergeForward, phaseStateEqual, type PhaseState } from "./flight-phase-state-logic.ts";

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
});

import test from "node:test";
import assert from "node:assert/strict";
import { groundStoryObservation } from "./ground-story-position.ts";
import { groundPollingEnabled } from "./flight-polling.ts";
import type { FlightStory } from "./types.ts";

const fetchedAt = Date.parse("2026-10-07T12:00:00Z");
const story = { fetchedAt, aircraft: null, providers: { chosenPositionAgeSec: 1 } };

test("cached story timestamp is immutable across clock advancement and remounts", () => {
  const initial = groundStoryObservation(story, fetchedAt)!;
  for (const elapsedSec of [0, 10, 29, 30, 60, 119, 120, 600]) {
    const current = groundStoryObservation({ ...story }, fetchedAt + elapsedSec * 1000)!;
    assert.equal(current.seenAt, initial.seenAt);
    assert.equal(current.ageSec, elapsedSec + 1);
    assert.equal(groundPollingEnabled(true, true, false, false, current.ageSec <= 30, true), elapsedSec >= 30);
  }
});

test("absolute observed time cannot be rejuvenated by a repeated response", () => {
  const observed = { ...story, providers: { chosenPositionSeenAt: fetchedAt / 1000 - 20, chosenPositionAgeSec: 0 } };
  assert.deepEqual(groundStoryObservation({ ...observed, fetchedAt: fetchedAt + 60_000 }, fetchedAt + 60_000), {
    seenAt: fetchedAt / 1000 - 20, ageSec: 80,
  });
});

test("missing, non-finite, future, and extrapolated observations are not live fixes", () => {
  for (const patch of [
    { providers: {} },
    { fetchedAt: NaN },
    { providers: { chosenPositionAgeSec: Infinity } },
    { providers: { chosenPositionAgeSec: -1 } },
    { providers: { chosenPositionSeenAt: fetchedAt / 1000 + 20 } },
    { aircraft: { extrapolated: true } },
  ]) {
    assert.equal(groundStoryObservation({ ...story, ...patch } as FlightStory, fetchedAt), null);
  }
});

test("small clock skew is bounded without changing observed time", () => {
  const skewed = { ...story, providers: { chosenPositionSeenAt: fetchedAt / 1000 + 5 } };
  assert.equal(groundStoryObservation(skewed, fetchedAt)?.ageSec, 0);
  assert.equal(groundStoryObservation(skewed, fetchedAt + 40_000)?.ageSec, 35);
});

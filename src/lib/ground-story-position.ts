import type { FlightStory } from "./types.ts";

export function groundObservationAge(seenAt: unknown, nowMs = Date.now()): number | null {
  if (typeof seenAt !== "number" || !Number.isFinite(seenAt) || seenAt <= 0 || !Number.isFinite(nowMs)) return null;
  const ageSec = nowMs / 1000 - seenAt;
  return ageSec < -10 ? null : Math.max(0, ageSec);
}

/** Observation time belongs to the response, never to a render or cache read. */
export function groundStoryObservation(
  story: Pick<FlightStory, "fetchedAt" | "providers" | "aircraft">,
  nowMs = Date.now(),
): { seenAt: number; ageSec: number } | null {
  if (story.aircraft?.extrapolated) return null;
  const explicit = story.providers?.chosenPositionSeenAt;
  const reportedAge = story.providers?.chosenPositionAgeSec ?? story.aircraft?.seenSec;
  const seenAt = typeof explicit === "number" && Number.isFinite(explicit)
    ? explicit
    : typeof reportedAge === "number" && Number.isFinite(reportedAge) && reportedAge >= 0
      && Number.isFinite(story.fetchedAt)
      ? story.fetchedAt / 1000 - reportedAge
      : null;
  // Small receiver/clock skew is tolerable; invalid future fixes are not fresh.
  const ageSec = groundObservationAge(seenAt, nowMs);
  if (seenAt == null || ageSec == null) return null;
  return { seenAt, ageSec };
}

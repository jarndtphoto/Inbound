import type { FlightStory } from "./types.ts";

export function flightPollingComplete(story: Pick<FlightStory, "currentStage" | "times">, nowMs = Date.now()) {
  if (story.currentStage === "gate") return true;
  const landedAt = story.times.landUnix;
  return story.times.landKind === "actual" && typeof landedAt === "number"
    && nowMs / 1000 - landedAt >= 30 * 60;
}

export function groundPollingEnabled(active: boolean, visible: boolean, complete: boolean, inFlight: boolean, hasFreshStory: boolean, hasIdentity: boolean) {
  return active && visible && !complete && !inFlight && !hasFreshStory && hasIdentity;
}

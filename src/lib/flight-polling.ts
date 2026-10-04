import type { FlightStory } from "./types.ts";

export function flightPollingComplete(story: Pick<FlightStory, "currentStage" | "times">, nowMs = Date.now()) {
  if (story.currentStage === "gate") return true;
  const landedAt = story.times.landUnix;
  return story.times.landKind === "actual" && typeof landedAt === "number"
    && nowMs / 1000 - landedAt >= 30 * 60;
}

export function flightPollingInterval(
  story: Pick<FlightStory, "currentStage" | "times" | "live" | "aircraft">,
  nowMs = Date.now(),
) {
  if (flightPollingComplete(story, nowMs)) return 60_000;

  const phase = story.aircraft?.phase ?? null;
  if (story.currentStage === "push" || story.currentStage === "taxi" || story.currentStage === "taxi_in") return 3_000;
  if (story.currentStage === "takeoff_roll") return 4_000;
  if (story.currentStage === "final_approach" || phase === "approach") return 6_000;
  if (story.currentStage === "arrival" || phase === "descent") return 10_000;

  if (story.currentStage === "ride") {
    if (phase === "climb") {
      const takeoffAt = story.times.takeoffUnix;
      const sinceTakeoffSec = typeof takeoffAt === "number" ? nowMs / 1000 - takeoffAt : Number.POSITIVE_INFINITY;
      return sinceTakeoffSec >= 0 && sinceTakeoffSec <= 10 * 60 ? 6_000 : 10_000;
    }
    return 20_000;
  }

  if (story.currentStage === "origin_gate" && story.live) return 3_000;
  if (story.currentStage === "inbound") return 5_000;
  return 8_000;
}

export function groundPollingEnabled(active: boolean, visible: boolean, complete: boolean, inFlight: boolean, hasFreshStory: boolean, hasIdentity: boolean) {
  return active && visible && !complete && !inFlight && !hasFreshStory && hasIdentity;
}

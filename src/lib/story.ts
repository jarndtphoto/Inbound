import { createServerFn } from "@tanstack/react-start";
import { loadFlightStory, loadLiveBoard } from "./story.server";
import { readFlightResume, type FlightResume } from "./flight-resume";
import type { FlightStory } from "./types";

/**
 * Preserve confirmed departure progress across refreshes/serverless handoffs.
 * A stop or slower surface fix after pushback/taxi is not a return to the gate.
 */
export function preserveDepartureProgress(story: FlightStory, prior?: FlightResume): FlightStory {
  const priorStage = prior?.departureStage ?? null;
  const current = story.currentStage;

  // Airborne/arrival states always outrank departure history.
  if (["ride", "arrival", "final_approach", "taxi_in", "gate"].includes(current)) return story;

  let stage = current;
  if (priorStage === "taxi" && (current === "origin_gate" || current === "push" || current === "inbound")) {
    stage = "taxi";
  } else if (priorStage === "push" && (current === "origin_gate" || current === "inbound")) {
    stage = "push";
  }

  // A fresh trustworthy surface observation can advance the durable client
  // checkpoint even if an earlier provider refresh missed the transition.
  const live = story.aircraft;
  const freshSurface = Boolean(live?.onGround && !live.extrapolated && (live.seenSec ?? 999) <= 30);
  if (freshSurface && stage === "origin_gate") {
    if ((live?.gsKt ?? 0) >= 8) stage = "taxi";
    else if ((live?.gsKt ?? 0) >= 2) stage = "push";
  } else if (freshSurface && stage === "push" && (live?.gsKt ?? 0) >= 8) {
    stage = "taxi";
  }

  const durableStage = stage === "taxi" ? "taxi" : stage === "push" ? "push" : priorStage;
  const resume = story.resume && durableStage
    ? { ...story.resume, departureStage: durableStage }
    : story.resume;

  return stage === current && resume === story.resume ? story : { ...story, currentStage: stage, resume };
}

/** Passenger flight story — live track, ride grade, delays. */
export const getFlightStory = createServerFn({ method: "POST" })
  .validator((input: { q: string; fresh?: boolean; resume?: FlightResume }) => {
    const q = String(input?.q ?? "").trim();
    if (!q) throw new Error("Enter a flight number");
    if (q.length > 16) throw new Error("Flight number is too long");
    return { q, fresh: Boolean(input?.fresh), resume: readFlightResume(input?.resume, q) };
  })
  .handler(async ({ data }) => {
    const story = await loadFlightStory(data.q, { fresh: data.fresh, resume: data.resume });
    return preserveDepartureProgress(story, data.resume);
  });

export const listLiveFlights = createServerFn({ method: "POST" }).handler(async () => loadLiveBoard());

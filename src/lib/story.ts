import { createServerFn } from "@tanstack/react-start";
import { loadFlightStory, loadLiveBoard } from "./story.server";
import { readFlightResume, type FlightResume } from "./flight-resume";
import { haversineNm } from "./geo";
import type { FlightStory } from "./types";

/**
 * Preserve confirmed departure progress across refreshes/serverless handoffs.
 * Departure is a one-way passenger story:
 * origin_gate -> push -> taxi -> ride.
 * A stop, provider handoff, or slower surface fix never moves it backward.
 */
export function preserveDepartureProgress(story: FlightStory, prior?: FlightResume): FlightStory {
  const current = story.currentStage;

  // Airborne/arrival states always outrank departure history.
  if (["ride", "arrival", "final_approach", "taxi_in", "gate"].includes(current)) return story;

  // Only carry a departure checkpoint when it belongs to this same route.
  const sameLeg = Boolean(prior
    && prior.originIcao === story.origin?.icao
    && prior.destIcao === story.dest?.icao);
  const priorStage = sameLeg ? prior?.departureStage ?? null : null;
  let stage = current;

  // Confirmed taxi is irreversible for this dated flight instance. Pushback is
  // no longer an available state after taxi has ever been established.
  if (priorStage === "taxi" && (current === "origin_gate" || current === "push" || current === "inbound")) {
    stage = "taxi";
  } else if (priorStage === "push" && (current === "origin_gate" || current === "inbound")) {
    stage = "push";
  }

  const live = story.aircraft;
  const freshSurface = Boolean(live?.onGround && !live.extrapolated && (live.seenSec ?? 999) <= 30
    && Number.isFinite(live?.lat) && Number.isFinite(live?.lon));
  const gsKt = live?.gsKt ?? 0;

  // Remember the actual stand position while the airplane is still confirmed at
  // the gate. This lets a later stationary FR24/ADS-B fix prove pushback by
  // displacement instead of waiting for taxi speed.
  let parkedLat = sameLeg ? prior?.parkedLat ?? null : null;
  let parkedLon = sameLeg ? prior?.parkedLon ?? null : null;
  if (freshSurface && stage === "origin_gate" && parkedLat == null && parkedLon == null) {
    parkedLat = live!.lat;
    parkedLon = live!.lon;
  }
  const displacedNm = freshSurface && parkedLat != null && parkedLon != null
    ? haversineNm({ lat: parkedLat, lon: parkedLon }, { lat: live!.lat, lon: live!.lon })
    : 0;

  // Pushback is primarily a left-the-stand event. A fresh surface position more
  // than ~28 m from the recorded stand is enough even if the airplane is stopped.
  // If the first trustworthy observation is already clearly taxiing, skip the
  // visible push dwell and advance directly to taxi while still latching progress.
  if (freshSurface && stage === "origin_gate") {
    if (gsKt >= 8 || displacedNm >= 0.08) stage = "taxi";
    else if (displacedNm >= 0.015 || gsKt >= 2) stage = "push";
  }

  // Once pushback has been established, normal taxi movement or meaningful
  // additional displacement advances to taxi. Stops after that remain taxi.
  if (freshSurface && stage === "push") {
    if (current === "taxi" || gsKt >= 5 || displacedNm >= 0.06) stage = "taxi";
  }

  const durableStage = stage === "taxi" ? "taxi" : stage === "push" ? "push" : priorStage;
  const resume = story.resume
    ? {
        ...story.resume,
        ...(durableStage ? { departureStage: durableStage } : {}),
        ...(parkedLat != null && parkedLon != null ? { parkedLat, parkedLon } : {}),
      }
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

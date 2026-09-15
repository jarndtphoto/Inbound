import { createServerFn } from "@tanstack/react-start";
import { loadFlightStory, loadLiveBoard } from "./story.server";
import { readFlightResume, type FlightResume } from "./flight-resume";
import { haversineNm } from "./geo";
import { identityCompatible, normalizedToLive, positionAgeSec, type NormalizedPosition } from "./flight-data";
import type { FlightStory } from "./types";

const DEPARTURE_SURFACE_STAGES = new Set(["origin_gate", "push", "taxi"]);
const SURFACE_STAGES = new Set(["origin_gate", "push", "taxi", "taxi_in", "gate"]);

function sameResumeLeg(story: FlightStory, prior?: FlightResume) {
  return Boolean(prior && prior.originIcao === story.origin?.icao && prior.destIcao === story.dest?.icao);
}

/**
 * Temporary live experiment: while the aircraft is on the airport surface,
 * FR24 is the only position source allowed to drive the returned aircraft fix
 * and new surface-stage progress. FlightAware operational times remain intact,
 * and normal multi-provider fusion resumes once the airplane is airborne.
 */
export function applyFr24GroundExperiment(story: FlightStory, prior?: FlightResume): FlightStory {
  const providers = story.providers as (Record<string, unknown> | undefined);
  const candidate = providers?.fr24Position as NormalizedPosition | null | undefined;
  const sameLeg = sameResumeLeg(story, prior);
  const expected = {
    callsigns: [story.callsign, story.iata].filter(Boolean),
    registration: sameLeg ? prior?.tail ?? null : null,
    hex: sameLeg ? prior?.hex ?? null : null,
  };
  const freshFrGround = Boolean(candidate
    && candidate.provider === "fr24"
    && candidate.onGround === true
    && positionAgeSec(candidate) <= 45
    && identityCompatible(candidate, expected));

  if (freshFrGround && candidate) {
    const age = positionAgeSec(candidate);
    return {
      ...story,
      live: true,
      aircraft: normalizedToLive(candidate),
      providers: {
        ...story.providers,
        chosenPosition: "fr24",
        chosenPositionSeenAt: candidate.seenAt,
        chosenPositionAgeSec: age,
      },
    };
  }

  // If the server returned a non-FR24 ground position, suppress it for this
  // experiment. On departure, do not accept a brand-new push/taxi advancement
  // from that position; hold the last durable checkpoint until FR24 confirms it.
  if (story.aircraft?.onGround === true && story.providers?.chosenPosition !== "fr24") {
    let stage = story.currentStage;
    const priorStage = sameLeg ? prior?.departureStage ?? null : null;
    if (DEPARTURE_SURFACE_STAGES.has(stage)) {
      if (priorStage === "taxi") stage = "taxi";
      else if (priorStage === "push") stage = "push";
      else if (stage === "push" || stage === "taxi") stage = "origin_gate";
    }
    return {
      ...story,
      live: false,
      aircraft: null,
      currentStage: stage,
      providers: {
        ...story.providers,
        chosenPosition: null,
        chosenPositionSeenAt: null,
        chosenPositionAgeSec: null,
      },
    };
  }

  // Surface stages without a ground aircraft fix can remain operationally valid
  // (for example a provider actual gate-in). We only remove non-FR24 position
  // evidence; we do not rewrite provider actual times.
  if (SURFACE_STAGES.has(story.currentStage) && story.aircraft?.onGround !== false && !freshFrGround) {
    return story;
  }

  return story;
}

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
  const sameLeg = sameResumeLeg(story, prior);
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
  const freshSurface = Boolean(live?.onGround && story.providers?.chosenPosition === "fr24"
    && !live.extrapolated && (live.seenSec ?? 999) <= 45
    && Number.isFinite(live?.lat) && Number.isFinite(live?.lon));
  const gsKt = live?.gsKt ?? 0;

  // During the FR24-only ground experiment, the stand reference is learned only
  // from a fresh FR24 fix. This prevents public ADS-B/FlightAware surface jitter
  // from creating Pushback or Taxiing out.
  let parkedLat = sameLeg ? prior?.parkedLat ?? null : null;
  let parkedLon = sameLeg ? prior?.parkedLon ?? null : null;
  if (freshSurface && stage === "origin_gate" && parkedLat == null && parkedLon == null) {
    parkedLat = live!.lat;
    parkedLon = live!.lon;
  }
  const displacedNm = freshSurface && parkedLat != null && parkedLon != null
    ? haversineNm({ lat: parkedLat, lon: parkedLon }, { lat: live!.lat, lon: live!.lon })
    : 0;

  // Pushback is primarily a left-the-stand event. A fresh FR24 surface position
  // more than ~28 m from the recorded stand is enough even if the airplane stops.
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
    const experimental = applyFr24GroundExperiment(story, data.resume);
    return preserveDepartureProgress(experimental, data.resume);
  });

export const listLiveFlights = createServerFn({ method: "POST" }).handler(async () => loadLiveBoard());

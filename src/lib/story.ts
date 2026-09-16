import { createServerFn } from "@tanstack/react-start";
import { loadFlightStory, loadLiveBoard } from "./story.server";
import { readFlightResume, type FlightResume } from "./flight-resume";
import { haversineNm } from "./geo";
import { identityCompatible, normalizedToLive, positionAgeSec, type NormalizedPosition } from "./flight-data";
import type { FlightStory } from "./types";

const DEPARTURE_SURFACE_STAGES = new Set(["origin_gate", "push", "taxi"]);
const SURFACE_STAGES = new Set(["origin_gate", "push", "taxi", "taxi_in", "gate"]);
const FR24_SURFACE_FRESH_SEC = 20;
const TAKEOFF_ROLL_STAGE = "Takeoff roll";

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
    && positionAgeSec(candidate) <= FR24_SURFACE_FRESH_SEC
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

  if (story.aircraft?.onGround === true && story.providers?.chosenPosition !== "fr24") {
    let stage = story.currentStage;
    const priorStage = sameLeg ? prior?.departureStage ?? null : null;
    if (DEPARTURE_SURFACE_STAGES.has(stage)) {
      if (priorStage === "takeoff_roll") stage = "taxi";
      else if (priorStage === "taxi") stage = "taxi";
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

  if (SURFACE_STAGES.has(story.currentStage) && story.aircraft?.onGround !== false && !freshFrGround) {
    return story;
  }

  return story;
}

/**
 * Preserve confirmed departure progress across refreshes/serverless handoffs.
 * Departure is a one-way passenger story:
 * origin_gate -> push -> taxi -> takeoff roll -> ride.
 * A stop, provider handoff, or slower surface fix never moves it backward.
 */
export function preserveDepartureProgress(story: FlightStory, prior?: FlightResume): FlightStory {
  const current = story.currentStage;
  const sameLeg = sameResumeLeg(story, prior);
  const priorStage = sameLeg ? prior?.departureStage ?? null : null;
  const live = story.aircraft;
  const gsKt = live?.gsKt ?? 0;

  // Hard departure gates requested for the passenger story. Once Taxiing out is
  // established, 50 kt means Takeoff roll. Once Takeoff roll is latched, keep it
  // through any brief speed fluctuation until 150 kt, then hand off to the existing
  // Flight stage. Flights first observed already airborne still use the existing
  // FlightAware/live airborne logic so we do not regress the accurate Flight state.
  if (priorStage === "takeoff_roll") {
    if (gsKt >= 150) {
      const resume = story.resume ? { ...story.resume, departureStage: "takeoff_roll" as const } : story.resume;
      return { ...story, currentStage: "ride", ...(resume ? { resume } : {}) };
    }
    const resume = story.resume ? { ...story.resume, departureStage: "takeoff_roll" as const } : story.resume;
    return { ...story, currentStage: TAKEOFF_ROLL_STAGE as FlightStory["currentStage"], ...(resume ? { resume } : {}) };
  }

  if (priorStage === "taxi" && gsKt >= 50 && gsKt < 150) {
    const resume = story.resume ? { ...story.resume, departureStage: "takeoff_roll" as const } : story.resume;
    return { ...story, currentStage: TAKEOFF_ROLL_STAGE as FlightStory["currentStage"], ...(resume ? { resume } : {}) };
  }

  if (priorStage === "taxi" && gsKt >= 150) {
    return { ...story, currentStage: "ride" };
  }

  if (["ride", "arrival", "final_approach", "taxi_in", "gate"].includes(current)) return story;

  let stage = current;

  if (priorStage === "taxi" && (current === "origin_gate" || current === "push" || current === "inbound")) {
    stage = "taxi";
  } else if (priorStage === "push" && (current === "origin_gate" || current === "inbound")) {
    stage = "push";
  }

  // A provider-published actual gate-out/pushback time is itself authoritative
  // evidence that the airplane is no longer at the gate. Never continue showing
  // At the gate after we have accepted that timestamp as an actual.
  const providerPushConfirmed = story.times.pushSource === "provider_actual" || story.times.pushKind === "actual";
  if (providerPushConfirmed && (stage === "origin_gate" || stage === "inbound")) {
    stage = "push";
  }

  const freshSurface = Boolean(live?.onGround && story.providers?.chosenPosition === "fr24"
    && !live.extrapolated && (live.seenSec ?? 999) <= FR24_SURFACE_FRESH_SEC
    && Number.isFinite(live?.lat) && Number.isFinite(live?.lon));

  let parkedLat = sameLeg ? prior?.parkedLat ?? null : null;
  let parkedLon = sameLeg ? prior?.parkedLon ?? null : null;
  if (freshSurface && stage === "origin_gate" && parkedLat == null && parkedLon == null) {
    parkedLat = live!.lat;
    parkedLon = live!.lon;
  }
  const displacedNm = freshSurface && parkedLat != null && parkedLon != null
    ? haversineNm({ lat: parkedLat, lon: parkedLon }, { lat: live!.lat, lon: live!.lon })
    : 0;

  // Make pushback responsive to the first real movement away from the stand.
  // ~0.006 nm is about 11 m; a slow 1 kt tug movement is also sufficient.
  if (freshSurface && stage === "origin_gate") {
    if (gsKt >= 3 || displacedNm >= 0.025) stage = "taxi";
    else if (displacedNm >= 0.006 || gsKt >= 1) stage = "push";
  }

  // Once pushback is established, promote to taxi much sooner. This avoids
  // holding Pushback through a long taxi or until the aircraft reaches the runway.
  if (freshSurface && stage === "push") {
    if (current === "taxi" || gsKt >= 3 || displacedNm >= 0.025) stage = "taxi";
  }

  // If this response itself establishes Taxiing out at or above 50 kt, do not
  // wait another refresh to show Takeoff roll.
  let hardStage: typeof stage | typeof TAKEOFF_ROLL_STAGE = stage;
  if (stage === "taxi" && gsKt >= 50) hardStage = TAKEOFF_ROLL_STAGE;

  const durableStage = hardStage === TAKEOFF_ROLL_STAGE
    ? "takeoff_roll"
    : hardStage === "taxi"
      ? "taxi"
      : hardStage === "push"
        ? "push"
        : priorStage;
  const resume = story.resume
    ? {
        ...story.resume,
        ...(durableStage ? { departureStage: durableStage } : {}),
        ...(parkedLat != null && parkedLon != null ? { parkedLat, parkedLon } : {}),
      }
    : story.resume;

  if (hardStage === TAKEOFF_ROLL_STAGE && gsKt >= 150) {
    return { ...story, currentStage: "ride", ...(resume ? { resume } : {}) };
  }

  return hardStage === current && resume === story.resume
    ? story
    : { ...story, currentStage: hardStage as FlightStory["currentStage"], resume };
}

/**
 * If the first live observation catches an airplane already taxiing, do not stamp
 * that load time as "pushback detected." We did not observe the airplane leave
 * the stand, so keep the scheduled gate-out time and report the exact pushback
 * time as unknown. A provider actual timestamp remains authoritative.
 */
export function suppressLateJoinDetectedPush(story: FlightStory, prior?: FlightResume): FlightStory {
  if (sameResumeLeg(story, prior)) return story;
  const live = story.aircraft;
  const t = story.times;
  const detected = t.pushSource === "live_detected" || t.pushSource === "track_detected";
  const pushUnix = t.pushUnix ?? null;
  const loadedUnix = story.fetchedAt / 1000;
  const looksLikeLoadTime = pushUnix != null && Math.abs(loadedUnix - pushUnix) <= 120;
  const joinedMoving = Boolean(
    live?.onGround
    && story.providers?.chosenPosition === "fr24"
    && !live.extrapolated
    && (live.seenSec ?? 999) <= FR24_SURFACE_FRESH_SEC
    && (live.gsKt ?? 0) >= 8
    && (story.currentStage === "taxi" || story.currentStage === (TAKEOFF_ROLL_STAGE as FlightStory["currentStage"]))
  );
  if (!detected || !looksLikeLoadTime || !joinedMoving || t.origPushUnix == null) return story;

  return {
    ...story,
    times: {
      ...t,
      push: t.pushWas ?? t.push,
      pushUnix: t.origPushUnix,
      pushKind: "scheduled",
      pushSource: null,
      pushWas: null,
      delayMin: 0,
    },
  };
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
    const progressed = preserveDepartureProgress(experimental, data.resume);
    return suppressLateJoinDetectedPush(progressed, data.resume);
  });

export const listLiveFlights = createServerFn({ method: "POST" }).handler(async () => loadLiveBoard());

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
        surfaceTelemetryStale: false,
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
        surfaceTelemetryStale: true,
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
 * Passenger departure is monotonic except that a rejected takeoff may fall from
 * Takeoff roll back to Taxiing out while FR24 still reports on-ground.
 */
export function preserveDepartureProgress(story: FlightStory, prior?: FlightResume): FlightStory {
  const current = story.currentStage;
  const sameLeg = sameResumeLeg(story, prior);
  const priorStage = sameLeg ? prior?.departureStage ?? null : null;
  const live = story.aircraft;
  const gsKt = live?.gsKt ?? 0;

  // Existing airborne/arrival detection stays authoritative. This preserves the
  // Flight state that has already been accurate from FlightAware/live evidence.
  if (["ride", "arrival", "final_approach", "taxi_in", "gate"].includes(current)) return story;

  const freshSurface = Boolean(live?.onGround && story.providers?.chosenPosition === "fr24"
    && !live.extrapolated && (live.seenSec ?? 999) <= FR24_SURFACE_FRESH_SEC
    && Number.isFinite(live?.lat) && Number.isFinite(live?.lon));
  const nearOrigin = Boolean(
    freshSurface
    && Number.isFinite(story.origin?.lat) && Number.isFinite(story.origin?.lon)
    && haversineNm({ lat: story.origin.lat, lon: story.origin.lon }, { lat: live!.lat, lon: live!.lon }) <= 3
  );
  const resumeBase = story.resume ?? (sameLeg ? prior : undefined);

  // Hard runway rule: once a fresh FR24 surface sample reaches 50 kt near the
  // departure airport, Takeoff roll wins immediately even if an older schedule
  // layer still says Pushback. This removes the pushback-on-runway failure mode.
  if (nearOrigin && gsKt >= 50) {
    // If Takeoff roll was already shown on a previous refresh, 150 kt advances
    // to Flight. If this is the first fast sample (even 150+), show Takeoff roll
    // for at least one refresh so the passenger stage cannot be skipped.
    if (priorStage === "takeoff_roll" && gsKt >= 150) {
      return {
        ...story,
        currentStage: "ride",
        ...(resumeBase ? { resume: { ...resumeBase, departureStage: "takeoff_roll", takeoffRollStreak: 0, takeoffRollStreakSeenAt: null, flightSpeedStreak: 0, flightSpeedStreakSeenAt: null } } : {}),
      };
    }
    return {
      ...story,
      currentStage: TAKEOFF_ROLL_STAGE as FlightStory["currentStage"],
      ...(resumeBase ? { resume: { ...resumeBase, departureStage: "takeoff_roll", takeoffRollStreak: 0, takeoffRollStreakSeenAt: null, flightSpeedStreak: 0, flightSpeedStreakSeenAt: null } } : {}),
    };
  }

  // Rejected takeoff / runway exit: if a previously latched roll drops well below
  // the roll threshold while still on the surface, return to Taxiing out.
  if (priorStage === "takeoff_roll" && freshSurface && gsKt < 35) {
    return {
      ...story,
      currentStage: "taxi",
      ...(resumeBase ? { resume: { ...resumeBase, departureStage: "taxi", takeoffRollStreak: 0, takeoffRollStreakSeenAt: null, flightSpeedStreak: 0, flightSpeedStreakSeenAt: null } } : {}),
    };
  }

  let stage = current;
  if (priorStage === "taxi" && (current === "origin_gate" || current === "push" || current === "inbound")) {
    stage = "taxi";
  } else if (priorStage === "push" && (current === "origin_gate" || current === "inbound")) {
    stage = "push";
  }

  const providerPushConfirmed = story.times.pushSource === "provider_actual" || story.times.pushKind === "actual";
  if (providerPushConfirmed && (stage === "origin_gate" || stage === "inbound")) stage = "push";

  // Any real FR24 ground movement of 3 kt or more means we are at least Taxiing
  // out. Do not require an old parked coordinate to escape Pushback.
  if (nearOrigin && gsKt >= 3 && (stage === "inbound" || stage === "origin_gate" || stage === "push")) {
    stage = "taxi";
  } else if (nearOrigin && gsKt >= 1 && (stage === "inbound" || stage === "origin_gate")) {
    stage = "push";
  }

  let parkedLat = sameLeg ? prior?.parkedLat ?? null : null;
  let parkedLon = sameLeg ? prior?.parkedLon ?? null : null;
  if (freshSurface && stage === "origin_gate" && parkedLat == null && parkedLon == null) {
    parkedLat = live!.lat;
    parkedLon = live!.lon;
  }
  const displacedNm = freshSurface && parkedLat != null && parkedLon != null
    ? haversineNm({ lat: parkedLat, lon: parkedLon }, { lat: live!.lat, lon: live!.lon })
    : 0;

  if (freshSurface && stage === "origin_gate") {
    if (displacedNm >= 0.025) stage = "taxi";
    else if (displacedNm >= 0.006) stage = "push";
  }
  if (freshSurface && stage === "push" && displacedNm >= 0.025) stage = "taxi";

  const durableStage = stage === "taxi" ? "taxi" : stage === "push" ? "push" : priorStage;
  const resume = resumeBase
    ? {
        ...resumeBase,
        ...(durableStage ? { departureStage: durableStage } : {}),
        ...(parkedLat != null && parkedLon != null ? { parkedLat, parkedLon } : {}),
        takeoffRollStreak: 0,
        takeoffRollStreakSeenAt: null,
        flightSpeedStreak: 0,
        flightSpeedStreakSeenAt: null,
      }
    : story.resume;

  return stage === current && resume === story.resume ? story : { ...story, currentStage: stage, resume };
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

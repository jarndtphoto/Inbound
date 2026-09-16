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
 * and new surface-stage progress. During departure we keep accepting fresh FR24
 * telemetry even if FR24 flips on_ground false before the passenger Flight stage,
 * so runway acceleration cannot get stranded at the departure airport.
 */
export function applyFr24GroundExperiment(story: FlightStory, prior?: FlightResume): FlightStory {
  const providers = story.providers as (Record<string, unknown> | undefined);
  const candidate = providers?.fr24Position as NormalizedPosition | null | undefined;
  const sameLeg = sameResumeLeg(story, prior);
  const priorStage = sameLeg ? prior?.departureStage ?? null : null;
  // While the schedule layer still says Inbound, the saved tail/hex can belong to
  // the pre-departure handoff and may be stale after an equipment swap. Do not let
  // that lock reject a fresh FR24 surface fix for the requested flight number.
  // Once departure has begun, resume tail/hex locking normally.
  const lockSavedAircraft = sameLeg && story.currentStage !== "inbound";
  const expected = {
    callsigns: [story.callsign, story.iata].filter(Boolean),
    registration: lockSavedAircraft ? prior?.tail ?? null : null,
    hex: lockSavedAircraft ? prior?.hex ?? null : null,
  };
  const departureContext = DEPARTURE_SURFACE_STAGES.has(story.currentStage)
    || priorStage === "push"
    || priorStage === "taxi"
    || priorStage === "takeoff_roll";
  const freshFrDeparture = Boolean(candidate
    && candidate.provider === "fr24"
    && positionAgeSec(candidate) <= FR24_SURFACE_FRESH_SEC
    && identityCompatible(candidate, expected)
    && (candidate.onGround === true || departureContext));

  if (freshFrDeparture && candidate) {
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
    if (DEPARTURE_SURFACE_STAGES.has(stage)) {
      if (priorStage === "takeoff_roll") stage = "taxi";
      else if (priorStage === "taxi" || priorStage === "push") stage = "taxi";
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

  if (SURFACE_STAGES.has(story.currentStage) && story.aircraft?.onGround !== false && !freshFrDeparture) {
    return story;
  }

  return story;
}

/**
 * Preserve confirmed departure progress across refreshes/serverless handoffs.
 * Passenger departure is intentionally simple and trustworthy:
 * At gate -> Heading to runway -> optional Takeoff roll -> Flight.
 * Internally the existing `taxi` checkpoint represents Heading to runway.
 */
export function preserveDepartureProgress(story: FlightStory, prior?: FlightResume): FlightStory {
  const current = story.currentStage;
  const sameLeg = sameResumeLeg(story, prior);
  const priorStage = sameLeg ? prior?.departureStage ?? null : null;
  const live = story.aircraft;
  const gsKt = live?.gsKt ?? 0;

  // Existing airborne/arrival detection stays authoritative. If Takeoff roll is
  // missed entirely, Heading to runway may transition directly to Flight.
  if (["ride", "arrival", "final_approach", "taxi_in", "gate"].includes(current)) return story;

  // Fresh FR24 departure telemetry remains usable through the runway roll even if
  // FR24 changes on_ground to false before our 150 kt Flight threshold.
  const freshDepartureFr24 = Boolean(live && story.providers?.chosenPosition === "fr24"
    && !live.extrapolated && (live.seenSec ?? 999) <= FR24_SURFACE_FRESH_SEC
    && Number.isFinite(live?.lat) && Number.isFinite(live?.lon));
  const freshSurface = Boolean(freshDepartureFr24 && live?.onGround === true);
  const nearOrigin = Boolean(
    freshDepartureFr24
    && Number.isFinite(story.origin?.lat) && Number.isFinite(story.origin?.lon)
    && haversineNm({ lat: story.origin.lat, lon: story.origin.lon }, { lat: live!.lat, lon: live!.lon }) <= 3
  );
  const resumeBase = story.resume ?? (sameLeg ? prior : undefined);

  // Keep Takeoff roll as a useful bonus stage when FR24 catches runway acceleration.
  if (nearOrigin && gsKt >= 50) {
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

  // Rejected takeoff / runway exit returns to the broad Heading to runway stage.
  if (priorStage === "takeoff_roll" && freshSurface && gsKt < 35) {
    return {
      ...story,
      currentStage: "taxi",
      ...(resumeBase ? { resume: { ...resumeBase, departureStage: "taxi", takeoffRollStreak: 0, takeoffRollStreakSeenAt: null, flightSpeedStreak: 0, flightSpeedStreakSeenAt: null } } : {}),
    };
  }

  let stage = current;

  // Collapse the old Pushback and Taxiing-out passenger phases into one durable
  // Heading-to-runway phase. Any previously confirmed departure movement keeps it.
  if (priorStage === "taxi" || priorStage === "push") {
    if (current === "origin_gate" || current === "push" || current === "taxi" || current === "inbound") stage = "taxi";
  }
  if (stage === "push") stage = "taxi";

  // Provider actual gate-out is trustworthy evidence that the aircraft has left
  // the stand, but the timestamp remains separate from the passenger stage.
  const providerPushConfirmed = story.times.pushSource === "provider_actual" || story.times.pushKind === "actual";
  if (providerPushConfirmed && (stage === "origin_gate" || stage === "inbound")) stage = "taxi";

  // Fresh FR24 movement near the origin is enough to enter Heading to runway.
  // Once entered, stops and holds do not regress the stage.
  if (nearOrigin && gsKt >= 1 && (stage === "inbound" || stage === "origin_gate" || stage === "push")) {
    stage = "taxi";
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

  // About 11 m of displacement from the stand is enough to say the aircraft is
  // heading to the runway; we no longer try to distinguish tug pushback from taxi.
  if (freshSurface && stage === "origin_gate" && displacedNm >= 0.006) stage = "taxi";

  const durableStage = stage === "taxi" ? "taxi" : priorStage === "takeoff_roll" ? "takeoff_roll" : null;
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
 * Do not invent an exact pushback time if the first trustworthy movement we saw
 * was already taxi-speed movement. Pushback time remains independent from the
 * broad Heading-to-runway passenger stage. Provider actual gate-out still wins.
 */
export function suppressLateJoinDetectedPush(story: FlightStory, prior?: FlightResume): FlightStory {
  const sameLeg = sameResumeLeg(story, prior);
  const priorStage = sameLeg ? prior?.departureStage ?? null : null;
  if (priorStage === "push" || priorStage === "taxi" || priorStage === "takeoff_roll") return story;

  const live = story.aircraft;
  const t = story.times;
  const detected = t.pushSource === "live_detected" || t.pushSource === "track_detected";
  const pushUnix = t.pushUnix ?? null;
  const loadedUnix = story.fetchedAt / 1000;
  const looksLikeRecentDetection = pushUnix != null && Math.abs(loadedUnix - pushUnix) <= 120;
  const firstSeenAlreadyMoving = Boolean(
    live?.onGround
    && story.providers?.chosenPosition === "fr24"
    && !live.extrapolated
    && (live.seenSec ?? 999) <= FR24_SURFACE_FRESH_SEC
    && (live.gsKt ?? 0) >= 3
    && (story.currentStage === "taxi" || story.currentStage === (TAKEOFF_ROLL_STAGE as FlightStory["currentStage"]))
  );
  if (!detected || !looksLikeRecentDetection || !firstSeenAlreadyMoving || t.origPushUnix == null) return story;

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
    ...(story.resume ? { resume: { ...story.resume, detectedPushUnix: null } } : {}),
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

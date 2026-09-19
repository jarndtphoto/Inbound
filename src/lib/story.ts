import { createServerFn } from "@tanstack/react-start";
import { loadFlightStory, loadLiveBoard } from "./story.server";
import { readFlightResume, type FlightResume } from "./flight-resume";
import { haversineNm } from "./geo";
import { identityCompatible, normalizedToLive, positionAgeSec, type NormalizedPosition } from "./flight-data";
import type { FlightStory } from "./types";

const DEPARTURE_SURFACE_STAGES = new Set(["origin_gate", "push", "taxi"]);
const SURFACE_STAGES = new Set(["origin_gate", "push", "taxi", "taxi_in", "gate"]);
const FR24_SURFACE_FRESH_SEC = 30;
const ALT_SURFACE_FRESH_SEC = 120;
const TAKEOFF_ROLL_STAGE = "Takeoff roll";

function sameResumeLeg(story: FlightStory, prior?: FlightResume) {
  return Boolean(prior && prior.originIcao === story.origin?.icao && prior.destIcao === story.dest?.icao);
}

export function applyFr24GroundExperiment(story: FlightStory, prior?: FlightResume): FlightStory {
  const providers = story.providers as (Record<string, unknown> | undefined);
  const candidate = providers?.fr24Position as NormalizedPosition | null | undefined;
  const sameLeg = sameResumeLeg(story, prior);
  const priorStage = sameLeg ? prior?.departureStage ?? null : null;
  const departureConfirmed = priorStage === "push" || priorStage === "taxi" || priorStage === "takeoff_roll";
  const lockSavedAircraft = sameLeg && departureConfirmed;
  const expected = {
    callsigns: [story.callsign, story.iata].filter(Boolean),
    registration: lockSavedAircraft ? prior?.tail ?? null : null,
    hex: lockSavedAircraft ? prior?.hex ?? null : null,
  };
  const departureContext = DEPARTURE_SURFACE_STAGES.has(story.currentStage)
    || priorStage === "push" || priorStage === "taxi" || priorStage === "takeoff_roll";
  const freshFrDeparture = Boolean(candidate
    && candidate.provider === "fr24"
    && positionAgeSec(candidate) <= FR24_SURFACE_FRESH_SEC
    && identityCompatible(candidate, expected)
    && (candidate.onGround === true || departureContext));

  if (freshFrDeparture && candidate) {
    const age = positionAgeSec(candidate);
    return { ...story, live: true, aircraft: normalizedToLive(candidate), providers: {
      ...story.providers, chosenPosition: "fr24", chosenPositionSeenAt: candidate.seenAt,
      chosenPositionAgeSec: age, surfaceTelemetryStale: false,
    }};
  }

  if (story.aircraft?.onGround === true && story.providers?.chosenPosition !== "fr24") {
    const alternate = story.aircraft;
    const alternateAge = typeof story.providers?.chosenPositionAgeSec === "number"
      ? story.providers.chosenPositionAgeSec
      : alternate.seenSec ?? Infinity;
    const nearOrigin = Number.isFinite(alternate.lat) && Number.isFinite(alternate.lon)
      ? haversineNm({ lat: story.origin.lat, lon: story.origin.lon }, { lat: alternate.lat, lon: alternate.lon }) <= 6
      : false;
    const nearDest = Number.isFinite(alternate.lat) && Number.isFinite(alternate.lon)
      ? haversineNm({ lat: story.dest.lat, lon: story.dest.lon }, { lat: alternate.lat, lon: alternate.lon }) <= 6
      : false;
    if (alternateAge <= ALT_SURFACE_FRESH_SEC && (nearOrigin || nearDest)) {
      return { ...story, live: true, providers: {
        ...story.providers,
        chosenPositionAgeSec: alternateAge,
        surfaceTelemetryStale: true,
      }};
    }

    let stage = story.currentStage;
    if (DEPARTURE_SURFACE_STAGES.has(stage)) {
      if (priorStage === "takeoff_roll") stage = "taxi";
      else if (priorStage === "taxi" || priorStage === "push") stage = "taxi";
      else if (stage === "push" || stage === "taxi") stage = "origin_gate";
    }
    return { ...story, live: false, aircraft: null, currentStage: stage, providers: {
      ...story.providers, chosenPosition: null, chosenPositionSeenAt: null,
      chosenPositionAgeSec: null, surfaceTelemetryStale: true,
    }};
  }
  if (SURFACE_STAGES.has(story.currentStage) && story.aircraft?.onGround !== false && !freshFrDeparture) return story;
  return story;
}

export function preserveDepartureProgress(story: FlightStory, prior?: FlightResume): FlightStory {
  const current = story.currentStage;
  const sameLeg = sameResumeLeg(story, prior);
  const priorStage = sameLeg ? prior?.departureStage ?? null : null;
  const live = story.aircraft;
  const gsKt = live?.gsKt ?? 0;
  if (["ride", "arrival", "final_approach", "taxi_in", "gate"].includes(current)) return story;

  const chosenProvider = typeof story.providers?.chosenPosition === "string" ? story.providers.chosenPosition : null;
  const chosenAge = typeof story.providers?.chosenPositionAgeSec === "number"
    ? story.providers.chosenPositionAgeSec
    : live?.seenSec ?? Infinity;
  const allowedSurfaceAge = chosenProvider === "fr24" ? FR24_SURFACE_FRESH_SEC : ALT_SURFACE_FRESH_SEC;
  const freshDeparturePosition = Boolean(live
    && !live.extrapolated
    && chosenAge <= allowedSurfaceAge
    && Number.isFinite(live.lat)
    && Number.isFinite(live.lon));
  const freshSurface = Boolean(freshDeparturePosition && live?.onGround === true);
  const nearOrigin = Boolean(freshDeparturePosition
    && Number.isFinite(story.origin?.lat) && Number.isFinite(story.origin?.lon)
    && haversineNm({ lat: story.origin.lat, lon: story.origin.lon }, { lat: live!.lat, lon: live!.lon }) <= 3);
  const resumeBase = story.resume ?? (sameLeg ? prior : undefined);

  if (nearOrigin && gsKt >= 50) {
    if (priorStage === "takeoff_roll" && gsKt >= 150) {
      return { ...story, currentStage: "ride", ...(resumeBase ? { resume: { ...resumeBase,
        departureStage: "takeoff_roll", takeoffRollStreak: 0, takeoffRollStreakSeenAt: null,
        flightSpeedStreak: 0, flightSpeedStreakSeenAt: null } } : {}) };
    }
    return { ...story, currentStage: TAKEOFF_ROLL_STAGE as FlightStory["currentStage"],
      ...(resumeBase ? { resume: { ...resumeBase, departureStage: "takeoff_roll",
        takeoffRollStreak: 0, takeoffRollStreakSeenAt: null, flightSpeedStreak: 0,
        flightSpeedStreakSeenAt: null } } : {}) };
  }

  if (priorStage === "takeoff_roll" && freshSurface && gsKt < 35) {
    return { ...story, currentStage: "taxi", ...(resumeBase ? { resume: { ...resumeBase,
      departureStage: "taxi", takeoffRollStreak: 0, takeoffRollStreakSeenAt: null,
      flightSpeedStreak: 0, flightSpeedStreakSeenAt: null } } : {}) };
  }

  if (priorStage === "takeoff_roll" && !freshSurface) {
    return { ...story, currentStage: TAKEOFF_ROLL_STAGE as FlightStory["currentStage"],
      ...(resumeBase ? { resume: { ...resumeBase, departureStage: "takeoff_roll" } } : {}) };
  }

  let stage = current;
  // Keep departure progression consistent with the server rule:
  // first validated movement is Pushback; Taxi starts only once a fresh
  // on-ground fix reaches 6 kt. Once Taxi has been observed, it remains durable.
  if (priorStage === "taxi") {
    if (current === "origin_gate" || current === "push" || current === "taxi" || current === "inbound") stage = "taxi";
  } else if (priorStage === "push") {
    if (current === "origin_gate" || current === "push" || current === "inbound") stage = "push";
  }

  const providerPushConfirmed = story.times.pushSource === "provider_actual" || story.times.pushKind === "actual";
  if (providerPushConfirmed && (stage === "origin_gate" || stage === "inbound")) stage = "push";

  if (freshSurface && nearOrigin && gsKt >= 6 && (stage === "inbound" || stage === "origin_gate" || stage === "push" || stage === "taxi")) {
    stage = "taxi";
  } else if (freshSurface && nearOrigin && gsKt >= 1 && (stage === "inbound" || stage === "origin_gate")) {
    stage = "push";
  }

  let parkedLat = sameLeg ? prior?.parkedLat ?? null : null;
  let parkedLon = sameLeg ? prior?.parkedLon ?? null : null;
  if (freshSurface && stage === "origin_gate" && parkedLat == null && parkedLon == null) {
    parkedLat = live!.lat; parkedLon = live!.lon;
  }
  const displacedNm = freshSurface && parkedLat != null && parkedLon != null
    ? haversineNm({ lat: parkedLat, lon: parkedLon }, { lat: live!.lat, lon: live!.lon }) : 0;
  if (freshSurface && (stage === "origin_gate" || stage === "inbound") && displacedNm >= 0.006) stage = "push";

  const durableStage = stage === "taxi"
    ? "taxi"
    : stage === "push" || priorStage === "push"
      ? "push"
      : priorStage === "takeoff_roll"
        ? "takeoff_roll"
        : null;
  const resume = resumeBase ? { ...resumeBase,
    ...(durableStage ? { departureStage: durableStage } : {}),
    ...(parkedLat != null && parkedLon != null ? { parkedLat, parkedLon } : {}),
    takeoffRollStreak: 0, takeoffRollStreakSeenAt: null, flightSpeedStreak: 0,
    flightSpeedStreakSeenAt: null,
  } : story.resume;
  return stage === current && resume === story.resume ? story : { ...story, currentStage: stage, resume };
}

export function preferFreshAirborneState(story: FlightStory): FlightStory {
  const ac = story.aircraft;
  if (!ac || !Number.isFinite(ac.lat) || !Number.isFinite(ac.lon) || ac.onGround !== false) return story;
  const age = typeof story.providers?.chosenPositionAgeSec === "number" ? story.providers.chosenPositionAgeSec : ac.seenSec ?? null;
  if (age != null && age > 30) return story;
  const altFt = typeof ac.altFt === "number" && Number.isFinite(ac.altFt) ? ac.altFt : null;
  const gsKt = typeof ac.gsKt === "number" && Number.isFinite(ac.gsKt) ? ac.gsKt : null;
  const originNm = Number.isFinite(story.origin?.lat) && Number.isFinite(story.origin?.lon)
    ? haversineNm({ lat: story.origin.lat, lon: story.origin.lon }, { lat: ac.lat, lon: ac.lon })
    : 999;
  const clearlyAirborne = (altFt != null && altFt >= 1200) || (gsKt != null && gsKt >= 165) || originNm >= 4;
  if (!clearlyAirborne) return story;
  const staleDepartureStage = ["inbound", "origin_gate", "push", "taxi"].includes(String(story.currentStage))
    || String(story.currentStage) === TAKEOFF_ROLL_STAGE;
  if (!staleDepartureStage && story.times.airborne === true) return story;
  return {
    ...story,
    currentStage: staleDepartureStage ? "ride" : story.currentStage,
    times: { ...story.times, airborne: true },
  };
}

export function sanitizeDetectedPushTime(story: FlightStory): FlightStory {
  const t = story.times;
  const detected = t.pushSource === "live_detected" || t.pushSource === "track_detected";
  if (!detected || t.pushUnix == null) return story;
  const scheduled = t.origPushUnix ?? null;
  const now = story.fetchedAt / 1000;
  const tooEarlyForLeg = scheduled != null && t.pushUnix < scheduled - 60 * 60;
  const impossibleFuture = t.pushUnix > now + 5 * 60;
  if (!tooEarlyForLeg && !impossibleFuture) return story;
  return {
    ...story,
    times: {
      ...t,
      push: t.pushWas ?? (scheduled != null ? new Intl.DateTimeFormat("en-US", {
        timeZone: story.origin.tz, hour: "numeric", minute: "2-digit", timeZoneName: "short",
      }).format(scheduled * 1000) : t.push),
      pushUnix: scheduled,
      pushKind: scheduled != null ? "scheduled" : t.pushKind,
      pushSource: null,
      pushWas: null,
      delayMin: scheduled != null ? 0 : t.delayMin,
    },
    ...(story.resume ? { resume: { ...story.resume, detectedPushUnix: null } } : {}),
  };
}

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
  const firstSeenAlreadyMoving = Boolean(live?.onGround
    && story.providers?.chosenPosition === "fr24" && !live.extrapolated
    && (live.seenSec ?? 999) <= FR24_SURFACE_FRESH_SEC && (live.gsKt ?? 0) >= 3
    && (story.currentStage === "taxi" || story.currentStage === (TAKEOFF_ROLL_STAGE as FlightStory["currentStage"])));
  if (!detected || !looksLikeRecentDetection || !firstSeenAlreadyMoving || t.origPushUnix == null) return story;
  return { ...story, times: { ...t, push: t.pushWas ?? t.push, pushUnix: t.origPushUnix,
    pushKind: "scheduled", pushSource: null, pushWas: null, delayMin: 0 },
    ...(story.resume ? { resume: { ...story.resume, detectedPushUnix: null } } : {}) };
}

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
    const airborne = preferFreshAirborneState(progressed);
    const sanitized = sanitizeDetectedPushTime(airborne);
    return suppressLateJoinDetectedPush(sanitized, data.resume);
  });

export const listLiveFlights = createServerFn({ method: "POST" }).handler(async () => loadLiveBoard());

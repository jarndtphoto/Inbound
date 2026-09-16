import { createServerFn } from "@tanstack/react-start";
import { loadFlightStory, loadLiveBoard } from "./story.server";
import { readFlightResume, type FlightResume } from "./flight-resume";
import { haversineNm } from "./geo";
import { identityCompatible, normalizedToLive, positionAgeSec, type NormalizedPosition } from "./flight-data";
import type { FlightStory } from "./types";

const DEPARTURE_SURFACE_STAGES = new Set(["origin_gate", "push", "taxi"]);
const SURFACE_STAGES = new Set(["origin_gate", "push", "taxi", "taxi_in", "gate"]);
const FR24_SURFACE_FRESH_SEC = 20;
const SURFACE_POLL_SEC = 3;
const SPEED_STREAK_TIMEOUT_SEC = SURFACE_POLL_SEC * 2;
const SPEED_CONFIRM_SAMPLES = 2;
const TAKEOFF_ROLL_STAGE = "Takeoff roll";

function sameResumeLeg(story: FlightStory, prior?: FlightResume) {
  return Boolean(prior && prior.originIcao === story.origin?.icao && prior.destIcao === story.dest?.icao);
}

function streakState(
  count: number | null | undefined,
  lastSeenAt: number | null | undefined,
  sample: { seenAt: number; ageSec: number; gsKt: number } | null,
  thresholdKt: number,
  nowSec = Date.now() / 1000,
) {
  let nextCount = Math.max(0, Math.min(SPEED_CONFIRM_SAMPLES, count ?? 0));
  let nextSeenAt = lastSeenAt ?? null;
  let stale = false;

  // Claude's pause-not-reset rule: a missed/late poll does not immediately
  // destroy a half-confirmed transition. Keep the streak alive for up to 2x
  // the expected surface polling interval, then reset and mark telemetry stale.
  if (nextSeenAt != null && nowSec - nextSeenAt > SPEED_STREAK_TIMEOUT_SEC) {
    nextCount = 0;
    nextSeenAt = null;
    stale = true;
  }

  const fresh = Boolean(sample && sample.ageSec <= SPEED_STREAK_TIMEOUT_SEC);
  if (!fresh || !sample) return { count: nextCount, lastSeenAt: nextSeenAt, stale };

  // Repeated requests can return the same FR24 sample. Count only a genuinely
  // newer telemetry point so one cached 52 kt fix cannot satisfy both samples.
  if (nextSeenAt != null && sample.seenAt <= nextSeenAt) {
    return { count: nextCount, lastSeenAt: nextSeenAt, stale: false };
  }

  nextSeenAt = sample.seenAt;
  nextCount = sample.gsKt >= thresholdKt ? Math.min(SPEED_CONFIRM_SAMPLES, nextCount + 1) : 0;
  return { count: nextCount, lastSeenAt: nextSeenAt, stale: false };
}

function withTelemetryFlag(story: FlightStory, stale: boolean): FlightStory {
  return {
    ...story,
    providers: {
      ...story.providers,
      surfaceTelemetryStale: stale,
    },
  };
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
 */
export function preserveDepartureProgress(story: FlightStory, prior?: FlightResume): FlightStory {
  const current = story.currentStage;
  const sameLeg = sameResumeLeg(story, prior);
  const priorStage = sameLeg ? prior?.departureStage ?? null : null;
  const live = story.aircraft;
  const gsKt = live?.gsKt ?? 0;

  // Keep the existing airborne/arrival detection authoritative. FlightAware/live
  // airborne evidence has been reliable and should not be delayed by speed streaks.
  if (["ride", "arrival", "final_approach", "taxi_in", "gate"].includes(current)) return story;

  const providers = story.providers as (Record<string, unknown> | undefined);
  const fr24 = providers?.fr24Position as NormalizedPosition | null | undefined;
  const speedSample = fr24
    && fr24.provider === "fr24"
    && fr24.onGround === true
    && story.providers?.chosenPosition === "fr24"
    ? { seenAt: fr24.seenAt, ageSec: positionAgeSec(fr24), gsKt: fr24.gsKt ?? 0 }
    : null;
  const resumeBase = story.resume ?? (sameLeg ? prior : undefined);

  // A confirmed Takeoff roll stays visible until Flight is confirmed. The 150 kt
  // speed path itself needs two distinct fresh samples; a missing poll pauses the
  // streak for at most 6 seconds, then resets it and marks telemetry stale.
  if (priorStage === "takeoff_roll") {
    const flightStreak = streakState(
      prior?.flightSpeedStreak,
      prior?.flightSpeedStreakSeenAt,
      speedSample,
      150,
    );
    const resume = resumeBase ? {
      ...resumeBase,
      departureStage: "takeoff_roll" as const,
      takeoffRollStreak: 0,
      takeoffRollStreakSeenAt: null,
      flightSpeedStreak: flightStreak.count,
      flightSpeedStreakSeenAt: flightStreak.lastSeenAt,
    } : story.resume;
    if (flightStreak.count >= SPEED_CONFIRM_SAMPLES) {
      return withTelemetryFlag({ ...story, currentStage: "ride", ...(resume ? { resume } : {}) }, false);
    }
    return withTelemetryFlag({
      ...story,
      currentStage: TAKEOFF_ROLL_STAGE as FlightStory["currentStage"],
      ...(resume ? { resume } : {}),
    }, flightStreak.stale);
  }

  let stage = current;

  if (priorStage === "taxi" && (current === "origin_gate" || current === "push" || current === "inbound")) {
    stage = "taxi";
  } else if (priorStage === "push" && (current === "origin_gate" || current === "inbound")) {
    stage = "push";
  }

  // A provider-published actual gate-out/pushback time is itself authoritative
  // evidence that the airplane is no longer at the gate.
  const providerPushConfirmed = story.times.pushSource === "provider_actual" || story.times.pushKind === "actual";
  if (providerPushConfirmed && (stage === "origin_gate" || stage === "inbound")) {
    stage = "push";
  }

  const freshSurface = Boolean(live?.onGround && story.providers?.chosenPosition === "fr24"
    && !live.extrapolated && (live.seenSec ?? 999) <= FR24_SURFACE_FRESH_SEC
    && Number.isFinite(live?.lat) && Number.isFinite(live?.lon));
  const nearOrigin = Boolean(
    freshSurface
    && Number.isFinite(story.origin?.lat) && Number.isFinite(story.origin?.lon)
    && haversineNm({ lat: story.origin.lat, lon: story.origin.lon }, { lat: live!.lat, lon: live!.lon }) <= 3
  );

  if (stage === "inbound" && nearOrigin && gsKt >= 1) {
    stage = gsKt >= 3 ? "taxi" : "push";
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
    if (gsKt >= 3 || displacedNm >= 0.025) stage = "taxi";
    else if (displacedNm >= 0.006 || gsKt >= 1) stage = "push";
  }

  if (freshSurface && stage === "push") {
    if (current === "taxi" || gsKt >= 3 || displacedNm >= 0.025) stage = "taxi";
  }

  // Taxi -> Takeoff roll uses two distinct fresh FR24 samples at >=50 kt.
  // A stale/missed request pauses the half-confirmed streak, but only up to 2x
  // the 3-second surface poll interval. A fresh sub-50 kt sample resets it now.
  const rollStreak = stage === "taxi"
    ? streakState(
        sameLeg ? prior?.takeoffRollStreak : 0,
        sameLeg ? prior?.takeoffRollStreakSeenAt : null,
        speedSample,
        50,
      )
    : { count: 0, lastSeenAt: null as number | null, stale: false };

  let hardStage: typeof stage | typeof TAKEOFF_ROLL_STAGE = stage;
  let flightSpeedStreak = 0;
  let flightSpeedStreakSeenAt: number | null = null;
  if (stage === "taxi" && rollStreak.count >= SPEED_CONFIRM_SAMPLES) {
    hardStage = TAKEOFF_ROLL_STAGE;
    // If the confirming roll sample is already >=150 kt, count it as the first
    // Flight-speed sample, but still show Takeoff roll until a second fresh sample.
    if (speedSample && speedSample.ageSec <= SPEED_STREAK_TIMEOUT_SEC && speedSample.gsKt >= 150) {
      flightSpeedStreak = 1;
      flightSpeedStreakSeenAt = speedSample.seenAt;
    }
  }

  const durableStage = hardStage === TAKEOFF_ROLL_STAGE
    ? "takeoff_roll"
    : hardStage === "taxi"
      ? "taxi"
      : hardStage === "push"
        ? "push"
        : priorStage;
  const resume = resumeBase
    ? {
        ...resumeBase,
        ...(durableStage ? { departureStage: durableStage } : {}),
        ...(parkedLat != null && parkedLon != null ? { parkedLat, parkedLon } : {}),
        takeoffRollStreak: hardStage === TAKEOFF_ROLL_STAGE ? 0 : rollStreak.count,
        takeoffRollStreakSeenAt: hardStage === TAKEOFF_ROLL_STAGE ? null : rollStreak.lastSeenAt,
        flightSpeedStreak,
        flightSpeedStreakSeenAt,
      }
    : story.resume;

  const result = hardStage === current && resume === story.resume
    ? story
    : { ...story, currentStage: hardStage as FlightStory["currentStage"], resume };
  return withTelemetryFlag(result, rollStreak.stale);
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

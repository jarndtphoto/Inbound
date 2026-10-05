import { readTakeoffDiagnostic, takeoffFloorStage } from "./confirmed-takeoff.ts";
import { formatDuration, haversineNm } from "./geo.ts";
import { flightStageId } from "./flight-stage.ts";
import type { FlightStory, StageId } from "./types.ts";

export function displayStage(story: FlightStory): StageId {
  const confirmation = readTakeoffDiagnostic(story.confirmedTakeoff, story.fetchedAt / 1000);
  if (confirmation && story.stateKey) return takeoffFloorStage(story.currentStage, confirmation);
  const ac = story.aircraft;
  const positionAge = story.providers?.chosenPositionAgeSec;
  const freshGroundAtOrigin = Boolean(
    ac &&
    ac.onGround === true &&
    Number.isFinite(ac.lat) &&
    Number.isFinite(ac.lon) &&
    typeof positionAge === "number" &&
    positionAge <= 30 &&
    haversineNm(ac, story.origin) < 12 &&
    story.times?.landKind !== "actual" &&
    story.currentStage !== "taxi_in" &&
    story.currentStage !== "gate"
  );

  // Presentation guard only: never tell the passenger the flight is airborne
  // while a fresh live fix still has the aircraft on the departure airport.
  if (freshGroundAtOrigin && (
    story.currentStage === "ride" ||
    story.currentStage === "arrival" ||
    story.currentStage === "final_approach"
  )) {
    const gsKt = ac?.gsKt ?? 0;
    if (story.times?.pushed && gsKt >= 6) return "taxi";
    if (story.times?.pushed || gsKt >= 2) return "push";
    return "origin_gate";
  }
  return flightStageId(story.currentStage);
}

export function liveFix(story: FlightStory) {
  const ac = story.aircraft;
  return Boolean(story.live && ac && Number.isFinite(ac.lat) && Number.isFinite(ac.lon));
}

export function flightAirborne(story: FlightStory) {
  if (story.stateKey && readTakeoffDiagnostic(story.confirmedTakeoff, story.fetchedAt / 1000)) {
    return !(["taxi_in", "gate"].includes(story.currentStage) || story.times.landKind === "actual"
      || story.arrivalStatus === "landed" || (story.currentStage === "arrival" && story.aircraft?.onGround === true));
  }
  if (story.currentStage === "ride" || story.currentStage === "arrival" || story.currentStage === "final_approach") return true;
  if (
    story.currentStage === "origin_gate" ||
    story.currentStage === "push" ||
    story.currentStage === "taxi" ||
    story.currentStage === "takeoff_roll" ||
    story.currentStage === "inbound" ||
    story.currentStage === "taxi_in" ||
    story.currentStage === "gate"
  ) {
    return false;
  }
  return Boolean(story.times?.airborne);
}

export function elapsedFlight(story: FlightStory) {
  const takeoff = story.times?.takeoffUnix;
  const now = story.fetchedAt / 1000;
  if (!flightAirborne(story)) return null;
  const confirmation = story.stateKey ? readTakeoffDiagnostic(story.confirmedTakeoff, now) : undefined;
  const observed = confirmation?.observedAt ?? (confirmation?.source === "observed_airborne" ? confirmation.confirmedAt : null);
  if (story.times.takeoffKind !== "actual" && observed != null) return {
    minutes: (now - observed) / 60, estimated: true, approximate: true,
  };
  if (takeoff == null || !Number.isFinite(takeoff) || takeoff > now) return null;
  return {
    minutes: (now - takeoff) / 60,
    estimated: story.times?.takeoffKind !== "actual",
    approximate: false,
  };
}

/** Observed track distance never includes the forward projection. Without a
 * track, use a real origin-to-fix distance; a missing fix is not zero flown. */
export function flownDistance(story: FlightStory): { nm: number; source: "track" | "position" } | null {
  if (!flightAirborne(story)) return null;
  const track = story.route.observedFlownNm;
  if (typeof track === "number" && Number.isFinite(track) && track > 0) return { nm: track, source: "track" };
  const ac = story.aircraft;
  if (!liveFix(story) || !ac || ac.onGround || ac.extrapolated
    || !Number.isFinite(story.origin.lat) || !Number.isFinite(story.origin.lon)) return null;
  const distance = haversineNm(story.origin, ac);
  return Number.isFinite(distance) && distance > 0 ? { nm: distance, source: "position" } : null;
}

export type RemainingFlightPresentation = {
  minutes: number | null;
  text: string | null;
  estimated: boolean;
  gapNote: string | null;
};

/** One passenger-facing remaining-time model for every flight screen. */
export function remainingFlight(story: FlightStory, nowMs = Date.now()): RemainingFlightPresentation {
  const now = nowMs / 1000, sinceFetch = Math.max(0, now - story.fetchedAt / 1000);
  const ages = [story.providers?.chosenPositionAgeSec, story.aircraft?.seenSec]
    .filter((age): age is number => typeof age === "number" && Number.isFinite(age) && age >= 0)
    .map(age => age + sinceFetch);
  const seenAt = story.providers?.chosenPositionSeenAt;
  if (typeof seenAt === "number" && Number.isFinite(seenAt) && seenAt > 0 && seenAt <= now) ages.push(now - seenAt);
  const age = ages.length ? Math.min(...ages) : null;
  const fresh = Boolean(liveFix(story) && !story.aircraft?.extrapolated && age != null && age <= 90);
  const gapNote = fresh ? null : age == null ? "No live position" : `No live position · last seen ${Math.max(1, Math.round(age / 60))} min ago`;
  const validEta = (unix: unknown): unix is number => typeof unix === "number" && Number.isFinite(unix) && unix > now && unix < now + 48 * 3600;
  const etas = [story.providers?.providerEta?.fr24, story.providers?.providerEta?.flightaware, story.resume?.landing.estimated,
    story.times.landKind === "estimated" ? story.times.landUnix : null];
  const providerEta = etas.find(validEta);
  const heldProgress = story.route.progressSource === "last_known";
  const serverEta = heldProgress ? story.route.etaMin : story.providers?.etaMin ?? story.route.etaMin;
  const serverRemaining = typeof serverEta === "number" && Number.isFinite(serverEta) && serverEta >= 0
    ? serverEta - sinceFetch / 60 : null;
  // A held observed-progress ETA is stronger than a fallback schedule ETA.
  // This prevents a near-touchdown story from jumping backward to an older
  // estimate when providers briefly fail.
  const minutes = heldProgress && serverRemaining != null && serverRemaining >= 0 ? serverRemaining
    : !fresh && providerEta != null ? (providerEta - now) / 60
    : serverRemaining != null && serverRemaining >= 0 ? serverRemaining : providerEta != null ? (providerEta - now) / 60 : null;
  return { minutes, text: minutes != null ? formatDuration(minutes) : null, estimated: !fresh, gapNote };
}

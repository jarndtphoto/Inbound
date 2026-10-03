import { readTakeoffDiagnostic, takeoffFloorStage } from "./confirmed-takeoff.ts";
import { haversineNm } from "./geo.ts";
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

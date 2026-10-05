import { destPoint, haversineNm, polylineLengthNm, type Coord } from "./geo.ts";
import { runwayCoordinates, type ExpectedArrivalRunway } from "./arrival-runway.ts";

export function arrivalPattern(aircraft: Coord & { track?: number | null }, runway: ExpectedArrivalRunway, heldSide?: number) {
  const end = { ...runway.threshold, ident: runway.runway, heading: runway.heading };
  const here = runwayCoordinates(aircraft, end);
  const headingDelta = aircraft.track == null ? Infinity : Math.abs(((aircraft.track - runway.heading + 540) % 360) - 180);
  const aligned = here.x < 0 && Math.abs(here.y) <= 2 && headingDelta <= 30;
  const project = (x: number, y: number): Coord => destPoint(runway.threshold, runway.heading + Math.atan2(y, x) * 180 / Math.PI, Math.hypot(x, y));
  const faf = project(-9, 0);
  const side = heldSide ?? (here.y < 0 ? -1 : 1);
  let points: Coord[];
  if (aligned) {
    // Do not send an aircraft already inside the FAF back out to it.
    points = here.x < -9 ? [aircraft, faf, runway.threshold] : [aircraft, runway.threshold];
  } else {
    const offset = 5, radius = offset / 2;
    const startX = here.x;
    // A westbound downwind already beyond the nominal FAF must continue
    // outward before base, rather than reverse toward the field.
    const baseX = Math.min(-9, here.x - 1);
    points = [aircraft, project(startX, side * offset), project(baseX, side * offset)];
    // A tangent semicircular base turn joins the downwind to final without a hard corner.
    for (let i = 1; i <= 24; i++) {
      const angle = (90 + i * 180 / 24) * Math.PI / 180;
      points.push(project(baseX + radius * Math.cos(angle), side * (radius + radius * Math.sin(angle))));
    }
    points[points.length - 1] = project(baseX, 0);
    if (baseX < -9) points.push(faf);
    points.push(runway.threshold);
  }
  // Preserve exact entry/threshold points and sample legs at <= 1nm for weather and display.
  const dense: Coord[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const steps = Math.max(1, Math.ceil(haversineNm(a, b)));
    for (let j = 1; j < steps; j++) dense.push({ lat: a.lat + (b.lat - a.lat) * j / steps, lon: a.lon + (b.lon - a.lon) * j / steps });
    dense.push(b);
  }
  return { points: dense, lengthNm: polylineLengthNm(dense), kind: aligned ? "straight-in" as const : "downwind-base" as const, side };
}

export function showDetailedArrivalGeometry(
  live: (Coord & { onGround?: boolean; extrapolated?: boolean; seenSec?: number | null; phase?: string }) | null,
  dest: Coord,
  finalApproachEvidence = false,
) {
  if (!live || live.onGround || live.extrapolated || (live.seenSec ?? Infinity) > 60) return false;
  const distanceNm = haversineNm(live, dest);
  // Keep the filed route visible through cruise/descent. Runway-specific
  // geometry takes over only once the aircraft is actually on approach.
  return distanceNm <= 35 && (live.phase === "approach" || finalApproachEvidence);
}

export function canProjectArrival(live: (Coord & { onGround?: boolean; extrapolated?: boolean; seenSec?: number | null; phase?: string; vertFpm?: number | null; altFt?: number | null }) | null, dest: Coord & { elevationFt?: number | null }, landed: boolean, approachEvidence = false, derivedVertFpm: number | null = null) {
  const elevation = dest.elevationFt ?? 0;
  const altitudeCeiling = Math.max(12_000, elevation + 10_000);
  const knownAltitude = Number.isFinite(live?.altFt);
  const rate = Number.isFinite(live?.vertFpm) ? live!.vertFpm! : derivedVertFpm;
  const altitudeEvidence = !!live && knownAltitude && haversineNm(live, dest) <= 40
    && live.altFt! <= altitudeCeiling && (live.altFt! - elevation < 6_000 || (rate ?? 0) < -300);
  return Boolean(!landed && live && !live.onGround && !live.extrapolated && (live.seenSec ?? Infinity) <= 60 &&
    (!knownAltitude || live.altFt! <= altitudeCeiling) && haversineNm(live, dest) <= 55 &&
    (altitudeEvidence || (live.vertFpm ?? 0) < -100 || live.phase === "descent" || live.phase === "approach" || approachEvidence));
}

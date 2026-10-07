import { haversineNm, nmToMiles, wrap360 } from "../geo";
import { LatitudeSchema, LongitudeSchema, ResolvedAreaV1Schema, type ResolvedAreaV1 } from "./contracts";

export type NearbyCoordinate = { latitude: number; longitude: number };
export function validCoordinate(p: NearbyCoordinate): boolean {
  return LatitudeSchema.safeParse(p.latitude).success && LongitudeSchema.safeParse(p.longitude).success;
}
/**
 * Scoped to the new Nearby view. Existing geo.initialBearing uses sin(lat2)
 * instead of cos(lat2) in x; changing it would alter current flight/map math.
 */
function referenceBearing(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const rad = Math.PI / 180;
  const lat1 = a.lat * rad, lat2 = b.lat * rad, dLon = (b.lon - a.lon) * rad;
  return wrap360(Math.atan2(Math.sin(dLon) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)) / rad);
}
/** Always recompute from the chosen Inbound reference; provider dst/dir are unused. */
export function viewProximity(area: ResolvedAreaV1, position: NearbyCoordinate) {
  ResolvedAreaV1Schema.parse(area);
  if (!validCoordinate(position)) throw new RangeError("Invalid aircraft coordinate");
  const a = { lat: area.reference.latitude, lon: area.reference.longitude };
  const b = { lat: position.latitude, lon: position.longitude };
  return { distanceNm: haversineNm(a, b), bearingDeg: referenceBearing(a, b) };
}
export function cropToView<T extends NearbyCoordinate>(area: ResolvedAreaV1, aircraft: readonly T[]) {
  ResolvedAreaV1Schema.parse(area);
  return aircraft.flatMap(a => {
    if (!validCoordinate(a)) return [];
    const proximity = viewProximity(area, a);
    return proximity.distanceNm < area.radiusNm ? [{ aircraft: a, ...proximity }] : [];
  });
}
export const statuteMilesFromNm = nmToMiles;

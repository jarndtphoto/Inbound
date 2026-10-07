import pack from "./data/chicago-airport-surfaces.json" with { type: "json" };
import type { AirportSurface } from "./airport-surface.server";

/** Only the two explicitly captured Chicago airports; never a nearby-airport substitute. */
export function getAirportSurfaceSnapshot(input: { airport: string; lat: number; lon: number }): AirportSurface | null {
  const requested = input.airport.toUpperCase();
  const code = requested === "ORD" ? "KORD" : requested === "MDW" ? "KMDW" : requested;
  if (code !== "KORD" && code !== "KMDW") return null;
  const field = pack.provenance[code].field;
  // Reject mismatched caller coordinates rather than drawing ORD at MDW (or vice versa).
  if (!Number.isFinite(input.lat) || !Number.isFinite(input.lon)
    || Math.abs(input.lat - field.lat) > 0.03 || Math.abs(input.lon - field.lon) > 0.04) return null;
  const surface = pack.surfaces[code] as AirportSurface;
  return { ...surface, airport: requested };
}

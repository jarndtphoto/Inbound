import type { Hazard } from "./types.ts";

/** Keep upcoming warnings distinct from otherwise identical warnings passed. */
export function distinctRouteHazards(hazards: Hazard[]): Hazard[] {
  const seen = new Set<string>();
  return hazards.filter((hazard) => {
    const key = `${hazard.kind}:${hazard.label}:${hazard.chop}:${hazard.remaining}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function upcomingStorms(hazards: Hazard[]): Hazard[] {
  return hazards.filter((h) => h.remaining && h.kind === "convective" &&
    Number.isFinite(h.lat) && Number.isFinite(h.lon)).slice(0, 6);
}

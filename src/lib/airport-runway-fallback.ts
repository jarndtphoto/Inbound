import endsJson from "./runway-ends.json" with { type: "json" };
import { haversineNm } from "./geo.ts";
import type { SurfaceFeature } from "./airport-surface.server.ts";

type RunwayEnd = { ident: string; lat: number; lon: number; heading: number; displacedFt?: number };
const ends = endsJson as Record<string, RunwayEnd[]>;

function headingDelta(a: number, b: number) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

/** Lightweight runway skeleton that is always local and instant.
 * Detailed taxiways/terminals can replace it when the surface provider returns. */
export function airportRunwayFallbackFeatures(icao: string): SurfaceFeature[] {
  const runwayEnds = ends[String(icao || "").toUpperCase()] ?? [];
  const used = new Set<number>();
  const features: SurfaceFeature[] = [];

  for (let i = 0; i < runwayEnds.length; i += 1) {
    if (used.has(i)) continue;
    const a = runwayEnds[i]!;
    let partner = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let j = i + 1; j < runwayEnds.length; j += 1) {
      if (used.has(j)) continue;
      const b = runwayEnds[j]!;
      const opposite = Math.abs(180 - headingDelta(a.heading, b.heading));
      if (opposite > 25) continue;
      const distance = haversineNm(a, b);
      if (distance < 0.15 || distance > 5) continue;
      const score = opposite * 4 + distance;
      if (score < bestScore) {
        bestScore = score;
        partner = j;
      }
    }
    if (partner < 0) continue;
    const b = runwayEnds[partner]!;
    used.add(i);
    used.add(partner);
    features.push({
      id: -(features.length + 1),
      kind: "runway",
      ref: `${a.ident}/${b.ident}`,
      name: `Runway ${a.ident}/${b.ident}`,
      points: [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }],
    });
  }
  return features;
}

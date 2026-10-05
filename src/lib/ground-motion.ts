import { haversineNm, initialBearing } from "./geo";

type MotionPoint = { lat: number; lon: number; seenAt: number };
export type GroundMotionState = { points: MotionPoint[]; confirmedTrack: number | null };

function bearingDelta(a: number, b: number) {
  return Math.abs(((a - b + 540) % 360) - 180);
}

export function advanceGroundMotion(previous: GroundMotionState | null, fix: MotionPoint): GroundMotionState {
  const last = previous?.points.at(-1) ?? null;
  if (previous && last && fix.seenAt <= last.seenAt + 0.25) return previous;

  const points = [...(previous?.points ?? []), { lat: fix.lat, lon: fix.lon, seenAt: fix.seenAt }]
    .filter((point) => fix.seenAt - point.seenAt <= 45)
    .slice(-10);

  let confirmedTrack: number | null = null;
  const latest = points.at(-1) ?? null;
  if (latest && points.length >= 3) {
    // Ground ADS-B can jitter by a few dozen feet between receivers. Use a
    // multi-fix displacement window instead of a single hop so we only draw
    // an arrow after meaningful, sustained movement.
    const anchor = points.find((point) => {
      const dt = latest.seenAt - point.seenAt;
      return dt >= 6 && dt <= 35 && haversineNm(point, latest) >= 0.015;
    }) ?? null;

    if (anchor) {
      const overall = initialBearing(anchor, latest);
      const recent = points.slice(-3);
      const recentAnchor = recent[0] ?? anchor;
      const recentMoved = haversineNm(recentAnchor, latest);
      const recentTrack = recentMoved >= 0.008 ? initialBearing(recentAnchor, latest) : overall;

      // If the aircraft is actively turning, show a dot until the new
      // direction settles instead of displaying either the old or reciprocal
      // heading with false confidence.
      if (bearingDelta(overall, recentTrack) <= 55) confirmedTrack = recentTrack;
    }
  }
  return { points, confirmedTrack };
}

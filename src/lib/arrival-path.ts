import { haversineNm, initialBearing, type Coord } from "./geo.ts";

export const ARRIVAL_OFF_PATH_NM = 8;
const MATCH_TOLERANCE_NM = 0.2;
const headingDelta = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/** Perpendicular projection including sub-mile legs. Local nautical miles;
 * clamp only for distance to the finite segment, never a point shortcut. */
export function projectArrivalSegment(point: Coord, a: Coord, b: Coord) {
  const cosLat = Math.cos((a.lat + b.lat + point.lat) / 3 * Math.PI / 180);
  const dx = ((b.lon - a.lon + 540) % 360 - 180) * 60 * cosLat;
  const dy = (b.lat - a.lat) * 60;
  const px = ((point.lon - a.lon + 540) % 360 - 180) * 60 * cosLat;
  const py = (point.lat - a.lat) * 60;
  const squared = dx * dx + dy * dy;
  const rawFraction = squared > 1e-12 ? (px * dx + py * dy) / squared : 0;
  const fraction = Math.max(0, Math.min(1, rawFraction));
  return { fraction, rawFraction,
    distanceNm: Math.hypot(px - fraction * dx, py - fraction * dy),
    point: { lat: a.lat + fraction * (b.lat - a.lat), lon: a.lon + fraction * (((b.lon - a.lon + 540) % 360) - 180) } };
}

/** Furthest forward match in the local corridor. The broad 8nm rejection
 * tolerance must not match a parallel final leg 5nm away while on downwind. */
export function projectArrivalPath(live: Coord, cursorPoint: Coord, points: Coord[], pointAlongNm: number[], cursorNm: number) {
  let a = cursorPoint, startNm = cursorNm;
  const candidates = points.map((b, i) => {
    const projected = projectArrivalSegment(live, a, b);
    const alongNm = startNm + projected.fraction * (pointAlongNm[i] - startNm);
    a = b; startNm = pointAlongNm[i];
    return { ...projected, alongNm };
  });
  if (!candidates.length) return { distanceNm: haversineNm(live, cursorPoint), alongNm: cursorNm, point: cursorPoint };
  const distanceNm = Math.min(...candidates.map(p => p.distanceNm));
  const inCorridor = candidates.filter(p => p.distanceNm <= ARRIVAL_OFF_PATH_NM && p.distanceNm <= distanceNm + MATCH_TOLERANCE_NM);
  // Prefer interior feet to the clamped endpoints of distant future legs.
  const interior = inCorridor.filter(p => p.rawFraction >= 0 && p.rawFraction <= 1);
  const pool = interior.length ? interior : inCorridor.length ? inCorridor : candidates.filter(p => p.distanceNm <= distanceNm + 1e-6);
  const winner = pool.reduce((best, p) => p.alongNm > best.alongNm ? p : best);
  return { distanceNm, alongNm: Math.max(cursorNm, winner.alongNm), point: winner.point };
}

export function arrivalPointBehind(live: Coord & { track?: number | null }, point: Coord) {
  return Number.isFinite(live.track) && haversineNm(live, point) > 1e-4 && headingDelta(initialBearing(live, point), live.track!) > 100;
}

/** Planned future suffix only; the caller adds the live display anchor. */
export function arrivalFuturePoints(points: Coord[], live: Coord & { track?: number | null }) {
  let first = 0;
  while (first < points.length && arrivalPointBehind(live, points[first])) first++;
  return points.slice(first);
}

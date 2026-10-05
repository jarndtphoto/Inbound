import type { SurfaceFeature, SurfacePoint } from "./airport-surface.server";

export const ROUTE_AIRPORT_MIN_WIDTH_MILES = 6;
export const ROUTE_AIRPORT_DETAIL_WIDTH_MILES = 60;
const MILES_PER_LON_DEGREE = 69.0934;

// Parallel distance, rather than endpoint great-circle distance (which folds beyond 180°).
export function routeVisibleWidthMiles(longitudeSpan: number, latitude: number, zoom = 1) {
  return Math.abs(longitudeSpan) * MILES_PER_LON_DEGREE * Math.cos(Math.min(85, Math.abs(latitude)) * Math.PI / 180) / zoom;
}

export function maxRouteZoom(baseWidthMiles: number) {
  return Math.max(1, baseWidthMiles / ROUTE_AIRPORT_MIN_WIDTH_MILES);
}

export function airportDetailOpacity(widthMiles: number) {
  return Math.max(0, Math.min(1, (ROUTE_AIRPORT_DETAIL_WIDTH_MILES - widthMiles) / 25));
}

export function showRouteAirportLoadingNote(widthMiles: number, pending: boolean) {
  return pending && widthMiles <= ROUTE_AIRPORT_MIN_WIDTH_MILES * 1.05;
}

export function airportNearViewport(point: { x: number; y: number }, view: { s: number; x: number; y: number }, height: number, radiusPx: number) {
  const x = point.x * view.s + view.x, y = point.y * view.s + view.y;
  const margin = radiusPx * view.s;
  return x >= -margin && x <= 800 + margin && y >= -margin && y <= height + margin;
}

export function routeStrokeWidths(zoom: number, band: string, past = false) {
  const shrink = Math.max(0.22, 1 / Math.sqrt(Math.max(1, zoom)));
  const line = (past ? 3.2 : band === "smooth" ? 5.2 : 6.4) * (2 / 3) * shrink;
  return { line, outline: line + (10 / 3) * shrink, reported: 2 * shrink };
}

// Douglas-Peucker at 8 m: retain runway ends and terminal corners, discard noisy vertices.
function simplify(points: SurfacePoint[], tolerance = 8): SurfacePoint[] {
  if (points.length <= 3) return points;
  const lonScale = 111_195 * Math.cos(points[0].lat * Math.PI / 180);
  const xy = points.map(p => ({ x: (p.lon - points[0].lon) * lonScale, y: (p.lat - points[0].lat) * 111_195 }));
  const keep = new Set([0, points.length - 1]);
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    const a = xy[start], b = xy[end], dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
    let furthest = -1, maxDistance2 = tolerance * tolerance;
    for (let i = start + 1; i < end; i++) {
      const p = xy[i], t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
      const distance2 = (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
      if (distance2 > maxDistance2) { furthest = i; maxDistance2 = distance2; }
    }
    if (furthest >= 0) { keep.add(furthest); stack.push([start, furthest], [furthest, end]); }
  }
  return [...keep].sort((a, b) => a - b).map(i => points[i]);
}

export function simplifyRouteAirportSurface(features: SurfaceFeature[]) {
  const allowed = new Set(["runway", "runway_area", "taxiway", "taxiway_area", "terminal", "apron"]);
  const order: Record<string, number> = { apron: 0, taxiway_area: 1, taxiway: 2, runway_area: 3, runway: 4, terminal: 5 };
  return features.filter(f => allowed.has(f.kind) && f.points.length >= 2)
    .map(f => ({ ...f, points: simplify(f.points) }))
    .sort((a, b) => order[a.kind] - order[b.kind]);
}

export function simplifySurfaceRings(rings: SurfacePoint[][]) {
  return rings
    .map(ring => simplify(ring, 12))
    .filter(ring => ring.length >= 3);
}

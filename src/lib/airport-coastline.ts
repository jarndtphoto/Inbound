export type GeoPoint = { lat: number; lon: number };
export type SurfaceBounds = { south: number; west: number; north: number; east: number };
export type SurfacePolygon = { outer: GeoPoint[]; holes?: GeoPoint[][] };
export type AirportDetailedGeography = {
  bounds: SurfaceBounds;
  base: "land" | "water";
  land: GeoPoint[][];
  water: SurfacePolygon[];
  fallback: boolean;
  fallbackReason?: string;
};

const EPS = 1e-7;

export function airportSurfaceBounds(input: { lat: number; lon: number }): SurfaceBounds {
  const latPad = 0.075;
  const lonPad = Math.min(0.12, 0.075 / Math.max(0.45, Math.cos(input.lat * Math.PI / 180)));
  return {
    south: input.lat - latPad,
    west: input.lon - lonPad,
    north: input.lat + latPad,
    east: input.lon + lonPad,
  };
}

/** Detailed geography covers roughly the 60-mile airport-detail viewport. */
export function airportDetailGeographyBounds(input: { lat: number; lon: number }): SurfaceBounds {
  const latPad = 0.45;
  const lonPad = Math.min(0.8, latPad / Math.max(0.45, Math.cos(input.lat * Math.PI / 180)));
  return {
    south: Math.max(-85, input.lat - latPad),
    west: Math.max(-180, input.lon - lonPad),
    north: Math.min(85, input.lat + latPad),
    east: Math.min(180, input.lon + lonPad),
  };
}

export function surfaceBoundsBox(bounds: SurfaceBounds): GeoPoint[] {
  return [
    { lat: bounds.south, lon: bounds.west },
    { lat: bounds.south, lon: bounds.east },
    { lat: bounds.north, lon: bounds.east },
    { lat: bounds.north, lon: bounds.west },
    { lat: bounds.south, lon: bounds.west },
  ];
}

function samePoint(a: GeoPoint | undefined, b: GeoPoint | undefined, epsilon = EPS) {
  return Boolean(a && b && Math.abs(a.lat - b.lat) <= epsilon && Math.abs(a.lon - b.lon) <= epsilon);
}

function signedArea(ring: GeoPoint[]) {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    area += a.lon * b.lat - b.lon * a.lat;
  }
  return area / 2;
}

function pointInRing(point: GeoPoint, ring: GeoPoint[]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    const intersect = ((a.lat > point.lat) !== (b.lat > point.lat))
      && point.lon < (b.lon - a.lon) * (point.lat - a.lat) / ((b.lat - a.lat) || 1e-12) + a.lon;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: GeoPoint, polygon: SurfacePolygon) {
  if (!pointInRing(point, polygon.outer)) return false;
  return !(polygon.holes ?? []).some((hole) => pointInRing(point, hole));
}

function simplify(points: GeoPoint[], toleranceM = 12): GeoPoint[] {
  if (points.length <= 4) return points;
  const closed = samePoint(points[0], points.at(-1));
  const work = closed ? points.slice(0, -1) : points.slice();
  if (work.length <= 3) return points;
  const origin = work[0]!;
  const lonScale = 111_195 * Math.max(0.2, Math.cos(origin.lat * Math.PI / 180));
  const xy = work.map((p) => ({ x: (p.lon - origin.lon) * lonScale, y: (p.lat - origin.lat) * 111_195 }));
  const keep = new Set([0, work.length - 1]);
  const stack: Array<[number, number]> = [[0, work.length - 1]];
  while (stack.length) {
    const [start, end] = stack.pop()!;
    const a = xy[start]!, b = xy[end]!, dx = b.x - a.x, dy = b.y - a.y;
    const length2 = dx * dx + dy * dy;
    let furthest = -1, maxDistance2 = toleranceM * toleranceM;
    for (let i = start + 1; i < end; i++) {
      const p = xy[i]!;
      const t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length2)) : 0;
      const ddx = p.x - a.x - t * dx, ddy = p.y - a.y - t * dy;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 > maxDistance2) { maxDistance2 = d2; furthest = i; }
    }
    if (furthest >= 0) {
      keep.add(furthest);
      stack.push([start, furthest], [furthest, end]);
    }
  }
  const result = [...keep].sort((a, b) => a - b).map((i) => work[i]!);
  if (closed && result.length >= 3) result.push(result[0]!);
  return result;
}

function clipSegment(a: GeoPoint, b: GeoPoint, bounds: SurfaceBounds): [GeoPoint, GeoPoint] | null {
  const dx = b.lon - a.lon, dy = b.lat - a.lat;
  let t0 = 0, t1 = 1;
  const checks: Array<[number, number]> = [
    [-dx, a.lon - bounds.west],
    [dx, bounds.east - a.lon],
    [-dy, a.lat - bounds.south],
    [dy, bounds.north - a.lat],
  ];
  for (const [p, q] of checks) {
    if (Math.abs(p) < 1e-14) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [
    { lat: a.lat + dy * t0, lon: a.lon + dx * t0 },
    { lat: a.lat + dy * t1, lon: a.lon + dx * t1 },
  ];
}

export function clipPolylineToBounds(points: GeoPoint[], bounds: SurfaceBounds): GeoPoint[][] {
  const out: GeoPoint[][] = [];
  let current: GeoPoint[] | null = null;
  for (let i = 1; i < points.length; i++) {
    const clipped = clipSegment(points[i - 1]!, points[i]!, bounds);
    if (!clipped) {
      current = null;
      continue;
    }
    const [a, b] = clipped;
    if (!current || !samePoint(current.at(-1), a)) {
      current = [a, b];
      out.push(current);
    } else if (!samePoint(current.at(-1), b)) {
      current.push(b);
    }
  }
  return out.filter((chain) => chain.length >= 2);
}

function clipRingEdge(points: GeoPoint[], inside: (p: GeoPoint) => boolean, intersect: (a: GeoPoint, b: GeoPoint) => GeoPoint) {
  const out: GeoPoint[] = [];
  if (!points.length) return out;
  let previous = points.at(-1)!;
  let previousInside = inside(previous);
  for (const current of points) {
    const currentInside = inside(current);
    if (currentInside !== previousInside) out.push(intersect(previous, current));
    if (currentInside) out.push(current);
    previous = current;
    previousInside = currentInside;
  }
  return out;
}

export function clipRingToBounds(ring: GeoPoint[], bounds: SurfaceBounds): GeoPoint[] {
  let points = ring.length > 1 && samePoint(ring[0], ring.at(-1)) ? ring.slice(0, -1) : ring.slice();
  const vertical = (lon: number) => (a: GeoPoint, b: GeoPoint) => {
    const t = (lon - a.lon) / ((b.lon - a.lon) || 1e-12);
    return { lon, lat: a.lat + (b.lat - a.lat) * t };
  };
  const horizontal = (lat: number) => (a: GeoPoint, b: GeoPoint) => {
    const t = (lat - a.lat) / ((b.lat - a.lat) || 1e-12);
    return { lat, lon: a.lon + (b.lon - a.lon) * t };
  };
  points = clipRingEdge(points, (p) => p.lon >= bounds.west - EPS, vertical(bounds.west));
  points = clipRingEdge(points, (p) => p.lon <= bounds.east + EPS, vertical(bounds.east));
  points = clipRingEdge(points, (p) => p.lat >= bounds.south - EPS, horizontal(bounds.south));
  points = clipRingEdge(points, (p) => p.lat <= bounds.north + EPS, horizontal(bounds.north));
  if (points.length >= 3 && !samePoint(points[0], points.at(-1))) points.push(points[0]!);
  return points.length >= 4 ? points : [];
}

function joinDirectedWays(ways: GeoPoint[][]) {
  const pending = ways.filter((way) => way.length >= 2).map((way) => way.slice());
  const joined: GeoPoint[][] = [];
  while (pending.length) {
    let chain = pending.shift()!;
    let changed = true;
    while (changed && !samePoint(chain[0], chain.at(-1))) {
      changed = false;
      for (let i = 0; i < pending.length; i++) {
        const other = pending[i]!;
        if (samePoint(chain.at(-1), other[0])) {
          chain = [...chain, ...other.slice(1)];
          pending.splice(i, 1);
          changed = true;
          break;
        }
        if (samePoint(other.at(-1), chain[0])) {
          chain = [...other.slice(0, -1), ...chain];
          pending.splice(i, 1);
          changed = true;
          break;
        }
      }
    }
    joined.push(chain);
  }
  return joined;
}

function boundaryParam(point: GeoPoint, bounds: SurfaceBounds) {
  const width = bounds.east - bounds.west, height = bounds.north - bounds.south;
  if (Math.abs(point.lat - bounds.south) <= 1e-6) return Math.max(0, Math.min(width, point.lon - bounds.west));
  if (Math.abs(point.lon - bounds.east) <= 1e-6) return width + Math.max(0, Math.min(height, point.lat - bounds.south));
  if (Math.abs(point.lat - bounds.north) <= 1e-6) return width + height + Math.max(0, Math.min(width, bounds.east - point.lon));
  if (Math.abs(point.lon - bounds.west) <= 1e-6) return 2 * width + height + Math.max(0, Math.min(height, bounds.north - point.lat));
  return null;
}

function boundaryPointAt(param: number, bounds: SurfaceBounds): GeoPoint {
  const width = bounds.east - bounds.west, height = bounds.north - bounds.south;
  const perimeter = 2 * (width + height);
  let p = ((param % perimeter) + perimeter) % perimeter;
  if (p <= width) return { lat: bounds.south, lon: bounds.west + p };
  p -= width;
  if (p <= height) return { lat: bounds.south + p, lon: bounds.east };
  p -= height;
  if (p <= width) return { lat: bounds.north, lon: bounds.east - p };
  p -= width;
  return { lat: bounds.north - p, lon: bounds.west };
}

/** Follow the box counter-clockwise. With OSM land-on-left coastlines this closes the land side. */
function closeAlongLandSide(end: GeoPoint, start: GeoPoint, bounds: SurfaceBounds) {
  const width = bounds.east - bounds.west, height = bounds.north - bounds.south;
  const perimeter = 2 * (width + height);
  const from = boundaryParam(end, bounds), rawTo = boundaryParam(start, bounds);
  if (from == null || rawTo == null) return null;
  let to = rawTo;
  while (to <= from + EPS) to += perimeter;
  const corners = [width, width + height, 2 * width + height, perimeter, perimeter + width, perimeter + width + height, 2 * perimeter - height];
  const points: GeoPoint[] = [];
  for (const corner of corners) if (corner > from + EPS && corner < to - EPS) points.push(boundaryPointAt(corner, bounds));
  points.push(start);
  return points;
}

function polygonArea(ring: GeoPoint[]) {
  return Math.abs(signedArea(ring));
}

function fallback(bounds: SurfaceBounds, reason: string): AirportDetailedGeography {
  return { bounds, base: "land", land: [], water: [], fallback: true, fallbackReason: reason };
}

function prepareWater(polygons: SurfacePolygon[], bounds: SurfaceBounds) {
  const out: SurfacePolygon[] = [];
  for (const polygon of polygons) {
    const outer = simplify(clipRingToBounds(polygon.outer, bounds));
    if (outer.length < 4) continue;
    const holes = (polygon.holes ?? [])
      .map((hole) => simplify(clipRingToBounds(hole, bounds)))
      .filter((hole) => hole.length >= 4);
    out.push({ outer, ...(holes.length ? { holes } : {}) });
  }
  return out;
}

function waterCoverage(polygons: SurfacePolygon[], bounds: SurfaceBounds) {
  const boxArea = Math.max(EPS, (bounds.east - bounds.west) * (bounds.north - bounds.south));
  let area = 0;
  for (const polygon of polygons) {
    area += polygonArea(polygon.outer);
    for (const hole of polygon.holes ?? []) area -= polygonArea(hole);
  }
  return Math.max(0, area) / boxArea;
}

export function assembleAirportGeography(input: {
  bounds: SurfaceBounds;
  coastlineWays: GeoPoint[][];
  waterPolygons: SurfacePolygon[];
  runwaySamples?: GeoPoint[];
}): AirportDetailedGeography {
  const { bounds } = input;
  const water = prepareWater(input.waterPolygons, bounds);
  if (waterCoverage(water, bounds) > 0.95) return fallback(bounds, "water-over-95-percent");

  const joined = joinDirectedWays(input.coastlineWays);
  const land: GeoPoint[][] = [];
  let coastIntersections = 0;

  for (const way of joined) {
    if (way.length < 2) continue;
    if (samePoint(way[0], way.at(-1))) {
      const ring = simplify(clipRingToBounds(way, bounds));
      if (!ring.length) continue;
      coastIntersections += 1;
      if (signedArea(ring) <= 0) return fallback(bounds, "reversed-closed-coastline");
      land.push(ring);
      continue;
    }

    const chains = clipPolylineToBounds(way, bounds);
    for (const chain of chains) {
      if (chain.length < 2) continue;
      coastIntersections += 1;
      const start = chain[0]!, end = chain.at(-1)!;
      const closure = closeAlongLandSide(end, start, bounds);
      if (!closure) return fallback(bounds, "open-coastline-not-on-box-edge");
      const ring = simplify([...chain, ...closure]);
      if (ring.length < 4 || signedArea(ring) <= 0) return fallback(bounds, "coastline-assembly-orientation");
      land.push(ring);
    }
  }

  const base: "land" | "water" = coastIntersections ? "water" : "land";
  const geography: AirportDetailedGeography = { bounds, base, land, water, fallback: false };

  const runwaySamples = input.runwaySamples ?? [];
  if (runwaySamples.length) {
    const onLand = runwaySamples.filter((point) => {
      const inlandWater = water.some((polygon) => pointInPolygon(point, polygon));
      if (inlandWater) return false;
      return base === "land" || land.some((ring) => pointInRing(point, ring));
    }).length;
    if (onLand / runwaySamples.length < 0.5) return fallback(bounds, "water-covers-runways");
  }

  return geography;
}

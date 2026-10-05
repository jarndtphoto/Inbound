import type { SurfacePoint } from "./airport-surface.server.ts";

export type SurfaceBounds = { south: number; west: number; north: number; east: number };
export type SurfacePolygon = { outer: SurfacePoint[]; holes?: SurfacePoint[][] };
export type AirportHydrography = {
  bounds: SurfaceBounds;
  /** Full box starts as water when coastline geometry defines ocean/bay water; otherwise it starts as land. */
  ocean: boolean;
  land: SurfacePolygon[];
  water: SurfacePolygon[];
  fallback: boolean;
  fallbackReason?: string;
  waterFraction: number;
  coastlineWays: number;
  waterPolygons: number;
};

type CoastlineWay = { id: number; points: SurfacePoint[] };

const EPS = 1e-7;
const METERS_PER_DEGREE = 111_195;

function samePoint(a: SurfacePoint | undefined, b: SurfacePoint | undefined, eps = EPS) {
  return Boolean(a && b && Math.abs(a.lat - b.lat) <= eps && Math.abs(a.lon - b.lon) <= eps);
}

export function airportSurfaceBounds(input: { lat: number; lon: number }): SurfaceBounds {
  const latPad = 0.075;
  const lonPad = Math.min(0.12, latPad / Math.max(0.45, Math.cos(input.lat * Math.PI / 180)));
  return {
    south: input.lat - latPad,
    west: input.lon - lonPad,
    north: input.lat + latPad,
    east: input.lon + lonPad,
  };
}

export function surfaceBoundsString(bounds: SurfaceBounds) {
  return [
    bounds.south.toFixed(6),
    bounds.west.toFixed(6),
    bounds.north.toFixed(6),
    bounds.east.toFixed(6),
  ].join(",");
}

export function surfaceBoxRing(bounds: SurfaceBounds): SurfacePoint[] {
  return [
    { lat: bounds.south, lon: bounds.west },
    { lat: bounds.south, lon: bounds.east },
    { lat: bounds.north, lon: bounds.east },
    { lat: bounds.north, lon: bounds.west },
    { lat: bounds.south, lon: bounds.west },
  ];
}

function signedArea(ring: SurfacePoint[]) {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const a = ring[i]!, b = ring[i + 1]!;
    sum += a.lon * b.lat - b.lon * a.lat;
  }
  return sum / 2;
}

function onBoundary(point: SurfacePoint, bounds: SurfaceBounds) {
  return Math.abs(point.lat - bounds.south) <= EPS
    || Math.abs(point.lat - bounds.north) <= EPS
    || Math.abs(point.lon - bounds.west) <= EPS
    || Math.abs(point.lon - bounds.east) <= EPS;
}

function clampPoint(point: SurfacePoint, bounds: SurfaceBounds): SurfacePoint {
  return {
    lat: Math.max(bounds.south, Math.min(bounds.north, point.lat)),
    lon: Math.max(bounds.west, Math.min(bounds.east, point.lon)),
  };
}

function clipSegment(a: SurfacePoint, b: SurfacePoint, bounds: SurfaceBounds): [SurfacePoint, SurfacePoint] | null {
  const dx = b.lon - a.lon;
  const dy = b.lat - a.lat;
  let t0 = 0;
  let t1 = 1;
  const tests: Array<[number, number]> = [
    [-dx, a.lon - bounds.west],
    [dx, bounds.east - a.lon],
    [-dy, a.lat - bounds.south],
    [dy, bounds.north - a.lat],
  ];
  for (const [p, q] of tests) {
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
  const point = (t: number) => clampPoint({ lat: a.lat + dy * t, lon: a.lon + dx * t }, bounds);
  return [point(t0), point(t1)];
}

function clipPolyline(points: SurfacePoint[], bounds: SurfaceBounds): SurfacePoint[][] {
  const pieces: SurfacePoint[][] = [];
  let current: SurfacePoint[] = [];
  for (let i = 1; i < points.length; i++) {
    const clipped = clipSegment(points[i - 1]!, points[i]!, bounds);
    if (!clipped) {
      if (current.length >= 2) pieces.push(current);
      current = [];
      continue;
    }
    const [start, end] = clipped;
    if (!current.length) current = [start, end];
    else if (samePoint(current.at(-1), start)) current.push(end);
    else {
      if (current.length >= 2) pieces.push(current);
      current = [start, end];
    }
    if (!samePoint(end, points[i])) {
      if (current.length >= 2) pieces.push(current);
      current = [];
    }
  }
  if (current.length >= 2) pieces.push(current);
  return pieces.map(piece => piece.filter((point, index) => index === 0 || !samePoint(point, piece[index - 1])));
}

function joinDirectedPieces(input: SurfacePoint[][]) {
  const pieces = input.map(points => points.slice());
  const chains: SurfacePoint[][] = [];
  let inconsistent = false;
  while (pieces.length) {
    let chain = pieces.shift()!;
    let joined = true;
    while (joined) {
      joined = false;
      for (let i = 0; i < pieces.length; i++) {
        const candidate = pieces[i]!;
        if (samePoint(chain.at(-1), candidate[0])) {
          chain = [...chain, ...candidate.slice(1)];
        } else if (samePoint(candidate.at(-1), chain[0])) {
          chain = [...candidate.slice(0, -1), ...chain];
        } else if (samePoint(chain.at(-1), candidate.at(-1)) || samePoint(chain[0], candidate[0])) {
          inconsistent = true;
          continue;
        } else {
          continue;
        }
        pieces.splice(i, 1);
        joined = true;
        break;
      }
    }
    chains.push(chain);
  }
  return { chains, inconsistent };
}

function perimeterPosition(point: SurfacePoint, bounds: SurfaceBounds) {
  const width = bounds.east - bounds.west;
  const height = bounds.north - bounds.south;
  if (Math.abs(point.lat - bounds.south) <= EPS) return Math.max(0, Math.min(width, point.lon - bounds.west));
  if (Math.abs(point.lon - bounds.east) <= EPS) return width + Math.max(0, Math.min(height, point.lat - bounds.south));
  if (Math.abs(point.lat - bounds.north) <= EPS) return width + height + Math.max(0, Math.min(width, bounds.east - point.lon));
  if (Math.abs(point.lon - bounds.west) <= EPS) return width * 2 + height + Math.max(0, Math.min(height, bounds.north - point.lat));
  return null;
}

function perimeterPoint(position: number, bounds: SurfaceBounds): SurfacePoint {
  const width = bounds.east - bounds.west;
  const height = bounds.north - bounds.south;
  const perimeter = 2 * (width + height);
  let p = ((position % perimeter) + perimeter) % perimeter;
  if (p <= width) return { lat: bounds.south, lon: bounds.west + p };
  p -= width;
  if (p <= height) return { lat: bounds.south + p, lon: bounds.east };
  p -= height;
  if (p <= width) return { lat: bounds.north, lon: bounds.east - p };
  p -= width;
  return { lat: bounds.north - p, lon: bounds.west };
}

function boundaryPathCcw(from: SurfacePoint, to: SurfacePoint, bounds: SurfaceBounds) {
  const a = perimeterPosition(from, bounds);
  const b0 = perimeterPosition(to, bounds);
  if (a == null || b0 == null) return null;
  const width = bounds.east - bounds.west;
  const height = bounds.north - bounds.south;
  const perimeter = 2 * (width + height);
  let b = b0;
  if (b < a - EPS) b += perimeter;
  const corners = [width, width + height, 2 * width + height, perimeter, perimeter + width, perimeter + width + height];
  const result = [from];
  for (const corner of corners) if (corner > a + EPS && corner < b - EPS) result.push(perimeterPoint(corner, bounds));
  result.push(to);
  return result;
}

function closeLandLeftChain(chain: SurfacePoint[], bounds: SurfaceBounds): SurfacePoint[] | null {
  const start = chain[0]!, end = chain.at(-1)!;
  if (!onBoundary(start, bounds) || !onBoundary(end, bounds)) return null;
  const ccw = boundaryPathCcw(end, start, bounds);
  const cwBack = boundaryPathCcw(start, end, bounds);
  if (!ccw || !cwBack) return null;
  const first = [...chain, ...ccw.slice(1)];
  if (!samePoint(first[0], first.at(-1))) first.push(first[0]!);
  if (signedArea(first) > 0) return first;
  const second = [...chain, ...cwBack.slice(0, -1).reverse()];
  if (!samePoint(second[0], second.at(-1))) second.push(second[0]!);
  return signedArea(second) > 0 ? second : null;
}

function insideEdge(point: SurfacePoint, edge: 0 | 1 | 2 | 3, bounds: SurfaceBounds) {
  if (edge === 0) return point.lon >= bounds.west - EPS;
  if (edge === 1) return point.lon <= bounds.east + EPS;
  if (edge === 2) return point.lat >= bounds.south - EPS;
  return point.lat <= bounds.north + EPS;
}

function edgeIntersection(a: SurfacePoint, b: SurfacePoint, edge: 0 | 1 | 2 | 3, bounds: SurfaceBounds): SurfacePoint {
  const dx = b.lon - a.lon;
  const dy = b.lat - a.lat;
  if (edge === 0 || edge === 1) {
    const lon = edge === 0 ? bounds.west : bounds.east;
    const t = Math.abs(dx) < 1e-14 ? 0 : (lon - a.lon) / dx;
    return { lon, lat: a.lat + dy * t };
  }
  const lat = edge === 2 ? bounds.south : bounds.north;
  const t = Math.abs(dy) < 1e-14 ? 0 : (lat - a.lat) / dy;
  return { lat, lon: a.lon + dx * t };
}

export function clipPolygonToBounds(ring: SurfacePoint[], bounds: SurfaceBounds): SurfacePoint[] {
  if (ring.length < 3) return [];
  let output = ring.slice();
  if (samePoint(output[0], output.at(-1))) output.pop();
  for (const edge of [0, 1, 2, 3] as const) {
    const input = output;
    output = [];
    if (!input.length) break;
    let previous = input.at(-1)!;
    for (const current of input) {
      const currentInside = insideEdge(current, edge, bounds);
      const previousInside = insideEdge(previous, edge, bounds);
      if (currentInside) {
        if (!previousInside) output.push(edgeIntersection(previous, current, edge, bounds));
        output.push(current);
      } else if (previousInside) {
        output.push(edgeIntersection(previous, current, edge, bounds));
      }
      previous = current;
    }
  }
  output = output.map(point => clampPoint(point, bounds));
  if (output.length >= 3 && !samePoint(output[0], output.at(-1))) output.push(output[0]!);
  return output.length >= 4 ? output : [];
}

function distanceMeters(a: SurfacePoint, b: SurfacePoint) {
  const lat = (a.lat + b.lat) / 2 * Math.PI / 180;
  const dx = (a.lon - b.lon) * METERS_PER_DEGREE * Math.cos(lat);
  const dy = (a.lat - b.lat) * METERS_PER_DEGREE;
  return Math.hypot(dx, dy);
}

function simplifyRing(ring: SurfacePoint[], toleranceMeters = 18): SurfacePoint[] {
  if (ring.length <= 5) return ring;
  const closed = samePoint(ring[0], ring.at(-1));
  const source = closed ? ring.slice(0, -1) : ring.slice();
  const kept: SurfacePoint[] = [];
  for (const point of source) {
    if (!kept.length || distanceMeters(kept.at(-1)!, point) >= toleranceMeters) kept.push(point);
  }
  if (kept.length < 3) return ring;
  if (closed) kept.push(kept[0]!);
  return kept;
}

function pointOnSegment(point: SurfacePoint, a: SurfacePoint, b: SurfacePoint) {
  const cos = Math.max(0.25, Math.cos(point.lat * Math.PI / 180));
  const ax = (a.lon - point.lon) * 60 * cos, ay = (a.lat - point.lat) * 60;
  const bx = (b.lon - point.lon) * 60 * cos, by = (b.lat - point.lat) * 60;
  return Math.abs(ax * by - ay * bx) < 0.0008 && ax * bx + ay * by <= 0;
}

export function pointInSurfaceRing(point: SurfacePoint, ring: SurfacePoint[]) {
  if (ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!, b = ring[j]!;
    if (pointOnSegment(point, a, b)) return true;
    const crosses = (a.lat > point.lat) !== (b.lat > point.lat)
      && point.lon < (b.lon - a.lon) * (point.lat - a.lat) / ((b.lat - a.lat) || 1e-12) + a.lon;
    if (crosses) inside = !inside;
  }
  return inside;
}

function pointInPolygon(point: SurfacePoint, polygon: SurfacePolygon) {
  return pointInSurfaceRing(point, polygon.outer)
    && !(polygon.holes ?? []).some(hole => pointInSurfaceRing(point, hole));
}

function waterAt(point: SurfacePoint, ocean: boolean, land: SurfacePolygon[], water: SurfacePolygon[]) {
  if (water.some(poly => pointInPolygon(point, poly))) return true;
  return ocean && !land.some(poly => pointInPolygon(point, poly));
}

function sampleWaterFraction(bounds: SurfaceBounds, ocean: boolean, land: SurfacePolygon[], water: SurfacePolygon[]) {
  let wet = 0;
  const size = 24;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const point = {
        lat: bounds.south + (bounds.north - bounds.south) * (y + 0.5) / size,
        lon: bounds.west + (bounds.east - bounds.west) * (x + 0.5) / size,
      };
      if (waterAt(point, ocean, land, water)) wet++;
    }
  }
  return wet / (size * size);
}

function attachHoles(outers: SurfacePoint[][], holes: SurfacePoint[][]): SurfacePolygon[] {
  return outers.map(outer => {
    const contained = holes.filter(hole => {
      const point = hole[0];
      return point ? pointInSurfaceRing(point, outer) : false;
    });
    return contained.length ? { outer, holes: contained } : { outer };
  });
}

export function fallbackAirportHydrography(bounds: SurfaceBounds, reason: string): AirportHydrography {
  return {
    bounds,
    ocean: false,
    land: [],
    water: [],
    fallback: true,
    fallbackReason: reason,
    waterFraction: 0,
    coastlineWays: 0,
    waterPolygons: 0,
  };
}

export function buildAirportHydrography(input: {
  bounds: SurfaceBounds;
  coastlines: CoastlineWay[];
  water: SurfacePolygon[];
  runwayChecks?: SurfacePoint[];
}): AirportHydrography {
  const { bounds } = input;
  const clippedPieces = input.coastlines.flatMap(way => clipPolyline(way.points, bounds));
  const joined = joinDirectedPieces(clippedPieces);
  const land: SurfacePolygon[] = [];
  const coastlineWater: SurfacePolygon[] = [];
  let openOrIslandLand = false;
  let exteriorLandOnly = false;
  let assemblyFailed = joined.inconsistent;

  for (const raw of joined.chains) {
    if (raw.length < 2) continue;
    if (samePoint(raw[0], raw.at(-1))) {
      const ring = simplifyRing(raw);
      const area = signedArea(ring);
      if (Math.abs(area) < 1e-12) {
        assemblyFailed = true;
      } else if (area > 0) {
        land.push({ outer: ring });
        openOrIslandLand = true;
      } else {
        coastlineWater.push({ outer: ring.slice().reverse() });
        exteriorLandOnly = true;
      }
      continue;
    }
    const closed = closeLandLeftChain(raw, bounds);
    if (!closed) {
      assemblyFailed = true;
      continue;
    }
    land.push({ outer: simplifyRing(closed) });
    openOrIslandLand = true;
  }

  const clippedWater = input.water.flatMap(poly => {
    const outer = simplifyRing(clipPolygonToBounds(poly.outer, bounds));
    if (outer.length < 4) return [];
    const holes = (poly.holes ?? []).map(hole => simplifyRing(clipPolygonToBounds(hole, bounds))).filter(hole => hole.length >= 4);
    return attachHoles([outer], holes);
  });
  const water = [...coastlineWater, ...clippedWater];
  const ocean = input.coastlines.length > 0 && (openOrIslandLand || !exteriorLandOnly);
  if (input.coastlines.length > 0 && exteriorLandOnly && !openOrIslandLand) {
    land.push({ outer: surfaceBoxRing(bounds), holes: coastlineWater.map(poly => poly.outer) });
    coastlineWater.length = 0;
  }

  const finalWater = [...coastlineWater, ...clippedWater];
  const waterFraction = sampleWaterFraction(bounds, ocean, land, finalWater);
  const runwayInWater = (input.runwayChecks ?? []).some(point => waterAt(point, ocean, land, finalWater));
  const fallbackReason = assemblyFailed ? "coastline-assembly"
    : runwayInWater ? "water-over-runway"
      : waterFraction > 0.95 ? "water-over-95-percent"
        : null;

  if (fallbackReason) {
    return {
      ...fallbackAirportHydrography(bounds, fallbackReason),
      coastlineWays: input.coastlines.length,
      waterPolygons: clippedWater.length,
      waterFraction,
    };
  }

  return {
    bounds,
    ocean,
    land,
    water: finalWater,
    fallback: false,
    waterFraction,
    coastlineWays: input.coastlines.length,
    waterPolygons: clippedWater.length,
  };
}

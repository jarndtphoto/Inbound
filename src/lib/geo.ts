export type Coord = { lat: number; lon: number };

export type GeoJson = {
  type: string;
  coordinates?: unknown;
  geometries?: GeoJson[];
};

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const NM_PER_DEG_LAT = 60;
const EARTH_NM = 3440.065;

export function wrap360(deg: number) {
  return ((deg % 360) + 360) % 360;
}

export function compass16(deg: number): string {
  const labels = [
    "N", "NNE", "NE", "ENE",
    "E", "ESE", "SE", "SSE",
    "S", "SSW", "SW", "WSW",
    "W", "WNW", "NW", "NNW",
  ];
  const i = Math.round(wrap360(deg) / 22.5) % 16;
  return labels[i] ?? "N";
}

export function haversineNm(a: Coord, b: Coord): number {
  const dLat = (b.lat - a.lat) * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_NM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export function initialBearing(a: Coord, b: Coord): number {
  const lat1 = a.lat * RAD;
  const lat2 = b.lat * RAD;
  const dLon = (b.lon - a.lon) * RAD;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.sin(lat2) * Math.cos(dLon);
  return wrap360(Math.atan2(y, x) * DEG);
}

export function destPoint(from: Coord, bearingDeg: number, nm: number): Coord {
  const d = nm / EARTH_NM;
  const br = bearingDeg * RAD;
  const lat1 = from.lat * RAD;
  const lon1 = from.lon * RAD;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(br),
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(br) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: lat2 * DEG, lon: ((lon2 * DEG + 540) % 360) - 180 };
}

export function interpolateGreatCircle(a: Coord, b: Coord, t: number): Coord {
  const lat1 = a.lat * RAD;
  const lon1 = a.lon * RAD;
  const lat2 = b.lat * RAD;
  const lon2 = b.lon * RAD;
  const d = haversineNm(a, b) / EARTH_NM;
  if (d < 1e-8) return a;
  const sinD = Math.sin(d);
  const A = Math.sin((1 - t) * d) / sinD;
  const B = Math.sin(t * d) / sinD;
  const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
  const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
  const z = A * Math.sin(lat1) + B * Math.sin(lat2);
  return {
    lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * DEG,
    lon: Math.atan2(y, x) * DEG,
  };
}

export function greatCirclePoints(a: Coord, b: Coord, n: number): Coord[] {
  const count = Math.max(2, n);
  const out: Coord[] = [];
  for (let i = 0; i < count; i++) out.push(interpolateGreatCircle(a, b, i / (count - 1)));
  return out;
}

export function polylineLengthNm(points: Coord[]): number {
  let n = 0;
  for (let i = 1; i < points.length; i++) n += haversineNm(points[i - 1]!, points[i]!);
  return n;
}

export function downsampleNm(points: Coord[], minNm: number): Coord[] {
  if (points.length <= 2) return points.slice();
  const out: Coord[] = [points[0]!];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    if (haversineNm(out[out.length - 1]!, p) >= minNm) out.push(p);
  }
  const last = points[points.length - 1]!;
  if (haversineNm(out[out.length - 1]!, last) > 1) out.push(last);
  else out[out.length - 1] = last;
  return out;
}

/** Insert great-circle vertices so no leg is longer than maxNm. */
export function densifyPath(points: Coord[], maxNm: number): Coord[] {
  if (points.length < 2) return points.slice();
  const out: Coord[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const d = Math.max(0.01, haversineNm(a, b));
    const steps = Math.max(1, Math.ceil(d / maxNm));
    for (let s = 0; s < steps; s++) out.push(interpolateGreatCircle(a, b, s / steps));
  }
  out.push(points[points.length - 1]!);
  return out;
}

export function progressAlongPath(
  path: Coord[],
  at: Coord,
): { frac: number; remainingNm: number; totalNm: number } {
  if (path.length < 2) {
    const totalNm = 1;
    return { frac: 0, remainingNm: totalNm, totalNm };
  }
  let total = 0;
  const segs: { d: number; start: number }[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const d = haversineNm(path[i]!, path[i + 1]!);
    segs.push({ d, start: total });
    total += d;
  }
  total = Math.max(1, total);

  let bestD = Infinity;
  let along = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i]!;
    const b = path[i + 1]!;
    const d = segs[i]!.d || 0.01;
    const bearing = initialBearing(a, b);
    const toAt = haversineNm(a, at);
    const brgAt = initialBearing(a, at);
    let delta = Math.abs(brgAt - bearing) * RAD;
    if (delta > Math.PI) delta = 2 * Math.PI - delta;
    const proj = Math.max(0, Math.min(d, toAt * Math.cos(delta)));
    const on = destPoint(a, bearing, proj);
    const dist = haversineNm(on, at);
    if (dist < bestD) {
      bestD = dist;
      along = segs[i]!.start + proj;
    }
  }
  const frac = Math.max(0, Math.min(0.98, along / total));
  return { frac, remainingNm: total * (1 - frac), totalNm: total };
}

export function pathFracs(path: Coord[]): number[] {
  if (path.length === 0) return [];
  const dist = [0];
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += haversineNm(path[i - 1]!, path[i]!);
    dist.push(total);
  }
  const t = Math.max(1, total);
  return dist.map((d) => d / t);
}

/** Shortest distance from a point to the great-circle segment a→b, nautical miles. */
export function distanceToSegmentNm(p: Coord, a: Coord, b: Coord): number {
  const d = haversineNm(a, b);
  if (d < 0.8) return haversineNm(p, a);
  const bearing = initialBearing(a, b);
  const toP = haversineNm(a, p);
  const brgP = initialBearing(a, p);
  let delta = Math.abs(brgP - bearing) * RAD;
  if (delta > Math.PI) delta = 2 * Math.PI - delta;
  const proj = Math.max(0, Math.min(d, toP * Math.cos(delta)));
  return haversineNm(destPoint(a, bearing, proj), p);
}

export function formatNm(nm: number) {
  if (!Number.isFinite(nm)) return "—";
  if (nm < 10) return `${nm.toFixed(1)} nm`;
  return `${Math.round(nm)} nm`;
}

export function formatDuration(min: number) {
  const m = Math.max(0, Math.round(min));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

export function feetPretty(ft: number) {
  if (!Number.isFinite(ft) || ft <= 0) return "—";
  return `${Math.round(ft).toLocaleString("en-US")} ft`;
}

export function cToF(c: number) {
  return c * 1.8 + 32;
}

export function relativeBearing(heading: number, az: number) {
  return wrap360(az - heading);
}

export function wingSide(rel: number): "port" | "starboard" | "ahead" | "astern" {
  if (rel <= 35 || rel >= 325) return "ahead";
  if (rel >= 145 && rel <= 215) return "astern";
  if (rel < 180) return "starboard";
  return "port";
}

function solar(lat: number, lon: number, date: Date) {
  const d = date;
  const rad = RAD;
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const day = (d.getTime() - start) / 86400000;
  const gamma = (2 * Math.PI / 365) * (day - 1 + (d.getUTCHours() - 12) / 24);
  const eqTime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60;
  const trueSolar = (minutes + eqTime + 4 * lon) % 1440;
  let hourAngle = trueSolar / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;
  const latR = lat * rad;
  const ha = hourAngle * rad;
  const zenith = Math.acos(
    Math.sin(latR) * Math.sin(decl) + Math.cos(latR) * Math.cos(decl) * Math.cos(ha),
  );
  const el = 90 - zenith / rad;
  const azy = -Math.sin(ha);
  const azx = Math.tan(decl) * Math.cos(latR) - Math.sin(latR) * Math.cos(ha);
  const az = wrap360(Math.atan2(azy, azx) * DEG);
  return { az, el };
}

export function solarAzimuth(p: Coord, date: Date) {
  return solar(p.lat, p.lon, date).az;
}

export function solarElevation(p: Coord, date: Date) {
  return solar(p.lat, p.lon, date).el;
}

function ringContains(lat: number, lon: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i]![0]!;
    const yi = ring[i]![1]!;
    const xj = ring[j]![0]!;
    const yj = ring[j]![1]!;
    const hit = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

function polygonContains(lat: number, lon: number, coords: number[][][]) {
  if (!coords.length) return false;
  if (!ringContains(lat, lon, coords[0]!)) return false;
  for (let i = 1; i < coords.length; i++) {
    if (ringContains(lat, lon, coords[i]!)) return false;
  }
  return true;
}

export function pointInGeoJson(lat: number, lon: number, geom: GeoJson | null | undefined): boolean {
  if (!geom) return false;
  const t = geom.type;
  if (t === "Point") {
    const c = geom.coordinates as number[] | undefined;
    if (!c || c.length < 2) return false;
    return haversineNm({ lat, lon }, { lat: c[1]!, lon: c[0]! }) < 40;
  }
  if (t === "Polygon") {
    const c = geom.coordinates as number[][][] | undefined;
    return Array.isArray(c) ? polygonContains(lat, lon, c) : false;
  }
  if (t === "MultiPolygon") {
    const c = geom.coordinates as number[][][][] | undefined;
    if (!Array.isArray(c)) return false;
    return c.some((poly) => polygonContains(lat, lon, poly));
  }
  if (t === "GeometryCollection") {
    return (geom.geometries ?? []).some((g) => pointInGeoJson(lat, lon, g));
  }
  return false;
}

void NM_PER_DEG_LAT;

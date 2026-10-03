import { haversineNm, polylineLengthNm, progressAlongPath } from "./geo.ts";

export type RoutePoint = { lat: number; lon: number; label?: string | null };
export type RouteObservation = RoutePoint & { seenAt: number }; // milliseconds
export type RouteLeg = { origin: string; destination: string; date: string };
export type ObservedProgress = RouteObservation & { progress: number; totalNm: number; remainingNm: number };
export type RouteMemory = {
  leg: RouteLeg;
  filed: { waypoints: RoutePoint[]; observedAt: number; fingerprint: string } | null;
  track: RouteObservation[];
  lastObserved: ObservedProgress | null;
};

export function routeLeg(key: string, origin: string, destination: string): RouteLeg | null {
  const parts = key.replace(/^leg:(?:v1|unvalidated):/, "").split("|");
  const date = key.startsWith("leg:v1:") ? parts[1] : parts[3];
  const from = key.startsWith("leg:v1:") ? parts[2] : parts[1];
  const to = key.startsWith("leg:v1:") ? parts[3] : parts[2];
  return /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") && from === origin && to === destination
    ? { origin, destination, date } : null;
}
export const emptyRouteMemory = (leg: RouteLeg): RouteMemory => ({ leg, filed: null, track: [], lastObserved: null });
export const sameRouteLeg = (a: RouteLeg, b: RouteLeg) => a.origin === b.origin && a.destination === b.destination && a.date === b.date;
/** Compare facts, not object/JSONB property order, for the per-poll dirty check. */
export function routeMemoryEqual(a: RouteMemory, b: RouteMemory): boolean {
  const pointEqual = (x: RoutePoint, y: RoutePoint) => x.lat === y.lat && x.lon === y.lon && (x.label ?? null) === (y.label ?? null);
  const filedEqual = a.filed === b.filed || Boolean(a.filed && b.filed
    && a.filed.fingerprint === b.filed.fingerprint && a.filed.observedAt === b.filed.observedAt
    && a.filed.waypoints.length === b.filed.waypoints.length && a.filed.waypoints.every((p, i) => pointEqual(p, b.filed!.waypoints[i]!)));
  const observedEqual = a.lastObserved === b.lastObserved || Boolean(a.lastObserved && b.lastObserved
    && pointEqual(a.lastObserved, b.lastObserved) && a.lastObserved.seenAt === b.lastObserved.seenAt
    && a.lastObserved.progress === b.lastObserved.progress && a.lastObserved.totalNm === b.lastObserved.totalNm
    && a.lastObserved.remainingNm === b.lastObserved.remainingNm);
  return sameRouteLeg(a.leg, b.leg) && filedEqual && observedEqual && a.track.length === b.track.length
    && a.track.every((p, i) => pointEqual(p, b.track[i]!) && p.seenAt === b.track[i]!.seenAt);
}
const validPoint = (p: RoutePoint) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180;

/** Accept provider waypoints only for the resolved route. Direct spines never
 * enter this field. A later validated reroute replaces the entire filed plan. */
export function validatedFiledRoute(waypoints: RoutePoint[], origin: RoutePoint, destination: RoutePoint, validated: boolean, now: number): RouteMemory["filed"] {
  if (!validated || !Array.isArray(waypoints) || waypoints.length < 4 || waypoints.length > 512 || !waypoints.every(validPoint)) return null;
  const points = [origin, ...waypoints, destination];
  const direct = haversineNm(origin, destination);
  if (direct < 1 || polylineLengthNm(points) > direct * 3 + 100) return null;
  const clean = waypoints.map(p => ({ lat: p.lat, lon: p.lon, ...(p.label ? { label: String(p.label).slice(0, 40) } : {}) }));
  return { waypoints: clean, observedAt: now, fingerprint: clean.map(p => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join(";") };
}

/** Keep real observations in time order; bound storage while preserving both
 * endpoints. A failed/partial trace cannot erase an earlier observed sector. */
export function mergeObservedTrack(a: RouteObservation[], b: RouteObservation[]): RouteObservation[] {
  const byTime = new Map<number, RouteObservation>();
  for (const p of [...a, ...b]) if (validPoint(p) && Number.isFinite(p.seenAt) && p.seenAt > 0)
    byTime.set(p.seenAt, { lat: p.lat, lon: p.lon, seenAt: p.seenAt });
  const sorted = [...byTime.values()].sort((x, y) => x.seenAt - y.seenAt);
  const spaced = sorted.filter((p, i) => i === 0 || i === sorted.length - 1 || haversineNm(sorted[i - 1]!, p) >= 0.5);
  if (spaced.length <= 512) return spaced;
  return Array.from({ length: 512 }, (_, i) => spaced[Math.round(i * (spaced.length - 1) / 511)]!);
}

export function mergeRouteMemory(previous: RouteMemory, next: RouteMemory): RouteMemory {
  // The caller/store must start a new row for a new date/route/diversion.
  if (!sameRouteLeg(previous.leg, next.leg)) return next;
  const filed = next.filed && (!previous.filed || (next.filed.fingerprint !== previous.filed.fingerprint && next.filed.observedAt > previous.filed.observedAt))
    ? next.filed : previous.filed;
  const lastObserved = next.lastObserved && (!previous.lastObserved || next.lastObserved.seenAt > previous.lastObserved.seenAt)
    ? next.lastObserved : previous.lastObserved;
  return { leg: next.leg, filed, track: mergeObservedTrack(previous.track, next.track), lastObserved };
}

export function freshRouteObservation(live: (RoutePoint & { seenAt?: number | null; seenSec?: number | null; extrapolated?: boolean; onGround?: boolean }) | null, now = Date.now()): RouteObservation | null {
  if (!live || !validPoint(live) || live.extrapolated || live.onGround) return null;
  const seenAt = Number.isFinite(live.seenAt) && live.seenAt! > 0 ? live.seenAt! * 1000
    : Number.isFinite(live.seenSec) && live.seenSec! >= 0 ? now - live.seenSec! * 1000 : null;
  return seenAt != null && now >= seenAt - 2000 && now - seenAt <= 90_000
    ? { lat: live.lat, lon: live.lon, seenAt } : null;
}

/** Preserve last observed progress through coverage gaps; never turn elapsed
 * time into a position. A new real fix resumes projection on the held path. */
export function routeProgress(path: RoutePoint[], memory: RouteMemory | null, observation: RouteObservation | null, airborne: boolean, landed: boolean) {
  const totalNm = Math.max(1, polylineLengthNm(path));
  if (landed) return { progress: 1, totalNm, remainingNm: 0, source: "landed" as const, observedAt: null };
  if (observation) {
    const along = progressAlongPath(path, observation);
    return { progress: along.frac, totalNm, remainingNm: along.remainingNm, source: "observed" as const, observedAt: observation.seenAt };
  }
  if (airborne && memory?.lastObserved) {
    const last = memory.lastObserved;
    return { progress: last.progress, totalNm: last.totalNm, remainingNm: last.remainingNm, source: "last_known" as const, observedAt: last.seenAt };
  }
  return { progress: 0, totalNm, remainingNm: totalNm, source: "unknown" as const, observedAt: null };
}

import { haversineNm } from "./geo.ts";

export type PushTracePoint = {
  lat: number; lon: number;
  t?: number | null; seenAt?: number | null; // Absolute seconds.
  ground?: boolean | null; onGround?: boolean | null;
  alt?: number | null; altFt?: number | null;
};
export type PushTraceScope<T extends PushTracePoint = PushTracePoint> = {
  points: T[];
  notBeforeUnix: number | null;
  boundaryReason: "return_to_origin" | "trace_gap" | "anchor_segment" | null;
};
type Origin = { lat: number; lon: number; elevationFt?: number | null };
type Options = { radiusNm?: number; maxGapSec?: number; anchorUnix?: number | null; nowUnix?: number };
type ScopeBoundary = Pick<PushTraceScope, "notBeforeUnix">;
type Park = { t?: number | null; seenAt?: number | null; at?: number | null };
type Latch = { unix: number; source?: string | null };

const unixOf = (point: PushTracePoint | Park) => point.t ?? point.seenAt ?? NaN;
const validPoint = (point: PushTracePoint) => Number.isFinite(unixOf(point)) && unixOf(point) > 0
  && Number.isFinite(point.lat) && Math.abs(point.lat) <= 90
  && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180;

/** Keep a tail's latest observed visit to this origin. Inspect the complete
 * trace first: discarding airborne/outside-airport points would hide a prior
 * departure and return. Unlike the route-distance boundary, preserve the
 * first point of the new visit, so the parked baseline and push stay intact.
 * A trace beginning midway through one visit establishes no new lower bound.
 * A flight-specific provider actual or validated current-flight observation
 * can associate a disconnected trace segment with this flight even when that
 * segment has no surface samples. Schedules, estimates, and the current wall
 * clock must not be supplied as that anchor.
 */
export function currentOriginPushTraceScope<T extends PushTracePoint>(
  points: readonly T[] | null | undefined,
  origin: Origin,
  options: Options = {},
): PushTraceScope<T> {
  const nowUnix = options.nowUnix ?? Date.now() / 1000;
  let ordered = (points ?? []).filter(point => validPoint(point) && unixOf(point) <= nowUnix).slice().sort((a, b) => unixOf(a) - unixOf(b));
  const radiusNm = options.radiusNm ?? 8;
  const maxGapSec = options.maxGapSec ?? 45 * 60;
  const fieldFt = origin.elevationFt ?? 0;
  let notBeforeUnix: number | null = null;
  let boundaryReason: PushTraceScope["boundaryReason"] = null;
  if (options.anchorUnix != null && Number.isFinite(options.anchorUnix) && options.anchorUnix > 0 && options.anchorUnix <= nowUnix && ordered.length) {
    const segments: T[][] = [];
    for (const point of ordered) {
      const current = segments[segments.length - 1];
      if (!current || unixOf(point) - unixOf(current[current.length - 1]!) > maxGapSec) segments.push([point]);
      else current.push(point);
    }
    const distanceFromAnchor = (segment: T[]) => Math.max(
      unixOf(segment[0]!) - options.anchorUnix!, options.anchorUnix! - unixOf(segment[segment.length - 1]!), 0,
    );
    let selected = 0;
    for (let index = 1; index < segments.length; index++) {
      if (distanceFromAnchor(segments[index]!) <= distanceFromAnchor(segments[selected]!)) selected = index;
    }
    // "Nearest" does not establish association across an hours-long outage.
    // Missing current history cannot reconstruct push or prove a new visit.
    if (distanceFromAnchor(segments[selected]!) > maxGapSec) {
      return { points: [], notBeforeUnix: null, boundaryReason: null };
    }
    ordered = segments[selected]!;
    if (selected > 0) {
      // The gap proves only that the earlier segment is unrelated. The
      // current trace may begin after a real push already latched elsewhere;
      // do not revoke that push merely because its trace samples are absent.
      const excluded = segments[selected - 1]!;
      notBeforeUnix = unixOf(excluded[excluded.length - 1]!) + 0.001;
      boundaryReason = "anchor_segment";
    }
  }
  let observedOrigin = false;
  let departed = false;
  for (const point of ordered) {
    const nearOrigin = haversineNm(point, origin) < radiusNm;
    const groundFlag = point.ground ?? point.onGround;
    const altitude = point.alt ?? point.altFt;
    const surface = groundFlag === true || (groundFlag == null && altitude != null && altitude <= fieldFt + 250);
    const airborne = groundFlag !== true && altitude != null && altitude > fieldFt + 400;
    if (nearOrigin && surface) {
      if (observedOrigin && departed) {
        notBeforeUnix = unixOf(point);
        boundaryReason = "return_to_origin";
      }
      observedOrigin = true;
      departed = false;
    } else if (observedOrigin && (!nearOrigin || airborne)) {
      departed = true;
    }
  }
  return {
    points: notBeforeUnix == null ? ordered : ordered.filter(point => unixOf(point) >= notBeforeUnix),
    notBeforeUnix,
    boundaryReason,
  };
}

/** Park observations use milliseconds in the in-memory stand cache. */
export function pushParkWithinScope<T extends Park>(park: T | null | undefined, scope: ScopeBoundary): T | null {
  if (!park) return null;
  if (scope.notBeforeUnix == null) return park;
  const parkedUnix = park.t ?? park.seenAt ?? (park.at != null ? park.at / 1000 : NaN);
  return Number.isFinite(parkedUnix) && parkedUnix >= scope.notBeforeUnix ? park : null;
}

/** Correct already persisted physical evidence from an earlier visit. A
 * provider actual and a contemporaneous same-leg live detection are independent
 * proof; sparse tail history must not revoke either.
 */
export function pushLatchWithinScope<T extends Latch>(latch: T | null | undefined, scope: ScopeBoundary): T | null {
  if (!latch) return null;
  if ((latch.source === "provider_actual" || latch.source === "live_detected") || scope.notBeforeUnix == null) return latch;
  return Number.isFinite(latch.unix) && latch.unix >= scope.notBeforeUnix ? latch : null;
}

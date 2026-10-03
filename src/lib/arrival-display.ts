import { arrivalFuturePoints } from "./arrival-path.ts";
import type { ArrivalProjectionState } from "./arrival-projection-state.ts";
import { polylineLengthNm } from "./geo.ts";
import type { RouteObservation, RoutePoint } from "./route-memory.ts";

/** Display a durable plan even when this poll has no reliable fix. Historical
 * anchors are geometry only; callers never promote them to live aircraft. */
export function displayArrivalProjection(state: ArrivalProjectionState, args: {
  observation: RouteObservation | null;
  live: (RoutePoint & { track?: number | null; onGround?: boolean }) | null;
  lastObserved: RouteObservation | null;
  landed: boolean;
}) {
  if (args.landed || args.live?.onGround || !state.active || !state.kind) return null;
  const anchor = args.observation ?? args.lastObserved ?? state.cursorPoint;
  if (!anchor) return null;
  const future = args.observation && args.live ? arrivalFuturePoints(state.points, args.live) : state.points;
  const points = [{ lat: anchor.lat, lon: anchor.lon }, ...future];
  return { points, lengthNm: polylineLengthNm(points), kind: state.kind,
    stale: !args.observation,
    geometrySource: args.observation ? "observed_fix" as const : args.lastObserved ? "last_known_fix" as const : "held_cursor" as const };
}

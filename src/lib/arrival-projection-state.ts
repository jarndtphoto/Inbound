import { arrivalPattern, canProjectArrival } from "./arrival-pattern.ts";
import { distanceToSegmentNm, polylineLengthNm, type Coord } from "./geo.ts";
import { runwayCoordinates, type ExpectedArrivalRunway } from "./arrival-runway.ts";

export type ArrivalFix = Coord & { track?: number | null; onGround?: boolean; extrapolated?: boolean; seenSec?: number | null; phase?: string; vertFpm?: number | null };
export type ArrivalProjectionState = {
  runway: ExpectedArrivalRunway | null;
  side: number | null;
  startedAt: number | null;
  active: boolean;
  points: Coord[];
  kind: "straight-in" | "downwind-base" | null;
  offPathStreak: number;
  lastFixAt: number;
};
export const emptyArrivalState = (): ArrivalProjectionState => ({ runway: null, side: null, startedAt: null, active: false, points: [], kind: null, offPathStreak: 0, lastFixAt: 0 });

function nearestLeg(point: Coord, points: Coord[]) {
  let distance = Infinity, index = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const d = distanceToSegmentNm(point, points[i], points[i + 1]);
    if (d < distance) { distance = d; index = i; }
  }
  return { distance, index };
}
const patternFromState = (state: ArrivalProjectionState) => state.active && state.kind && state.points.length >= 2
  ? { points: state.points, kind: state.kind, side: state.side!, lengthNm: polylineLengthNm(state.points) } : null;

/** Display-only state machine. Entry is strict; continuation is independent
 * of phase/vertical speed. The held remaining path is consumed through base
 * and final instead of regenerating a new U-loop from every observed track. */
export function updateArrivalProjection(previous: ArrivalProjectionState, input: {
  live: ArrivalFix | null; dest: Coord; landed: boolean;
  runway: ExpectedArrivalRunway | null; approachEvidence?: boolean; now: number;
}) {
  const { live, dest, landed, now } = input;
  let state = structuredClone(previous);
  const runwayChanged = !!input.runway && input.runway.runway !== state.runway?.runway;
  const wasActive = state.active;
  if (runwayChanged) state = { ...emptyArrivalState(), runway: input.runway };
  else if (input.runway) state.runway = input.runway;
  const result = (reason: string) => ({ state, pattern: patternFromState(state), reason });
  if (landed || live?.onGround) { state.active = false; return result("landed"); }
  if (!state.runway) return result("no-runway");
  const fresh = !!live && !live.extrapolated && (live.seenSec ?? Infinity) <= 60;
  const recent = !!live && (live.seenSec ?? Infinity) <= 120;
  // Missing/stale observations cannot be evidence that a known pattern is wrong.
  if (state.active && (!fresh || !live)) return result(recent ? "held-recent-fix" : "held-no-reliable-fix");
  if (!live) return result("no-position");
  const fixAt = now - (live.seenSec ?? 0) * 1000;
  if (state.active && fixAt <= state.lastFixAt) return result("held-older-fix");
  const nearest = nearestLeg(live, state.points);
  if (state.active) {
    state.lastFixAt = fixAt;
    state.offPathStreak = nearest.distance > 8 ? state.offPathStreak + 1 : 0;
    if (state.offPathStreak >= 2) { state.active = false; return result("off-path-twice"); }
    if (nearest.distance > 8) return result("held-first-off-path");
    // Extend an outward downwind if ATC sends it beyond our estimated base.
    // Keep the same side, but never redraw a U after the aircraft turns base.
    const local = runwayCoordinates(live, { ...state.runway.threshold, ident: state.runway.runway, heading: state.runway.heading });
    const turnDelta = live.track == null ? 0 : Math.abs(((live.track - state.runway.heading + 540) % 360) - 180);
    const farthestX = Math.min(...state.points.map(p => runwayCoordinates(p, { ...state.runway!.threshold, ident: state.runway!.runway, heading: state.runway!.heading }).x));
    if (state.kind === "downwind-base" && turnDelta >= 120 && local.x < farthestX + 1) {
      state.points = arrivalPattern(live, state.runway, state.side ?? undefined).points;
    } else {
      state.points = [{ lat: live.lat, lon: live.lon }, ...state.points.slice(nearest.index + 1)];
    }
    return result("continued");
  }
  // Once rejected, do not restart the same wrong projection on the next poll.
  if (state.offPathStreak >= 2 && nearest.distance > 8) return result("off-path-rejected");
  if (!canProjectArrival(live, dest, false, input.approachEvidence) && !(wasActive && runwayChanged && fresh)) return result("entry-gate");
  const pattern = arrivalPattern(live, state.runway, state.side ?? undefined);
  state = { ...state, active: true, startedAt: now, side: pattern.side, points: pattern.points.map(p => ({ lat: p.lat, lon: p.lon })), kind: pattern.kind, offPathStreak: 0, lastFixAt: fixAt };
  return result(runwayChanged && wasActive ? "runway-changed" : "started");
}

import { arrivalPattern, canProjectArrival } from "./arrival-pattern.ts";
import { haversineNm, polylineLengthNm, type Coord } from "./geo.ts";
import { ARRIVAL_OFF_PATH_NM, arrivalPointBehind, projectArrivalPath } from "./arrival-path.ts";
import { runwayCoordinates, type ExpectedArrivalRunway } from "./arrival-runway.ts";

export type ArrivalFix = Coord & { track?: number | null; onGround?: boolean; extrapolated?: boolean; seenSec?: number | null; seenAt?: number | null; phase?: string; vertFpm?: number | null; altFt?: number | null };
export type ArrivalProjectionState = {
  runway: ExpectedArrivalRunway | null;
  side: number | null;
  startedAt: number | null;
  active: boolean;
  /** Planned future points only. Never prepend an observed fix here. */
  points: Coord[];
  pointAlongNm: number[];
  cursorNm: number;
  /** Perpendicular foot on planned geometry, not the live aircraft position. */
  cursorPoint: Coord | null;
  pathVersion: 2;
  kind: "straight-in" | "downwind-base" | null;
  offPathStreak: number;
  lastFixAt: number;
  lastAltitudeFt: number | null;
  lastAltitudeAt: number;
};
export const emptyArrivalState = (): ArrivalProjectionState => ({ runway: null, side: null, startedAt: null, active: false, points: [], pointAlongNm: [], cursorNm: 0, cursorPoint: null, pathVersion: 2, kind: null, offPathStreak: 0, lastFixAt: 0, lastAltitudeFt: null, lastAltitudeAt: 0 });
export type ArrivalProjectionInput = {
  live: ArrivalFix | null; dest: Coord & { elevationFt?: number | null }; landed: boolean;
  runway: ExpectedArrivalRunway | null; approachEvidence?: boolean; now: number;
};
const fixTime = (live: ArrivalFix, now: number) => Number.isFinite(live.seenAt) ? live.seenAt! * 1000 : now - (live.seenSec ?? 0) * 1000;

/** Arrival-only evidence. Do not feed the derived rate into phase/stage logic. */
export function arrivalEntryEvidence(previous: ArrivalProjectionState, input: Omit<ArrivalProjectionInput, "runway">) {
  const { live, dest, landed, approachEvidence, now } = input;
  const fresh = !!live && !live.extrapolated && (live.seenSec ?? Infinity) <= 60;
  const fixAt = live ? fixTime(live, now) : 0;
  const elapsedMs = fixAt - (previous.lastAltitudeAt ?? 0);
  const derivedVertFpm = fresh && Number.isFinite(live?.altFt) && Number.isFinite(previous.lastAltitudeFt)
    && elapsedMs >= 5_000 && elapsedMs <= 120_000
    ? (live!.altFt! - previous.lastAltitudeFt!) * 60_000 / elapsedMs : null;
  const sourceVertFpm = Number.isFinite(live?.vertFpm) ? live!.vertFpm! : null;
  return {
    fresh, fixAt, derivedVertFpm,
    vertFpm: sourceVertFpm ?? derivedVertFpm,
    verticalRateSource: sourceVertFpm != null ? "provider" : derivedVertFpm != null ? "altitude-delta" : null,
    entryGate: canProjectArrival(live, dest, landed, approachEvidence, derivedVertFpm),
  };
}

function installPlan(state: ArrivalProjectionState, points: Coord[], baseNm = state.cursorNm) {
  state.cursorNm = baseNm;
  state.cursorPoint = points[0] ? { lat: points[0].lat, lon: points[0].lon } : null;
  let along = baseNm;
  state.pointAlongNm = points.slice(1).map((p, i) => (along += haversineNm(points[i], p)));
  state.points = points.slice(1).map(p => ({ lat: p.lat, lon: p.lon }));
  state.pathVersion = 2;
}

function normalizeState(previous: ArrivalProjectionState) {
  const state = { ...emptyArrivalState(), ...structuredClone(previous) };
  // Upgrade old jsonb rows without losing runway, side, or activation. The old
  // leading live fix is removed; subsequent observations never replace it.
  if (previous.pathVersion !== 2 || previous.pointAlongNm?.length !== previous.points.length) installPlan(state, previous.points, 0);
  return state;
}

function consume(state: ArrivalProjectionState, live: ArrivalFix) {
  if (!state.cursorPoint) return Infinity;
  const projection = projectArrivalPath(live, state.cursorPoint, state.points, state.pointAlongNm, state.cursorNm);
  if (projection.distanceNm > ARRIVAL_OFF_PATH_NM) return projection.distanceNm;
  if (projection.alongNm > state.cursorNm) { state.cursorNm = projection.alongNm; state.cursorPoint = projection.point; }
  while (state.points.length && state.pointAlongNm[0] <= state.cursorNm + 1e-6) {
    state.points.shift(); state.pointAlongNm.shift();
  }
  // A heading safety net consumes passed points rather than drawing back to them.
  while (state.points.length && arrivalPointBehind(live, state.points[0])) {
    state.cursorNm = Math.max(state.cursorNm, state.pointAlongNm.shift()!);
    state.cursorPoint = state.points.shift()!;
  }
  return projection.distanceNm;
}

const patternFromState = (state: ArrivalProjectionState) => state.active && state.kind && state.points.length && state.cursorPoint
  ? { points: state.points, kind: state.kind, side: state.side!, lengthNm: polylineLengthNm([state.cursorPoint, ...state.points]) } : null;

/** Entry is strict; continuation is independent of phase/vertical speed.
 * Durable cursor and planned geometry consume base/final across cold instances. */
export function updateArrivalProjection(previous: ArrivalProjectionState, input: ArrivalProjectionInput) {
  const { live, landed, now } = input;
  let state = normalizeState(previous);
  const evidence = arrivalEntryEvidence(state, input);
  if (evidence.fresh && Number.isFinite(live?.altFt) && evidence.fixAt > state.lastAltitudeAt) {
    state.lastAltitudeFt = live!.altFt!; state.lastAltitudeAt = evidence.fixAt;
  }
  const runwayChanged = !!input.runway && input.runway.runway !== state.runway?.runway;
  const wasActive = state.active;
  if (runwayChanged) state = { ...emptyArrivalState(), runway: input.runway, lastAltitudeFt: state.lastAltitudeFt, lastAltitudeAt: state.lastAltitudeAt };
  else if (input.runway) state.runway = input.runway;
  const result = (reason: string) => ({ state, pattern: patternFromState(state), reason, ...evidence });
  if (landed || live?.onGround) { state.active = false; return result("landed"); }
  if (!state.runway) return result("no-runway");
  const recent = !!live && (live.seenSec ?? Infinity) <= 120;
  if (state.active && (!evidence.fresh || !live)) return result(recent ? "held-recent-fix" : "held-no-reliable-fix");
  if (!live) return result("no-position");
  if (state.active && evidence.fixAt <= state.lastFixAt) return result("held-older-fix");
  if (state.active) {
    state.lastFixAt = evidence.fixAt;
    const offPathNm = consume(state, live);
    state.offPathStreak = offPathNm > ARRIVAL_OFF_PATH_NM ? state.offPathStreak + 1 : 0;
    if (state.offPathStreak >= 2) { state.active = false; return result("off-path-twice"); }
    if (offPathNm > ARRIVAL_OFF_PATH_NM) return result("held-first-off-path");
    const end = { ...state.runway.threshold, ident: state.runway.runway, heading: state.runway.heading };
    const local = runwayCoordinates(live, end);
    const turnDelta = live.track == null ? 0 : Math.abs(((live.track - state.runway.heading + 540) % 360) - 180);
    const farthestX = Math.min(...state.points.map(p => runwayCoordinates(p, end).x));
    if (state.kind === "downwind-base" && turnDelta >= 120 && local.x < farthestX + 1) {
      installPlan(state, arrivalPattern(live, state.runway, state.side ?? undefined).points);
      consume(state, live);
    }
    return result("continued");
  }
  if (state.offPathStreak >= 2 && state.cursorPoint && projectArrivalPath(live, state.cursorPoint, state.points, state.pointAlongNm, state.cursorNm).distanceNm > ARRIVAL_OFF_PATH_NM) return result("off-path-rejected");
  if (!evidence.entryGate && !(wasActive && runwayChanged && evidence.fresh)) return result("entry-gate");
  const pattern = arrivalPattern(live, state.runway, state.side ?? undefined);
  state = { ...state, active: true, startedAt: now, side: pattern.side, kind: pattern.kind, offPathStreak: 0, lastFixAt: evidence.fixAt };
  installPlan(state, pattern.points, 0);
  consume(state, live);
  return result(runwayChanged && wasActive ? "runway-changed" : "started");
}

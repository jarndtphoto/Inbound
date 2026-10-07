import { destPoint } from "../geo";
import { validCoordinate } from "../plugin-v1/geography";
import { NEARBY_POLICY, observationFreshness, type AcceptedNearbyObservation, type Freshness } from "./model";

export type NearbyMotionAnchor = Pick<AcceptedNearbyObservation,
  "latitude" | "longitude" | "altitudeFt" | "groundspeedKt" | "groundTrackDeg" |
  "observedAt" | "onGround" | "positionKind" | "acceptedPosition"
>;

/** Derived display state only; this never becomes an accepted observation. */
export type NearbyDisplayPosition = {
  latitude: number;
  longitude: number;
  altitudeFt: number | null;
  kind: "accepted" | "extrapolated";
  extrapolatedSeconds: number;
  stopped: boolean;
  freshness: Freshness;
};

/**
 * Stateless prediction from one accepted fix. A replacement fix always starts
 * a new trajectory, even when it disagrees substantially with the old display.
 * Already-projected positions cannot safely be advanced again from observedAt.
 */
export function deriveNearbyDisplayPosition(anchor: NearbyMotionAnchor, nowMs: number): NearbyDisplayPosition | null {
  const observedAtMs = Date.parse(anchor.observedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(observedAtMs) || !validCoordinate(anchor)
    || observedAtMs > nowMs + 1_000) return null;
  const freshness = observationFreshness(anchor.observedAt, nowMs);
  const elapsedMs = Math.max(0, nowMs - observedAtMs);
  const limitMs = Math.min(NEARBY_POLICY.maxExtrapolationMs, NEARBY_POLICY.freshMs);
  const validMotion = anchor.acceptedPosition && anchor.positionKind === "observed" && anchor.onGround === false
    && anchor.groundspeedKt !== null && Number.isFinite(anchor.groundspeedKt) && anchor.groundspeedKt > 0 && anchor.groundspeedKt <= 1_500
    && anchor.groundTrackDeg !== null && Number.isFinite(anchor.groundTrackDeg) && anchor.groundTrackDeg >= 0 && anchor.groundTrackDeg < 360;
  const extrapolatedSeconds = validMotion ? Math.min(elapsedMs, limitMs) / 1_000 : 0;
  const position = extrapolatedSeconds > 0
    ? destPoint({ lat: anchor.latitude, lon: anchor.longitude }, anchor.groundTrackDeg!, anchor.groundspeedKt! * extrapolatedSeconds / 3_600)
    : { lat: anchor.latitude, lon: anchor.longitude };
  return {
    latitude: position.lat,
    longitude: position.lon,
    // Altitude is accepted telemetry. Missing vertical rate is never invented.
    altitudeFt: anchor.altitudeFt,
    kind: extrapolatedSeconds > 0 ? "extrapolated" : "accepted",
    extrapolatedSeconds,
    stopped: !validMotion || elapsedMs >= limitMs,
    freshness,
  };
}

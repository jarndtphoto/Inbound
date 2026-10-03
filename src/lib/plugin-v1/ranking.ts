import { airlineOf, isVehicleType } from "../aircraft";
import { AIRPORT_BY_ICAO } from "../airports";
import { parseFlightQuery } from "../flight-parse";
import { phaseOf } from "../traffic-motion";
import { DisplayIdentSchema, IataSchema, MOTION_LABELS, OpaqueIdSchema, ServiceDateSchema, TimestampSchema, type InboundNearbyFlight, type ResolvedAreaV1 } from "./contracts";
import { validCoordinate, viewProximity } from "./geography";

/** Private, already-accepted Inbound inputs. Not a provider adapter or public DTO. */
export type NearbyCandidate = {
  cardId: string;
  privateAircraftIdentity: string;
  sessionKey: string;
  observedCallsign: string | null;
  registration: string | null;
  latitude: number; longitude: number;
  altitudeFt: number | null; groundspeedKt: number | null; verticalRateFpm: number | null;
  onGround: boolean | null;
  observedAt: string | null;
  positionKind: "observed" | "extrapolated" | "synthetic";
  /** Existing fusion must have accepted any extrapolation within its own limits. */
  acceptedPosition: boolean;
  identityConflict: boolean;
  typeCode: string | null; category: string | null; operator: string | null;
  interesting: boolean;
  route: InboundNearbyFlight["route"];
  /** Already-validated dated evidence; ranking never performs a flight lookup. */
  datedBinding: { sessionKey: string; observedCallsign: string; serviceDate: string; confirmedAt: string } | null;
};
export type RankedCandidate = {
  candidate: NearbyCandidate;
  displayIdent: string;
  score: number;
  distanceNm: number;
  bearingDeg: number;
  observedAtMs: number;
  ageSeconds: number;
  motion: InboundNearbyFlight["motion"];
  route: InboundNearbyFlight["route"];
};
export function verticalTrend(rate: number | null): InboundNearbyFlight["motion"]["verticalTrend"] {
  if (rate === null || !Number.isFinite(rate)) return "unknown";
  return rate >= 250 ? "rising" : rate <= -250 ? "falling" : "level";
}
function usableIdent(s: string | null) { return s !== null && DisplayIdentSchema.safeParse(s).success ? s : null; }

/** Expired/mismatched confirmation is only a hint, never airport association. */
export function currentRoute(c: NearbyCandidate, nowMs: number): InboundNearbyFlight["route"] {
  const originIata = IataSchema.safeParse(c.route.originIata).success ? c.route.originIata : null;
  const destinationIata = IataSchema.safeParse(c.route.destinationIata).success ? c.route.destinationIata : null;
  const checkedAt = TimestampSchema.safeParse(c.route.checkedAt).success ? c.route.checkedAt : null;
  if ((!originIata && !destinationIata) || !checkedAt || Date.parse(checkedAt) > nowMs + 1000) return { originIata: null, destinationIata: null, verification: "unknown", checkedAt: null };
  const b = c.datedBinding;
  const confirmed = c.route.verification === "confirmed" && !!originIata && !!destinationIata && b !== null
    && b.sessionKey === c.sessionKey && b.observedCallsign === c.observedCallsign
    && ServiceDateSchema.safeParse(b.serviceDate).success && TimestampSchema.safeParse(b.confirmedAt).success
    && nowMs - Date.parse(b.confirmedAt) >= -1000 && nowMs - Date.parse(b.confirmedAt) <= 120000;
  return { originIata, destinationIata, verification: confirmed ? "confirmed" : "hint", checkedAt };
}
export function compareRank(a: RankedCandidate, b: RankedCandidate): number {
  return b.score - a.score || a.distanceNm - b.distanceNm || b.observedAtMs - a.observedAtMs
    || (a.candidate.cardId < b.candidate.cardId ? -1 : a.candidate.cardId > b.candidate.cardId ? 1 : 0);
}
export function scoreCandidate(c: NearbyCandidate, area: ResolvedAreaV1, nowMs: number): RankedCandidate | null {
  if (!Number.isFinite(nowMs) || !c.acceptedPosition || (c.positionKind !== "observed" && c.positionKind !== "extrapolated") || c.identityConflict
    || !c.privateAircraftIdentity || !c.sessionKey || !OpaqueIdSchema.safeParse(c.cardId).success || !validCoordinate(c)) return null;
  if (isVehicleType(c.typeCode, c.category, c.operator) || c.onGround === true
    || c.altitudeFt === null || !Number.isFinite(c.altitudeFt) || c.altitudeFt < 500 || c.altitudeFt > 200000
    || c.groundspeedKt === null || !Number.isFinite(c.groundspeedKt) || c.groundspeedKt < 40
    || c.verticalRateFpm !== null && !Number.isFinite(c.verticalRateFpm)
    || !TimestampSchema.safeParse(c.observedAt).success) return null;
  const observedAtMs = Date.parse(c.observedAt!);
  const elapsed = (nowMs - observedAtMs) / 1000;
  if (elapsed < -1 || elapsed > 45) return null;
  const ageSeconds = Math.max(0, elapsed);
  const displayIdent = usableIdent(c.observedCallsign) ?? usableIdent(c.registration);
  if (!displayIdent) return null;
  const { distanceNm, bearingDeg } = viewProximity(area, c);
  if (distanceNm >= area.radiusNm) return null;
  const phase = phaseOf({ onGround: false, gsKt: c.groundspeedKt, altFt: c.altitudeFt, vertFpm: Number.isFinite(c.verticalRateFpm) ? c.verticalRateFpm : null });
  const route = currentRoute(c, nowMs);
  const parsed = c.observedCallsign ? parseFlightQuery(c.observedCallsign) : null;
  const recognizableAirline = !!parsed && parsed.registration === null && airlineOf(parsed.callsign) !== null;
  const associated = route.verification === "confirmed" && area.associatedAirports.some(code => {
    const iata = AIRPORT_BY_ICAO[code]?.iata;
    return iata && (route.originIata === iata || route.destinationIata === iata);
  });
  const score = Math.max(0, 38 - 2 * Math.floor(distanceNm / 2))
    + (recognizableAirline ? 20 : 0)
    + (route.verification === "confirmed" ? 15 : route.verification === "hint" ? 5 : 0)
    + (["climb", "descent", "approach"].includes(phase) ? 20 : 0)
    + (c.altitudeFt <= 12000 ? 10 : 0)
    + (associated ? 5 : 0) + (c.interesting ? 5 : 0)
    + (c.positionKind === "observed" ? 5 : 0)
    + (ageSeconds <= 20 ? 10 : ageSeconds <= 30 ? 5 : 0);
  return { candidate: c, displayIdent, score, distanceNm, bearingDeg, observedAtMs, ageSeconds, route, motion: { phase, label: MOTION_LABELS[phase], verticalTrend: verticalTrend(c.verticalRateFpm) } };
}
export function rankNearbyCandidates(candidates: readonly NearbyCandidate[], area: ResolvedAreaV1, nowMs: number): RankedCandidate[] {
  // Deterministic deduplication by private aircraft identity. Conflicting sessions
  // or a reused public ID are rejected rather than merging different aircraft.
  const identities = new Map<string, Set<string>>();
  const cardOwners = new Map<string, Set<string>>();
  for (const c of candidates) {
    const set = identities.get(c.privateAircraftIdentity) ?? new Set<string>();
    set.add(`${c.sessionKey}|${c.observedCallsign ?? ""}|${c.registration ?? ""}`);
    identities.set(c.privateAircraftIdentity, set);
    const owners = cardOwners.get(c.cardId) ?? new Set<string>(); owners.add(c.privateAircraftIdentity); cardOwners.set(c.cardId, owners);
  }
  const best = new Map<string, RankedCandidate>();
  for (const c of candidates) {
    if ((identities.get(c.privateAircraftIdentity)?.size ?? 0) > 1 || (cardOwners.get(c.cardId)?.size ?? 0) > 1) continue;
    const ranked = scoreCandidate(c, area, nowMs);
    if (!ranked) continue;
    const old = best.get(c.privateAircraftIdentity);
    // Freshest accepted fix wins, regardless of its optional route score.
    if (!old || ranked.observedAtMs > old.observedAtMs || ranked.observedAtMs === old.observedAtMs && compareRank(ranked, old) < 0) best.set(c.privateAircraftIdentity, ranked);
  }
  return [...best.values()].sort(compareRank);
}

import { airlineOf, isVehicleType } from "../aircraft";
import { AIRPORT_BY_ICAO, AIRPORT_BY_IATA } from "../airports";
import { phaseOf, type PhaseSample } from "../aircraft-phase";
import { parseFlightQuery } from "../flight-parse";
import { DisplayIdentSchema, IataSchema, MOTION_LABELS, OpaqueIdSchema, ServiceDateSchema, TimestampSchema, type InboundNearbyFlight, type ResolvedAreaV1 } from "./contracts";
import { validCoordinate, viewProximity } from "./geography";

/** Compact private evidence in the current snapshot, never a public DTO/history log.
 * Times use seconds, matching the shared Inbound phase classifier. */
export type NearbyPhaseSample = [seenAt: number, altFt: number | null, vertFpm: number | null, onGround: boolean | null, lat: number, lon: number];

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
  /** Prior observed fixes from this aircraft session, bounded by the private store. */
  phaseEvidence?: NearbyPhaseSample[];
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
  // Instantaneous display measurement only. Flight phase instead uses Inbound's
  // >=30-second evidence and +/-300 fpm threshold in aircraft-phase.ts.
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
  const route = currentRoute(c, nowMs);
  const history: PhaseSample[] = (c.phaseEvidence ?? []).map(([seenAt, altFt, vertFpm, onGround, lat, lon]) => ({ seenAt, altFt, vertFpm, onGround, lat, lon }));
  // Area proximity does not establish an arrival/departure. Only an accepted
  // dated route supplies airport context; unknown/hint routes remain neutral.
  const origin = route.verification === "confirmed" && route.originIata ? AIRPORT_BY_IATA[route.originIata] : undefined;
  const dest = route.verification === "confirmed" && route.destinationIata ? AIRPORT_BY_IATA[route.destinationIata] : undefined;
  const phase = phaseOf({ onGround: false, gsKt: c.groundspeedKt, altFt: c.altitudeFt, vertFpm: c.verticalRateFpm,
    lat: c.latitude, lon: c.longitude, seenAt: observedAtMs / 1000, seenSec: ageSeconds, extrapolated: c.positionKind === "extrapolated" }, { origin, dest, history });
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

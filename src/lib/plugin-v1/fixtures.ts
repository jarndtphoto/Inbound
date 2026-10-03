import { AIRPORT_BY_ICAO } from "../airports";
import { destPoint } from "../geo";
import { areaDefinition, invalidNearbyRequest } from "./areas";
import { InboundFlightV1Schema, NearbyFlightsResponseV1Schema, FlightResultV1Schema, type AirportV1, type Basis, type EventTimeV1, type Fact, type FlightCandidateV1, type FlightResultV1, type InboundFlightV1, type InboundNearbyFlight, type NearbyFlightsResponseV1 } from "./contracts";
import type { NearbyCandidate } from "./ranking";

export const FIXTURE_NOTICE = "Invented deterministic test fixtures. No live aircraft, schedules, tokens, or operational assertions.";
export const FIXTURE_NOW = "2030-01-15T18:00:06.000Z";
export const FIXTURE_NOW_MS = Date.parse(FIXTURE_NOW);
export const fixtureId = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
/** Deliberately predictable/inert. Never a production token generator. */
export const fixtureToken = (n: number) => String.fromCharCode(65 + n % 26).repeat(43);
export const fixtureTime = (offsetSeconds: number) => new Date(FIXTURE_NOW_MS + offsetSeconds * 1000).toISOString();
export function fixtureFact<T extends NonNullable<unknown>>(value: T, basis: Basis): Fact<T> { return { value, basis, checkedAt: fixtureTime(-8), sourceLabel: "Inbound" }; }
export const emptyEvent = (): EventTimeV1 => ({ scheduled: null, providerEstimated: null, providerActual: null, inboundEstimated: null, detected: null, selected: null });

export function fixtureNearbyCard(index = 0): InboundNearbyFlight {
  const identities = ["UAL1847", "SWA2915", "AAL1070", "N424FX"];
  const resolved = index === 1;
  const unsupported = index === 3;
  return {
    cardId: fixtureId(index + 1),
    identity: { displayIdent: identities[index] ?? "UAL9999", observedCallsign: unsupported ? null : identities[index] ?? "UAL9999", flightNumber: resolved ? "WN2915" : null, airlineName: ["United (fixture)", "Southwest (fixture)", "American (fixture)", null][index] ?? null },
    route: index === 0 ? { originIata: "ORD", destinationIata: "BOS", verification: "hint", checkedAt: fixtureTime(-8) } : resolved ? { originIata: "MDW", destinationIata: "DEN", verification: "confirmed", checkedAt: fixtureTime(-8) } : { originIata: null, destinationIata: null, verification: "unknown", checkedAt: null },
    altitudeFt: [6800, 11200, 7400, 4200][index] ?? 6800,
    motion: { phase: index === 2 ? "approach" : "climb", label: index === 2 ? "Descending" : "Climbing", verticalTrend: index === 2 ? "falling" : "rising" },
    proximity: { distanceNm: [3.56, 6.3, 8.2, 9.4][index] ?? 3.56 },
    freshness: { observedAt: fixtureTime(-6 - index), ageSeconds: 6 + index, status: "current", sourceLabel: "Inbound" },
    selection: { state: resolved ? "resolved" : unsupported ? "unsupported" : "unresolved", token: unsupported ? null : fixtureToken(index), expiresAt: unsupported ? null : fixtureTime(114 - index), flightInstanceId: resolved ? fixtureId(101) : null },
    position: null, aircraft: { typeCode: unsupported ? "C172" : "A320", typeName: unsupported ? "Cessna 172 (fixture)" : "Airbus A320 (fixture)", registration: unsupported ? "N424FX" : null },
  };
}
export function fixtureNearbyBoard(areaId: "preset:chicago" | "airport:KORD" | "airport:KMDW" = "preset:chicago", count = 4): NearbyFlightsResponseV1 {
  return NearbyFlightsResponseV1Schema.parse({ schemaVersion: "1.0", status: count ? "ok" : "empty", responseAt: FIXTURE_NOW, snapshotAt: fixtureTime(-6), resolvedArea: areaDefinition(areaId), refreshAfterSeconds: 20, stale: false, partial: false, warnings: [], flights: Array.from({ length: count }, (_, i) => fixtureNearbyCard(i)), areaChoices: [], error: null });
}
function staleBoard(): NearbyFlightsResponseV1 {
  const r = fixtureNearbyBoard();
  r.responseAt = fixtureTime(60); r.stale = true; r.partial = true; r.warnings = ["stale_data", "refresh_delayed"];
  for (const f of r.flights) { f.freshness.ageSeconds += 60; f.freshness.status = "stale"; }
  return NearbyFlightsResponseV1Schema.parse(r);
}
const hintBoard = () => fixtureNearbyBoard("preset:chicago", 1);
const unknownBoard = () => { const r = hintBoard(); r.flights = [fixtureNearbyCard(2)]; return r; };
const confirmedBoard = () => { const r = hintBoard(); r.flights = [fixtureNearbyCard(1)]; return r; };
const extrapolatedBoard = () => { const r = hintBoard(); const p = destPoint({ lat: 41.90, lon: -87.80 }, 90, r.flights[0]!.proximity.distanceNm); r.flights[0]!.position = { latitude: p.lat, longitude: p.lon, kind: "extrapolated" }; return r; };
const partialBoard = () => { const r = fixtureNearbyBoard(); r.partial = true; r.warnings = ["partial_coverage"]; return r; };
const unavailableBoard = (warming = false): NearbyFlightsResponseV1 => ({ schemaVersion: "1.0", status: "unavailable", responseAt: FIXTURE_NOW, snapshotAt: null, resolvedArea: areaDefinition("preset:chicago"), refreshAfterSeconds: warming ? 5 : 40, stale: false, partial: !warming, warnings: warming ? [] : ["partial_coverage", "refresh_delayed"], flights: [], areaChoices: [], error: { code: warming ? "warming" : "feed_unavailable", message: warming ? "Fixture area snapshot is warming." : "Fixture aircraft feed is temporarily unavailable." } });
export const nearbyFixtures: Readonly<Record<string, NearbyFlightsResponseV1>> = {
  healthyChicago: fixtureNearbyBoard(), ord: fixtureNearbyBoard("airport:KORD"), mdw: fixtureNearbyBoard("airport:KMDW"),
  fourCardBoard: fixtureNearbyBoard(), fewerThanFour: fixtureNearbyBoard("preset:chicago", 2), unknownRoute: unknownBoard(), routeHint: hintBoard(), confirmedRoute: confirmedBoard(), extrapolatedPosition: extrapolatedBoard(),
  partialCoverage: partialBoard(), staleLastKnown: staleBoard(), emptySuccess: fixtureNearbyBoard("preset:chicago", 0), feedUnavailable: unavailableBoard(), warming: unavailableBoard(true),
  missingArea: invalidNearbyRequest("area_required", FIXTURE_NOW), invalidArea: invalidNearbyRequest("unsupported_area", FIXTURE_NOW),
};

function fixtureAirport(code: string): AirportV1 {
  const a = AIRPORT_BY_ICAO[code]!;
  return { iata: a.iata, icao: a.icao, name: `${a.name} (fixture)`, city: a.city, timeZone: a.tz, latitude: a.lat, longitude: a.lon };
}
export function fixtureDetail(): InboundFlightV1 {
  const selected = fixtureFact("2030-01-15T14:18:00.000Z", "inbound_detected");
  return InboundFlightV1Schema.parse({
    schemaVersion: "1.0", flightInstanceId: fixtureId(100), snapshotAt: FIXTURE_NOW,
    identity: { displayIdent: "UAL1847", operatingIdent: "UAL1847", flightNumber: "UA1847", observedCallsign: "UAL1847", airlineName: "United (fixture)", serviceDate: "2030-01-15", serviceTimeZone: "America/Chicago" },
    route: { origin: fixtureAirport("KORD"), destination: fixtureAirport("KBOS"), divertedTo: null },
    status: { lifecycle: "active", text: "In flight — fixture", basis: "inbound_inferred", cancelled: null, diverted: null },
    phase: { stage: "ride", label: "In flight", basis: "inbound_inferred", motion: "cruise", arrivalState: fixtureFact("airborne", "inbound_inferred") },
    aircraft: { typeCode: "A320", typeName: "Airbus A320 (fixture)", registration: null },
    position: { latitude: 42.04, longitude: -87.32, altitudeFt: 35000, groundspeedKt: 420, groundTrackDeg: 85, verticalRateFpm: null, onGround: null, kind: "observed", observedAt: fixtureTime(-6), ageSeconds: 6, freshness: "current" },
    departure: { terminal: fixtureFact("1", "provider_reported"), gate: fixtureFact("B12", "provider_reported"), runway: { designation: "09R", role: "reported", basis: "provider_reported", checkedAt: fixtureTime(-8), sourceLabel: "Inbound" } },
    arrival: { terminal: null, gate: null, baggage: null, baggageState: "unavailable", runway: { designation: "22L", role: "expected", basis: "inbound_estimated", checkedAt: fixtureTime(-8), sourceLabel: "Inbound" } },
    times: { gateOut: { ...emptyEvent(), scheduled: fixtureFact("2030-01-15T14:00:00.000Z", "provider_reported"), selected: fixtureFact("2030-01-15T14:06:00.000Z", "inbound_detected"), detected: fixtureFact("2030-01-15T14:06:00.000Z", "inbound_detected") }, takeoff: { ...emptyEvent(), detected: selected, selected }, landing: { ...emptyEvent(), inboundEstimated: fixtureFact("2030-01-15T18:20:00.000Z", "inbound_estimated"), selected: fixtureFact("2030-01-15T18:20:00.000Z", "inbound_estimated") }, gateIn: emptyEvent() },
    delay: { departure: { minutes: 6, baselineKind: "published_schedule", baselineAt: "2030-01-15T14:00:00.000Z", basis: "derived", checkedAt: fixtureTime(-8) }, landing: null },
    freshness: { storyAgeSeconds: 0, positionAgeSeconds: 6, stale: false, partial: false, warnings: [] },
    map: { geometryKind: "mixed_display", path: [[-87.32, 42.04], [-71.01, 42.36]] },
  });
}
function detailPhase(stage: InboundFlightV1["phase"]["stage"], label: string, motion: InboundFlightV1["phase"]["motion"]): InboundFlightV1 {
  const f = fixtureDetail(); f.phase.stage = stage; f.phase.label = label; f.phase.motion = motion; f.status.text = `${label} — fixture`; return f;
}
const predeparture = () => { const f = detailPhase("origin_gate", "At origin gate", "parked"); f.status.lifecycle = "scheduled"; f.status.basis = "provider_reported"; f.phase.arrivalState = null; f.position = null; f.map = null; f.freshness.positionAgeSeconds = null; f.times.gateOut = { ...emptyEvent(), scheduled: fixtureFact("2030-01-15T18:20:00.000Z", "provider_reported"), selected: fixtureFact("2030-01-15T18:20:00.000Z", "provider_reported") }; f.times.takeoff = emptyEvent(); return f; };
const groundDetail = (stage: InboundFlightV1["phase"]["stage"], label: string) => { const f = detailPhase(stage, label, "taxi"); f.position!.onGround = true; f.position!.altitudeFt = 672; f.position!.groundspeedKt = stage === "Takeoff roll" ? 80 : 12; f.phase.arrivalState = null; if(stage === "push" || stage === "taxi" || stage === "Takeoff roll") { f.times.takeoff = emptyEvent(); f.times.gateOut = { ...emptyEvent(), scheduled: fixtureFact(fixtureTime(-120), "provider_reported"), detected: fixtureFact(fixtureTime(-6), "inbound_detected"), selected: fixtureFact(fixtureTime(-6), "inbound_detected") }; } return f; };
const arrivalDetail = (final = false) => { const f = detailPhase(final ? "final_approach" : "arrival", final ? "Final approach" : "Arrival", final ? "approach" : "descent"); const p = destPoint({lat:f.route.destination.latitude,lon:f.route.destination.longitude},270,final ? 4 : 35); f.position!.latitude = p.lat; f.position!.longitude = p.lon; f.position!.altitudeFt = final ? 2000 : 10000; f.position!.groundspeedKt = final ? 140 : 250; f.position!.verticalRateFpm = -650; f.map!.path = [[p.lon,p.lat],[f.route.destination.longitude,f.route.destination.latitude]]; return f; };
const landed = () => { const f = groundDetail("taxi_in", "Taxiing in"); f.position!.latitude = f.route.destination.latitude; f.position!.longitude = f.route.destination.longitude; f.position!.altitudeFt = AIRPORT_BY_ICAO.KBOS!.elevationFt; f.phase.arrivalState = fixtureFact("taxi_in", "inbound_inferred"); f.times.landing = { ...emptyEvent(), selected: fixtureFact("2030-01-15T17:54:00.000Z", "inbound_inferred") }; return f; };
const providerLanding = () => { const f = landed(); const actual = fixtureFact("2030-01-15T17:54:00.000Z", "provider_actual"); f.times.landing.providerActual = actual; f.times.landing.selected = actual; return f; };
const atGate = () => { const f = landed(); f.phase.stage = "gate"; f.phase.label = "At gate"; f.phase.motion = "parked"; f.phase.arrivalState = fixtureFact("gate", "inbound_inferred"); f.status.lifecycle = "completed"; f.status.text = "At gate — fixture"; f.position!.groundspeedKt = 0; f.times.gateIn = { ...emptyEvent(), selected: fixtureFact("2030-01-15T18:00:00.000Z", "inbound_inferred") }; f.arrival.gate = fixtureFact("B4", "provider_reported"); f.arrival.baggage = fixtureFact("4", "provider_reported"); f.arrival.baggageState = "posted"; return f; };
const cancelled = () => { const f = predeparture(); f.status = { lifecycle: "cancelled", text: "Cancelled — fixture", basis: "provider_reported", cancelled: fixtureFact(true, "provider_reported"), diverted: null }; f.phase = { stage: null, label: "Cancelled", basis: "unknown", motion: null, arrivalState: null }; return f; };
const diverted = () => { const f = fixtureDetail(); f.status.diverted = fixtureFact(true, "provider_reported"); f.status.text = "Diverted — fixture"; f.route.divertedTo = fixtureAirport("KMDW"); return f; };
const stalePosition = () => { const f = fixtureDetail(); f.position!.observedAt = fixtureTime(-70); f.position!.ageSeconds = 70; f.position!.freshness = "stale"; f.freshness = { ...f.freshness, positionAgeSeconds: 70, stale: true, warnings: ["position_stale"] }; return f; };
const noPosition = () => { const f = fixtureDetail(); f.position = null; f.freshness.positionAgeSeconds = null; f.freshness.warnings = ["position_unavailable"]; return f; };
const unknownProvenance = () => { const f = landed(); f.times.landing.selected!.basis = "unknown"; f.freshness.warnings = ["time_provenance_unknown"]; return f; };
export const detailFixtures: Readonly<Record<string, InboundFlightV1>> = {
  predeparture: predeparture(), pushbackDetected: groundDetail("push", "Pushing back"), taxiOut: groundDetail("taxi", "Taxiing out"), takeoffRoll: groundDetail("Takeoff roll", "Takeoff roll"),
  airborne: fixtureDetail(), arrival: arrivalDetail(), finalApproach: arrivalDetail(true), landedTaxiIn: landed(), atGate: atGate(),
  cancelled: cancelled(), diverted: diverted(), stalePosition: stalePosition(), noPosition: noPosition(), inferredLanding: landed(), providerActualLanding: providerLanding(), unknownTimeProvenance: unknownProvenance(),
};
export function resolvedFixture(flight = fixtureDetail()): FlightResultV1 {
  return FlightResultV1Schema.parse({ schemaVersion: "1.0", status: "resolved", responseAt: FIXTURE_NOW, refreshAfterSeconds: flight.status.lifecycle === "completed" ? 60 : 20, flightInstanceId: flight.flightInstanceId, flight, candidates: [], error: null });
}
export function resultError(status: "expired" | "unsupported" | "unavailable" | "invalid_request" | "not_found", code: NonNullable<FlightResultV1["error"]>["code"], message: string): FlightResultV1 {
  return FlightResultV1Schema.parse({ schemaVersion: "1.0", status, responseAt: FIXTURE_NOW, refreshAfterSeconds: status === "unavailable" ? 40 : null, flightInstanceId: null, flight: null, candidates: [], error: { code, message } });
}
function candidate(index: number, date = "2030-01-15"): FlightCandidateV1 {
  return { candidateToken: fixtureToken(10 + index), expiresAt: fixtureTime(100), displayIdent: "UAL1847", originIata: "ORD", destinationIata: "BOS", serviceDate: date, serviceTimeZone: "America/Chicago", scheduledDepartureAt: `${date}T${index === 0 ? "14" : "19"}:00:00.000Z` };
}
const ambiguous = (sameDay: boolean): FlightResultV1 => ({ schemaVersion: "1.0", status: "ambiguous", responseAt: FIXTURE_NOW, refreshAfterSeconds: null, flightInstanceId: null, flight: null, candidates: [candidate(0), candidate(1, sameDay ? "2030-01-15" : "2030-01-16")], error: null });
export const selectionFixtures = {
  unresolvedSelectableCard: fixtureNearbyCard(0), resolvedCard: fixtureNearbyCard(1),
  expiredToken: resultError("expired", "observation_expired", "The fixture observation has expired."), unsupportedAircraft: resultError("unsupported", "unsupported_aircraft", "This fixture aircraft has no supported detailed flight."),
  ambiguousDatedFlights: ambiguous(false), identityMismatch: resultError("unavailable", "identity_changed", "The fixture identity no longer matches this observation."), repeatedSameDayFlightNumber: ambiguous(true),
};
export const resultFixtures: Readonly<Record<string, FlightResultV1>> = {
  resolved: resolvedFixture(), ambiguous: selectionFixtures.ambiguousDatedFlights, notFound: resultError("not_found", "flight_not_found", "No matching fixture flight was found."),
  unavailable: selectionFixtures.identityMismatch, expired: selectionFixtures.expiredToken, unsupported: selectionFixtures.unsupportedAircraft, invalidRequest: resultError("invalid_request", "invalid_token", "The fixture handle is invalid."), repeatedSameDay: selectionFixtures.repeatedSameDayFlightNumber,
};

export function fixtureRankingCandidate(index = 0): NearbyCandidate {
  const card = fixtureNearbyCard(index);
  const p = destPoint({ lat: 41.90, lon: -87.80 }, 90 + index * 35, card.proximity.distanceNm);
  return { cardId: card.cardId, privateAircraftIdentity: `fixture-aircraft-${index}`, sessionKey: `fixture-session-${index}`, observedCallsign: card.identity.observedCallsign, registration: card.aircraft?.registration ?? null, latitude: p.lat, longitude: p.lon, altitudeFt: card.altitudeFt, groundspeedKt: 210, verticalRateFpm: index === 2 ? -650 : 650, onGround: false, observedAt: card.freshness.observedAt, positionKind: "observed", acceptedPosition: true, identityConflict: false, typeCode: card.aircraft?.typeCode ?? null, category: null, operator: null, interesting: false, route: card.route, datedBinding: card.route.verification === "confirmed" ? { sessionKey: `fixture-session-${index}`, observedCallsign: card.identity.observedCallsign!, serviceDate: "2030-01-15", confirmedAt: fixtureTime(-8) } : null };
}
export const rankingFixtures = [0, 1, 2, 3].map(fixtureRankingCandidate);

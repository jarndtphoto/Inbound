import { randomUUID } from "node:crypto";
import { AIRPORT_BY_ICAO } from "../airports";
import type { AcceptedNearbyObservation } from "../nearby-v1/model";
import {
  FlightResultV1Schema, GetFlightRequestV1Schema, HandleSchema, InboundFlightV1Schema,
  ResolveNearbyRequestV1Schema, type AirportV1, type FlightResultV1, type GetFlightRequestV1,
  type InboundFlightV1, type ResolveNearbyRequestV1,
} from "./contracts";
import type { PrivateNearbyResponse } from "./nearby-response";
import {
  MAX_HANDOFF_ATTEMPTS, type FlightHandoffStore, type OccurrenceSeed, type SelectionEvidence,
  type StoredOccurrence, type StoredSelection, tokenHash,
} from "./handoff-store.server";

export type PublicSelection = {
  state: "unresolved" | "resolved" | "unsupported"; token: string | null;
  expiresAt: string | null; flightInstanceId: string | null;
};
export type SelectionByRadarId = ReadonlyMap<string, PublicSelection>;
type ResolveDecision =
  | { kind: "resolved"; occurrence: OccurrenceSeed }
  | { kind: "ambiguous"; occurrences: OccurrenceSeed[] }
  | { kind: "failure"; status: "unavailable" | "unsupported" | "not_found"; code: NonNullable<FlightResultV1["error"]>["code"]; message: string }
  | { kind: "backend_unavailable"; message: string };
export type HandoffResolver = (selection: StoredSelection, nowMs: number) => Promise<ResolveDecision>;
export type HandoffDetailBuilder = (occurrence: StoredOccurrence, nowMs: number) => Promise<InboundFlightV1>;

const responseAt = (nowMs: number) => new Date(nowMs).toISOString();
function failure(nowMs: number, status: "expired" | "unsupported" | "unavailable" | "invalid_request" | "not_found",
  code: NonNullable<FlightResultV1["error"]>["code"], message: string): FlightResultV1 {
  return FlightResultV1Schema.parse({ schemaVersion: "1.0", status, responseAt: responseAt(nowMs),
    refreshAfterSeconds: status === "unavailable" ? 20 : null, flightInstanceId: null, flight: null,
    candidates: [], error: { code, message } });
}
function resolved(flight: InboundFlightV1): FlightResultV1 {
  return FlightResultV1Schema.parse({ schemaVersion: "1.0", status: "resolved", responseAt: flight.snapshotAt,
    refreshAfterSeconds: flight.status.lifecycle === "completed" ? 60 : 20, flightInstanceId: flight.flightInstanceId,
    flight, candidates: [], error: null });
}
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

export function createFlightHandoffService(options: {
  store: FlightHandoffStore; environment: string; resolver: HandoffResolver;
  detailBuilder: HandoffDetailBuilder; clock?: () => number;
}) {
  const clock = options.clock ?? Date.now;
  const stats = { selectionIssues: 0, resolutionRequests: 0, resolutionBuilds: 0, detailRequests: 0,
    detailBuilds: 0, providerCalls: 0, productionApiCalls: 0, productionDbAccess: 0 };

  async function issueSelections(result: PrivateNearbyResponse): Promise<SelectionByRadarId> {
    const output = new Map<string, PublicSelection>();
    if (!result.view) return output;
    const nowMs = clock(), rows = new Map(result.view.ranked.map(row => [(row.candidate as AcceptedNearbyObservation).radarId, row.candidate as AcceptedNearbyObservation]));
    for (const target of result.view.radar) {
      const observation = rows.get(target.radarId); if (!observation) continue;
      // SYN104 is the one explicitly unsupported invented aircraft. Selection
      // remains local and no server-side handle is minted for it.
      if (observation.observedCallsign === "SYN104") {
        output.set(target.radarId, { state: "unsupported", token: null, expiresAt: null, flightInstanceId: null }); continue;
      }
      const evidence: SelectionEvidence = {
        environment: options.environment, collectionVersion: result.view.collectionVersion,
        cardId: observation.cardId, radarId: observation.radarId,
        privateAircraftIdentity: observation.privateAircraftIdentity, sessionKey: observation.sessionKey,
        observedCallsign: observation.observedCallsign, registration: observation.registration,
        observedAt: observation.observedAt, latitude: observation.latitude, longitude: observation.longitude,
        route: observation.route, datedBinding: observation.datedBinding ?? null,
      };
      try {
        const handle = await options.store.issueSelection(evidence, nowMs); stats.selectionIssues++;
        output.set(target.radarId, { state: "unresolved", token: handle.token, expiresAt: handle.expiresAt, flightInstanceId: null });
      } catch {
        // A logically expired observation stays visible only as a local Radar
        // selection. It can never receive a newly extended server handle.
        output.set(target.radarId, { state: "unsupported", token: null, expiresAt: null, flightInstanceId: null });
      }
    }
    return output;
  }

  async function detailByInstance(flightInstanceId: string): Promise<FlightResultV1> {
    stats.detailRequests++; let nowMs = clock();
    const occurrence = await options.store.readOccurrence(flightInstanceId, nowMs);
    if (!occurrence) return failure(nowMs, "not_found", "flight_not_found", "No matching invented flight occurrence was found.");
    let detail = await options.store.readDetail(flightInstanceId, nowMs);
    if (detail?.publicFlight && Date.parse(detail.nextRevalidationAt) > nowMs) return resolved(detail.publicFlight);
    const owner = randomUUID(), lease = await options.store.claimDetail(flightInstanceId, owner, nowMs);
    if (lease) {
      try {
        stats.detailBuilds++; const flight = InboundFlightV1Schema.parse(await options.detailBuilder(occurrence, nowMs));
        const refresh = flight.status.lifecycle === "completed" ? 60 : 20;
        if (!await options.store.publishDetail(lease, flight, refresh, clock())) return failure(clock(), "unavailable", "backend_unavailable", "A newer detail builder superseded this response.");
        return resolved(flight);
      } catch {
        await options.store.failDetail(lease, "The invented detail builder is temporarily unavailable.", clock());
        return failure(clock(), "unavailable", "backend_unavailable", "The invented detail builder is temporarily unavailable.");
      }
    }
    // A concurrent owner is expected to finish well inside the five-second
    // lease. Bounded observation avoids constructing duplicate work.
    for (let attempt = 0; attempt < 50; attempt++) {
      await sleep(10); nowMs = clock(); detail = await options.store.readDetail(flightInstanceId, nowMs);
      if (detail?.publicFlight) return resolved(detail.publicFlight);
      if (detail && !detail.leaseOwner && detail.detailError) break;
    }
    return failure(clock(), "unavailable", "backend_unavailable", "Flight detail is being prepared. Retry after the bounded backoff.");
  }

  async function resolveNearby(raw: ResolveNearbyRequestV1 | unknown): Promise<FlightResultV1> {
    stats.resolutionRequests++; const parsed = ResolveNearbyRequestV1Schema.safeParse(raw), nowMs = clock();
    if (!parsed.success) return failure(nowMs, "invalid_request", "invalid_token", "The selection handle is invalid.");
    const token = parsed.data.selectionToken, selection = await options.store.readSelection(token, nowMs);
    if (!selection) return failure(nowMs, "invalid_request", "invalid_token", "The selection handle is invalid.");
    if (Date.parse(selection.expiresAt) <= nowMs) return failure(nowMs, "expired", "observation_expired", "The selected observation has expired. Refresh Nearby and select the aircraft again.");
    if (selection.publicResult) return selection.publicResult;
    if (Date.parse(selection.nextAttemptAt) > nowMs || selection.resolutionAttempts >= MAX_HANDOFF_ATTEMPTS && selection.resolutionError)
      return failure(nowMs, "unavailable", "backend_unavailable", "The invented resolver is in bounded backoff. Retry shortly.");
    const owner = randomUUID(), lease = await options.store.claimResolution(tokenHash(token), owner, nowMs);
    if (lease) {
      const decision = await options.resolver(lease.selection, nowMs);
      if (decision.kind === "backend_unavailable") {
        await options.store.failResolution(lease, decision.message, clock());
        return failure(clock(), "unavailable", "backend_unavailable", decision.message);
      }
      let result: FlightResultV1;
      if (decision.kind === "failure") result = failure(nowMs, decision.status, decision.code, decision.message);
      else if (decision.kind === "resolved") {
        const occurrence = await options.store.ensureOccurrence(decision.occurrence, nowMs);
        result = await detailByInstance(occurrence.flightInstanceId);
      } else {
        const occurrences = await Promise.all(decision.occurrences.map(value => options.store.ensureOccurrence(value, nowMs)));
        const candidates = await options.store.issueChoices(lease.tokenHash, occurrences, nowMs);
        result = FlightResultV1Schema.parse({ schemaVersion: "1.0", status: "ambiguous", responseAt: responseAt(nowMs),
          refreshAfterSeconds: null, flightInstanceId: null, flight: null, candidates, error: null });
      }
      stats.resolutionBuilds++; await options.store.publishResolution(lease, result, clock()); return result;
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      await sleep(10); const current = await options.store.readSelection(token, clock());
      if (current?.publicResult) return current.publicResult;
      if (current && !current.leaseOwner && current.resolutionError) break;
    }
    return failure(clock(), "unavailable", "backend_unavailable", "The invented resolver is being prepared. Retry after the bounded backoff.");
  }

  async function getFlight(raw: GetFlightRequestV1 | unknown): Promise<FlightResultV1> {
    const parsed = GetFlightRequestV1Schema.safeParse(raw), nowMs = clock();
    if (!parsed.success) return failure(nowMs, "invalid_request", "invalid_input", "The flight request is invalid.");
    const target = parsed.data.target;
    if (target.kind === "instance") return detailByInstance(target.flightInstanceId);
    if (target.kind === "choice") {
      if (!HandleSchema.safeParse(target.candidateToken).success) return failure(nowMs, "invalid_request", "invalid_token", "The candidate handle is invalid.");
      const choice = await options.store.readChoice(target.candidateToken, nowMs);
      if (!choice) return failure(nowMs, "invalid_request", "invalid_token", "The candidate handle is invalid.");
      if (Date.parse(choice.expiresAt) <= nowMs) return failure(nowMs, "expired", "choice_expired", "The ambiguity choice has expired.");
      return detailByInstance(choice.flightInstanceId);
    }
    const query = target.query.replace(/[ -]/g, "").toUpperCase();
    if (query === "SYN104") return failure(nowMs, "unsupported", "unsupported_aircraft", "This invented aircraft has no supported detailed flight.");
    if (query !== "SYN101") return failure(nowMs, "unsupported", "unsupported_query", "Only the documented invented lookup fixture is supported.");
    if (!target.date) return failure(nowMs, "unavailable", "date_unavailable", "An explicit service date is required for lookup.");
    const serviceDate = /^\d{4}-\d{2}-\d{2}$/.test(target.date) ? target.date
      : chicagoRelativeDate(nowMs, target.date as "today" | "tomorrow" | "yesterday");
    const seed = occurrenceSeed({ callsign: "SYN101", serviceDate, originIata: target.originIata ?? "ORD",
      destinationIata: target.destinationIata ?? "BOS", basis: "explicit_lookup" });
    const occurrence = await options.store.ensureOccurrence(seed, nowMs); return detailByInstance(occurrence.flightInstanceId);
  }

  return { issueSelections, resolveNearby, getFlight, diagnostics: () => ({ ...stats }), cleanup: () => options.store.cleanup(clock()) };
}

function chicagoRelativeDate(nowMs: number, relative: "today" | "tomorrow" | "yesterday"): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(nowMs);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const base = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day));
  const offset = relative === "tomorrow" ? 86_400_000 : relative === "yesterday" ? -86_400_000 : 0;
  return new Date(base + offset).toISOString().slice(0, 10);
}
function chicagoServiceDate(at: string): string {
  return chicagoRelativeDate(Date.parse(at), "today");
}
function nextServiceDate(serviceDate: string): string {
  const [year, month, day] = serviceDate.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + 1)).toISOString().slice(0, 10);
}
function occurrenceSeed(input: { callsign: string; serviceDate: string; originIata: string; destinationIata: string;
  basis: OccurrenceSeed["identityEvidence"]["basis"]; selection?: StoredSelection }): OccurrenceSeed {
  const scheduledDepartureAt = `${input.serviceDate}T14:00:00.000Z`;
  return { operatingIdent: input.callsign, displayIdent: input.callsign, serviceDate: input.serviceDate,
    serviceTimeZone: "America/Chicago", originIata: input.originIata, destinationIata: input.destinationIata,
    scheduledDepartureAt, identityEvidence: { privateAircraftIdentity: input.selection?.privateAircraftIdentity ?? null,
      sessionKey: input.selection?.sessionKey ?? null, observedCallsign: input.selection?.observedCallsign ?? input.callsign,
      registration: input.selection?.registration ?? null, basis: input.basis } };
}

export function createInventedHandoffResolver(): HandoffResolver {
  return async selection => {
    const callsign = selection.observedCallsign;
    if (callsign === "SYN107") return { kind: "backend_unavailable", message: "The invented occurrence source is temporarily unavailable." };
    if (callsign === "SYN106") return { kind: "failure", status: "unavailable", code: "identity_changed", message: "The invented aircraft identity changed after selection." };
    if (callsign === "SYN104") return { kind: "failure", status: "unsupported", code: "unsupported_aircraft", message: "This invented aircraft has no supported detailed flight." };
    if (!callsign || !selection.privateAircraftIdentity || !selection.sessionKey)
      return { kind: "failure", status: "unavailable", code: "identity_unconfirmed", message: "The selected invented aircraft identity is not confirmed." };
    // Priority 1: a confirmed dated binding must match the exact accepted
    // session and callsign. No date is inferred from server UTC.
    const binding = selection.datedBinding;
    if (binding && binding.sessionKey === selection.sessionKey && binding.observedCallsign === callsign
      && selection.route.verification === "confirmed" && selection.route.originIata && selection.route.destinationIata) {
      return { kind: "resolved", occurrence: occurrenceSeed({ callsign, serviceDate: binding.serviceDate,
        originIata: selection.route.originIata, destinationIata: selection.route.destinationIata,
        basis: "dated_binding", selection }) };
    }
    if (callsign === "SYN105" && selection.route.verification === "confirmed"
      && selection.route.originIata && selection.route.destinationIata) {
      const observedDate = chicagoServiceDate(selection.observedAt), nextDate = nextServiceDate(observedDate);
      return { kind: "ambiguous", occurrences: [observedDate, nextDate].map(serviceDate => occurrenceSeed({ callsign, serviceDate,
        originIata: selection.route.originIata!, destinationIata: selection.route.destinationIata!, basis: "session_route", selection })) };
    }
    if (selection.route.verification === "unknown")
      return { kind: "failure", status: "unavailable", code: "route_unavailable", message: "No confirmed route exists for this invented observation." };
    return { kind: "failure", status: "unavailable", code: "identity_unconfirmed", message: "The selected invented flight identity is not confirmed." };
  };
}

function airport(iata: string): AirportV1 {
  const source = Object.values(AIRPORT_BY_ICAO).find(value => value.iata === iata);
  if (!source) throw new RangeError("Unsupported invented airport");
  return { iata: source.iata, icao: source.icao, name: `${source.name} (invented fixture)`, city: source.city,
    timeZone: source.tz, latitude: source.lat, longitude: source.lon };
}
const emptyEvent = () => ({ scheduled: null, providerEstimated: null, providerActual: null, inboundEstimated: null, detected: null, selected: null });
const fact = <T extends NonNullable<unknown>>(value: T, checkedAt: string, basis: "provider_reported" | "inbound_detected" | "inbound_estimated") =>
  ({ value, basis, checkedAt, sourceLabel: "Inbound" as const });

/** Fake detail provider for the isolated proof. The MCP layer receives only the
 * already serialized InboundFlightV1 and performs no phase/route/gate math. */
export function createInventedDetailBuilder(counter?: { builds: number }): HandoffDetailBuilder {
  return async (occurrence, nowMs) => {
    if (counter) counter.builds++;
    const snapshotAt = responseAt(nowMs), observedAt = responseAt(nowMs - 6_000), origin = airport(occurrence.originIata), destination = airport(occurrence.destinationIata);
    const scheduled = occurrence.scheduledDepartureAt ?? `${occurrence.serviceDate}T14:00:00.000Z`;
    const takeoff = `${occurrence.serviceDate}T14:18:00.000Z`, landing = responseAt(nowMs + 20 * 60_000);
    return InboundFlightV1Schema.parse({ schemaVersion: "1.0", flightInstanceId: occurrence.flightInstanceId, snapshotAt,
      identity: { displayIdent: occurrence.displayIdent, operatingIdent: occurrence.operatingIdent, flightNumber: occurrence.operatingIdent,
        observedCallsign: occurrence.identityEvidence.observedCallsign, airlineName: "Invented Air", serviceDate: occurrence.serviceDate,
        serviceTimeZone: origin.timeZone }, route: { origin, destination, divertedTo: null },
      status: { lifecycle: "active", text: "In flight — invented fixture", basis: "inbound_inferred", cancelled: null, diverted: null },
      phase: { stage: "ride", label: "In flight", basis: "inbound_inferred", motion: "cruise", arrivalState: fact("airborne", snapshotAt, "inbound_detected") },
      aircraft: { typeCode: "B738", typeName: "Invented narrow-body aircraft", registration: null },
      position: { latitude: 42.04, longitude: -87.32, altitudeFt: 27_000, groundspeedKt: 390, groundTrackDeg: 88,
        verticalRateFpm: 0, onGround: false, kind: "observed", observedAt, ageSeconds: 6, freshness: "current" },
      departure: { terminal: fact("1", snapshotAt, "provider_reported"), gate: fact("B12", snapshotAt, "provider_reported"),
        runway: { designation: "09R", role: "reported", basis: "provider_reported", checkedAt: snapshotAt, sourceLabel: "Inbound" } },
      arrival: { terminal: null, gate: null, baggage: null, baggageState: "unavailable",
        runway: { designation: "22L", role: "expected", basis: "inbound_estimated", checkedAt: snapshotAt, sourceLabel: "Inbound" } },
      times: { gateOut: { ...emptyEvent(), scheduled: fact(scheduled, snapshotAt, "provider_reported"), detected: fact(`${occurrence.serviceDate}T14:06:00.000Z`, snapshotAt, "inbound_detected"), selected: fact(`${occurrence.serviceDate}T14:06:00.000Z`, snapshotAt, "inbound_detected") },
        takeoff: { ...emptyEvent(), detected: fact(takeoff, snapshotAt, "inbound_detected"), selected: fact(takeoff, snapshotAt, "inbound_detected") },
        landing: { ...emptyEvent(), inboundEstimated: fact(landing, snapshotAt, "inbound_estimated"), selected: fact(landing, snapshotAt, "inbound_estimated") }, gateIn: emptyEvent() },
      delay: { departure: { minutes: 6, baselineKind: "published_schedule", baselineAt: scheduled, basis: "derived", checkedAt: snapshotAt }, landing: null },
      freshness: { storyAgeSeconds: 0, positionAgeSeconds: 6, stale: false, partial: false, warnings: [] },
      map: { geometryKind: "mixed_display", path: [[-87.32, 42.04], [destination.longitude, destination.latitude]] },
    });
  };
}

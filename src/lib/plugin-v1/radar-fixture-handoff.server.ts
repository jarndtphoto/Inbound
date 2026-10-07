import { createHmac, timingSafeEqual } from "node:crypto";
import { AIRPORTS } from "../airports";
import type { AcceptedNearbyObservation } from "../nearby-v1/model";
import { FlightResultV1Schema, GetFlightRequestV1Schema, ResolveNearbyRequestV1Schema, type FlightResultV1 } from "./contracts";
import { chicagoRelativeDate, createInventedDetailBuilder, createInventedHandoffResolver, occurrenceSeed, type SelectionByRadarId } from "./handoff-service.server";
import type { OccurrenceSeed, StoredOccurrence, StoredSelection } from "./handoff-store.server";
import type { PrivateNearbyResponse } from "./nearby-response";
import { inventedAcquisition } from "./radar-proof-engine.server";

const iso = (at: number) => new Date(at).toISOString();
const TTL_MS = 90_000;
type Handle = { kind: 0 | 1 | 2; index: number; observedAt: number; startedAt: number; collectionVersion: number; routeHinted: boolean };

/** Isolated invented-data proof only. No production store, SQL, provider, or
 * environment access. Compact authenticated handles carry only an invented
 * row index, public observation times, and collection version. Every worker
 * can reconstruct the same fixture evidence without trusting client identity.
 * A build-specific authority plus hostname scopes handles to one deployment.
 * This is deliberately not an authentication system for real aviation data. */
export function createRadarFixtureHandoff(options: { authority: string; realm: string; startedAt: number; clock: () => number }) {
  const mac = (value: Uint8Array | string) => createHmac("sha256", options.authority).update(options.realm).update("\0").update(value).digest();
  const resolver = createInventedHandoffResolver(), detailBuilder = createInventedDetailBuilder();
  const resolutions = new Map<string, { expiresAt: number; result: Promise<FlightResultV1> }>();
  const occurrences = new Map<string, StoredOccurrence>();
  const details = new Map<string, { expiresAt: number; result: Promise<FlightResultV1> }>();
  const stats = { selectionIssues: 0, resolutionRequests: 0, resolutionBuilds: 0, detailRequests: 0, detailBuilds: 0,
    providerCalls: 0, productionApiCalls: 0, productionDbAccess: 0 };
  const fail = (status: "expired" | "unsupported" | "unavailable" | "invalid_request" | "not_found", code: NonNullable<FlightResultV1["error"]>["code"], message: string) =>
    FlightResultV1Schema.parse({ schemaVersion: "1.0", status, responseAt: iso(options.clock()), refreshAfterSeconds: status === "unavailable" ? 20 : null,
      flightInstanceId: null, flight: null, candidates: [], error: { code, message } });
  function encode(value: Handle) {
    const body = Buffer.alloc(16);
    body[0] = value.kind * 64 + value.index;
    body.writeUIntBE(value.observedAt, 1, 6); body.writeUIntBE(value.startedAt, 7, 6);
    body.writeUIntBE(value.collectionVersion | (value.routeHinted ? 0x400000 : 0), 13, 3);
    return Buffer.concat([body, mac(body).subarray(0, 16)]).toString("base64url");
  }
  function decode(token: string): Handle | null {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.length !== 32 || bytes.toString("base64url") !== token || !timingSafeEqual(bytes.subarray(16), mac(bytes.subarray(0, 16)).subarray(0, 16))) return null;
    const kind = Math.floor(bytes[0]! / 64), index = bytes[0]! % 64;
    const observedAt = bytes.readUIntBE(1, 6), startedAt = bytes.readUIntBE(7, 6), flags = bytes.readUIntBE(13, 3), collectionVersion = flags & 0x3fffff;
    if (kind > 2 || index >= 40 || index === 3 || kind !== 0 && index !== 4 || collectionVersion < 1
      || flags & 0x800000 || startedAt > options.clock() + 1_000 || observedAt > options.clock() + 1_000) return null;
    return { kind: kind as Handle["kind"], index, observedAt, startedAt, collectionVersion, routeHinted: Boolean(flags & 0x400000) };
  }
  function evidence(handle: Handle): StoredSelection | null {
    const observation = inventedAcquisition(Math.max(handle.observedAt, handle.startedAt), handle.startedAt, false).observations[handle.index];
    if (!observation || Date.parse(observation.observedAt!) !== handle.observedAt) return null;
    return { environment: "fake_handoff_proof", collectionVersion: handle.collectionVersion, cardId: observation.cardId,
      radarId: observation.radarId, privateAircraftIdentity: observation.privateAircraftIdentity, sessionKey: observation.sessionKey,
      observedCallsign: observation.observedCallsign, registration: observation.registration, observedAt: observation.observedAt!,
      latitude: observation.latitude, longitude: observation.longitude,
      route: handle.routeHinted ? { originIata: "ORD", destinationIata: "BOS", verification: "hint", checkedAt: iso(handle.observedAt) } : observation.route,
      datedBinding: observation.datedBinding ?? null,
      tokenHash: "fixture-reconstructed", issuedAt: iso(handle.observedAt), expiresAt: iso(handle.observedAt + TTL_MS), publicResult: null,
      resolutionError: null, resolutionAttempts: 0, nextAttemptAt: iso(handle.observedAt), leaseOwner: null, leaseUntil: null, fencingGeneration: 0, failureBackoffSeconds: 20 };
  }
  function occurrence(raw: OccurrenceSeed, remember = true): StoredOccurrence {
    const digest = mac(JSON.stringify([raw.operatingIdent, raw.serviceDate, raw.serviceTimeZone, raw.originIata, raw.destinationIata, raw.scheduledDepartureAt]));
    digest[6] = (digest[6]! & 15) | 64; digest[8] = (digest[8]! & 63) | 128;
    const hex = digest.subarray(0, 16).toString("hex"), flightInstanceId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const row: StoredOccurrence = { ...raw, flightInstanceId, createdAt: iso(options.clock()), lastConfirmedAt: iso(options.clock()), retainUntil: iso(options.clock() + 14 * 86_400_000) };
    if (remember) occurrences.set(flightInstanceId, row); return row;
  }
  async function detail(row: StoredOccurrence) {
    stats.detailRequests++;
    const existing = details.get(row.flightInstanceId); if (existing && existing.expiresAt > options.clock()) return existing.result;
    const result = (async () => {
      stats.detailBuilds++;
      try { const flight = await detailBuilder(row, options.clock()); return FlightResultV1Schema.parse({ schemaVersion: "1.0", status: "resolved",
        responseAt: flight.snapshotAt, refreshAfterSeconds: 20, flightInstanceId: row.flightInstanceId, flight, candidates: [], error: null }); }
      catch { return fail("unavailable", "backend_unavailable", "The invented detail builder is temporarily unavailable."); }
    })();
    details.set(row.flightInstanceId, { expiresAt: options.clock() + 20_000, result }); return result;
  }
  async function resolveHandle(handle: Handle) {
    const selected = evidence(handle); if (!selected) return fail("invalid_request", "invalid_token", "The selection handle is invalid.");
    stats.resolutionBuilds++; const decision = await resolver(selected, options.clock());
    if (decision.kind === "backend_unavailable") return fail("unavailable", "backend_unavailable", decision.message);
    if (decision.kind === "failure") return fail(decision.status, decision.code, decision.message);
    if (decision.kind === "resolved") return detail(occurrence(decision.occurrence));
    const candidates = decision.occurrences.map((seed, index) => ({ candidateToken: encode({ ...handle, kind: index === 0 ? 1 : 2 }),
      expiresAt: selected.expiresAt, displayIdent: seed.displayIdent, originIata: seed.originIata, destinationIata: seed.destinationIata,
      serviceDate: seed.serviceDate, serviceTimeZone: seed.serviceTimeZone, scheduledDepartureAt: seed.scheduledDepartureAt }));
    return FlightResultV1Schema.parse({ schemaVersion: "1.0", status: "ambiguous", responseAt: iso(options.clock()), refreshAfterSeconds: null,
      flightInstanceId: null, flight: null, candidates, error: null });
  }
  // The Preview supports the documented invented occurrences and explicit
  // lookup dates within the retained fixture window. Recreate exact IDs from
  // that closed catalog on a cold worker; no callsign-only resolution occurs.
  function findOccurrence(id: string): StoredOccurrence | null {
    const known = occurrences.get(id); if (known) return known;
    const today = Date.parse(chicagoRelativeDate(options.clock(), "today"));
    for (let offset = -14; offset <= 1; offset++) {
      const serviceDate = iso(today + offset * 86_400_000).slice(0, 10);
      for (const [callsign, originIata, destinationIata] of [["SYN101", "ORD", "BOS"], ["SYN102", "MDW", "DEN"], ["SYN105", "ORD", "BOS"]]) {
        const row = occurrence(occurrenceSeed({ callsign: callsign!, serviceDate, originIata: originIata!, destinationIata: destinationIata!, basis: "explicit_lookup" }), false);
        if (row.flightInstanceId === id) { occurrences.set(id, row); return row; }
      }
      for (const origin of AIRPORTS) for (const destination of AIRPORTS) {
        const row = occurrence(occurrenceSeed({ callsign: "SYN101", serviceDate, originIata: origin.iata, destinationIata: destination.iata, basis: "explicit_lookup" }), false);
        if (row.flightInstanceId === id) { occurrences.set(id, row); return row; }
      }
    }
    return null;
  }
  function cleanup() {
    const now = options.clock();
    for (const [key, row] of resolutions) if (row.expiresAt <= now) resolutions.delete(key);
    for (const [key, row] of details) if (row.expiresAt <= now) details.delete(key);
    for (const [key, row] of occurrences) if (Date.parse(row.retainUntil) <= now) occurrences.delete(key);
  }
  return {
    async issueSelections(result: PrivateNearbyResponse): Promise<SelectionByRadarId> {
      cleanup(); const output = new Map(); if (!result.view) return output;
      const rows = new Map(result.view.ranked.map(row => [(row.candidate as AcceptedNearbyObservation).radarId, row.candidate as AcceptedNearbyObservation]));
      for (const target of result.view.radar) {
        const row = rows.get(target.radarId); if (!row) continue;
        const index = Number(row.observedCallsign?.slice(3)) - 101, observedAt = Date.parse(row.observedAt!);
        if (index === 3 || observedAt + TTL_MS <= options.clock()) output.set(target.radarId, { state: "unsupported", token: null, expiresAt: null, flightInstanceId: null });
        else { stats.selectionIssues++; output.set(target.radarId, { state: "unresolved", token: encode({ kind: 0, index, observedAt, startedAt: options.startedAt,
          collectionVersion: result.view.collectionVersion, routeHinted: row.route.verification === "hint" }), expiresAt: iso(observedAt + TTL_MS), flightInstanceId: null }); }
      }
      return output;
    },
    async resolveNearby(raw: unknown) {
      cleanup(); stats.resolutionRequests++; const parsed = ResolveNearbyRequestV1Schema.safeParse(raw);
      const handle = parsed.success ? decode(parsed.data.selectionToken) : null;
      if (!handle || handle.kind !== 0) return fail("invalid_request", "invalid_token", "The selection handle is invalid.");
      if (handle.observedAt + TTL_MS <= options.clock()) return fail("expired", "observation_expired", "The selected observation has expired. Refresh Nearby and select the aircraft again.");
      const key = parsed.data!.selectionToken, cached = resolutions.get(key); if (cached) return cached.result;
      const result = resolveHandle(handle); resolutions.set(key, { expiresAt: handle.observedAt + TTL_MS, result }); return result;
    },
    async getFlight(raw: unknown) {
      cleanup(); const parsed = GetFlightRequestV1Schema.safeParse(raw); if (!parsed.success) return fail("invalid_request", "invalid_input", "The flight request is invalid.");
      const target = parsed.data.target;
      if (target.kind === "instance") { const row = findOccurrence(target.flightInstanceId); return row ? detail(row) : fail("not_found", "flight_not_found", "No matching invented flight occurrence was found."); }
      if (target.kind === "choice") {
        const handle = decode(target.candidateToken);
        if (!handle || handle.kind === 0) return fail("invalid_request", "invalid_token", "The candidate handle is invalid.");
        if (handle.observedAt + TTL_MS <= options.clock()) return fail("expired", "choice_expired", "The ambiguity choice has expired.");
        const selected = evidence(handle), decision = selected && await resolver(selected, options.clock());
        if (!decision || decision.kind !== "ambiguous") return fail("invalid_request", "invalid_token", "The candidate handle is invalid.");
        return detail(occurrence(decision.occurrences[handle.kind - 1]!));
      }
      const query = target.query.replace(/[ -]/g, "").toUpperCase();
      if (query === "SYN104") return fail("unsupported", "unsupported_aircraft", "This invented aircraft has no supported detailed flight.");
      if (query !== "SYN101") return fail("unsupported", "unsupported_query", "Only the documented invented lookup fixture is supported.");
      if (!target.date) return fail("unavailable", "date_unavailable", "An explicit service date is required for lookup.");
      const serviceDate = /^\d{4}-\d{2}-\d{2}$/.test(target.date) ? target.date : chicagoRelativeDate(options.clock(), target.date as "today" | "tomorrow" | "yesterday");
      const today = Date.parse(chicagoRelativeDate(options.clock(), "today"));
      if (Date.parse(serviceDate) < today - 14 * 86_400_000 || Date.parse(serviceDate) > today + 86_400_000)
        return fail("unavailable", "date_unavailable", "The requested date is outside this invented fixture's retained window.");
      return detail(occurrence(occurrenceSeed({ callsign: query, serviceDate, originIata: target.originIata ?? "ORD", destinationIata: target.destinationIata ?? "BOS", basis: "explicit_lookup" })));
    },
    cleanup, diagnostics: () => ({ ...stats }),
  };
}

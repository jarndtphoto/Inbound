import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Sql } from "../db";
import {
  FlightCandidateV1Schema, FlightResultV1Schema, InboundFlightV1Schema,
  type FlightCandidateV1, type FlightResultV1, type InboundFlightV1,
} from "./contracts";

export const SELECTION_TTL_MS = 90_000;
export const CANDIDATE_TTL_MS = 90_000;
export const HANDOFF_LEASE_MS = 5_000;
export const MAX_HANDOFF_ATTEMPTS = 3;
export const OCCURRENCE_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;

const routeSchema = z.strictObject({
  originIata: z.string().regex(/^[A-Z]{3}$/).nullable(),
  destinationIata: z.string().regex(/^[A-Z]{3}$/).nullable(),
  verification: z.enum(["unknown", "hint", "confirmed"]),
  checkedAt: z.iso.datetime().nullable(),
});
const datedBindingSchema = z.strictObject({
  sessionKey: z.string().min(1).max(128), observedCallsign: z.string().min(1).max(16),
  serviceDate: z.iso.date(), confirmedAt: z.iso.datetime(),
});
export const SelectionEvidenceSchema = z.strictObject({
  environment: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/), collectionVersion: z.number().int().min(1),
  cardId: z.uuid(), radarId: z.uuid(), privateAircraftIdentity: z.string().min(1).max(128),
  sessionKey: z.string().min(1).max(128), observedCallsign: z.string().min(1).max(16).nullable(),
  registration: z.string().min(1).max(16).nullable(), observedAt: z.iso.datetime(),
  latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180),
  route: routeSchema, datedBinding: datedBindingSchema.nullable(),
});
export type SelectionEvidence = z.infer<typeof SelectionEvidenceSchema>;

export const OccurrenceSeedSchema = z.strictObject({
  operatingIdent: z.string().min(1).max(16), displayIdent: z.string().min(1).max(16),
  serviceDate: z.iso.date(), serviceTimeZone: z.string().min(1).max(64),
  originIata: z.string().regex(/^[A-Z]{3}$/), destinationIata: z.string().regex(/^[A-Z]{3}$/),
  scheduledDepartureAt: z.iso.datetime().nullable(),
  identityEvidence: z.strictObject({
    privateAircraftIdentity: z.string().min(1).max(128).nullable(),
    sessionKey: z.string().min(1).max(128).nullable(),
    observedCallsign: z.string().min(1).max(16).nullable(),
    registration: z.string().min(1).max(16).nullable(),
    basis: z.enum(["dated_binding", "session_route", "normalized_identity", "explicit_lookup"]),
  }),
});
export type OccurrenceSeed = z.infer<typeof OccurrenceSeedSchema>;
export type StoredOccurrence = OccurrenceSeed & { flightInstanceId: string; createdAt: string; lastConfirmedAt: string; retainUntil: string };

export type StoredSelection = SelectionEvidence & {
  tokenHash: string; issuedAt: string; expiresAt: string; publicResult: FlightResultV1 | null;
  resolutionError: { code: "backend_unavailable"; message: string } | null;
  resolutionAttempts: number; nextAttemptAt: string; leaseOwner: string | null;
  leaseUntil: string | null; fencingGeneration: number; failureBackoffSeconds: number;
};
export type ResolutionLease = { tokenHash: string; owner: string; generation: number; selection: StoredSelection };
export type DetailLease = { flightInstanceId: string; owner: string; generation: number };
export type StoredDetail = {
  flightInstanceId: string; publicFlight: InboundFlightV1 | null; acceptedAt: string | null;
  nextRevalidationAt: string; detailError: { code: "backend_unavailable"; message: string } | null;
  buildAttempts: number; leaseOwner: string | null; leaseUntil: string | null;
  fencingGeneration: number; failureBackoffSeconds: number; retainUntil: string;
};

export interface FlightHandoffStore {
  issueSelection(evidence: SelectionEvidence, nowMs: number): Promise<{ token: string; expiresAt: string }>;
  readSelection(token: string, nowMs: number): Promise<StoredSelection | null>;
  claimResolution(tokenHash: string, owner: string, nowMs: number): Promise<ResolutionLease | null>;
  publishResolution(lease: ResolutionLease, result: FlightResultV1, nowMs: number): Promise<boolean>;
  failResolution(lease: ResolutionLease, message: string, nowMs: number): Promise<boolean>;
  ensureOccurrence(seed: OccurrenceSeed, nowMs: number): Promise<StoredOccurrence>;
  readOccurrence(flightInstanceId: string, nowMs: number): Promise<StoredOccurrence | null>;
  issueChoices(selectionTokenHash: string, occurrences: readonly StoredOccurrence[], nowMs: number): Promise<FlightCandidateV1[]>;
  readChoice(token: string, nowMs: number): Promise<{ candidate: FlightCandidateV1; flightInstanceId: string; expiresAt: string } | null>;
  readDetail(flightInstanceId: string, nowMs: number): Promise<StoredDetail | null>;
  claimDetail(flightInstanceId: string, owner: string, nowMs: number): Promise<DetailLease | null>;
  publishDetail(lease: DetailLease, flight: InboundFlightV1, refreshAfterSeconds: number, nowMs: number): Promise<boolean>;
  failDetail(lease: DetailLease, message: string, nowMs: number): Promise<boolean>;
  cleanup(nowMs: number): Promise<{ selections: number; choices: number; details: number; occurrences: number }>;
}

export function opaqueToken(): string { return randomBytes(32).toString("base64url"); }
export function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
function occurrenceHash(seed: OccurrenceSeed): string {
  return createHash("sha256").update(JSON.stringify([seed.operatingIdent, seed.serviceDate, seed.serviceTimeZone,
    seed.originIata, seed.destinationIata, seed.scheduledDepartureAt])).digest("hex");
}
function iso(ms: number): string { return new Date(ms).toISOString(); }
function candidateFor(occurrence: StoredOccurrence, token: string, expiresAt: string): FlightCandidateV1 {
  return FlightCandidateV1Schema.parse({ candidateToken: token, expiresAt, displayIdent: occurrence.displayIdent,
    originIata: occurrence.originIata, destinationIata: occurrence.destinationIata,
    serviceDate: occurrence.serviceDate, serviceTimeZone: occurrence.serviceTimeZone,
    scheduledDepartureAt: occurrence.scheduledDepartureAt });
}

type MemoryChoice = { candidate: FlightCandidateV1; selectionTokenHash: string; flightInstanceId: string };
export function createMemoryFlightHandoffStore(): FlightHandoffStore & { diagnostics: () => object } {
  const selections = new Map<string, StoredSelection>();
  // The isolated fake store retains the raw handle only long enough to return
  // the same handle for the same authoritative observation. The durable SQL
  // implementation below stores hashes only and never depends on this map.
  const activeTokens = new Map<string, { token: string; hash: string }>();
  const occurrences = new Map<string, StoredOccurrence>();
  const occurrenceIds = new Map<string, string>();
  const choices = new Map<string, MemoryChoice>();
  const details = new Map<string, StoredDetail>();
  const counters = { selectionIssues: 0, resolutionClaims: 0, resolutionPublishes: 0, occurrenceCreates: 0,
    choiceIssues: 0, detailClaims: 0, detailPublishes: 0 };
  return {
    async issueSelection(raw, nowMs) {
      const evidence = SelectionEvidenceSchema.parse(raw); const observedMs = Date.parse(evidence.observedAt);
      const issuedMs = Math.max(nowMs, observedMs), expiresMs = Math.min(issuedMs + SELECTION_TTL_MS, observedMs + 120_000);
      if (!Number.isFinite(nowMs) || observedMs > nowMs + 1_000 || expiresMs <= issuedMs) throw new RangeError("Observation cannot receive a selection handle");
      const fingerprint = createHash("sha256").update(JSON.stringify(evidence)).digest("hex"), active = activeTokens.get(fingerprint);
      const activeRow = active ? selections.get(active.hash) : null;
      if (active && activeRow && Date.parse(activeRow.expiresAt) > nowMs) return { token: active.token, expiresAt: activeRow.expiresAt };
      const token = opaqueToken(), hash = tokenHash(token); counters.selectionIssues++;
      selections.set(hash, { ...structuredClone(evidence), tokenHash: hash, issuedAt: iso(issuedMs), expiresAt: iso(expiresMs),
        publicResult: null, resolutionError: null, resolutionAttempts: 0, nextAttemptAt: iso(issuedMs),
        leaseOwner: null, leaseUntil: null, fencingGeneration: 0, failureBackoffSeconds: 20 });
      activeTokens.set(fingerprint, { token, hash });
      return { token, expiresAt: iso(expiresMs) };
    },
    async readSelection(token) { const row = selections.get(tokenHash(token)); return row ? structuredClone(row) : null; },
    async claimResolution(hash, owner, nowMs) {
      const row = selections.get(hash); if (!row || row.publicResult || Date.parse(row.expiresAt) <= nowMs
        || Date.parse(row.nextAttemptAt) > nowMs || row.resolutionAttempts >= MAX_HANDOFF_ATTEMPTS
        || row.leaseUntil && Date.parse(row.leaseUntil) > nowMs) return null;
      row.leaseOwner = owner; row.leaseUntil = iso(nowMs + HANDOFF_LEASE_MS); row.fencingGeneration++;
      row.resolutionAttempts++; row.resolutionError = null; counters.resolutionClaims++;
      return { tokenHash: hash, owner, generation: row.fencingGeneration, selection: structuredClone(row) };
    },
    async publishResolution(lease, raw, nowMs) {
      const result = FlightResultV1Schema.parse(raw), row = selections.get(lease.tokenHash);
      if (!row || row.leaseOwner !== lease.owner || row.fencingGeneration !== lease.generation || Date.parse(row.leaseUntil!) <= nowMs) return false;
      row.publicResult = structuredClone(result); row.leaseOwner = null; row.leaseUntil = null; row.resolutionError = null;
      counters.resolutionPublishes++; return true;
    },
    async failResolution(lease, message, nowMs) {
      const row = selections.get(lease.tokenHash);
      if (!row || row.leaseOwner !== lease.owner || row.fencingGeneration !== lease.generation || Date.parse(row.leaseUntil!) <= nowMs) return false;
      row.resolutionError = { code: "backend_unavailable", message }; row.leaseOwner = null; row.leaseUntil = null;
      row.nextAttemptAt = iso(nowMs + row.failureBackoffSeconds * 1_000); row.failureBackoffSeconds = Math.min(row.failureBackoffSeconds * 2, 120);
      return true;
    },
    async ensureOccurrence(raw, nowMs) {
      const seed = OccurrenceSeedSchema.parse(raw), hash = occurrenceHash(seed), existingId = occurrenceIds.get(hash);
      if (existingId) { const row = occurrences.get(existingId)!; row.lastConfirmedAt = iso(nowMs); row.retainUntil = iso(nowMs + OCCURRENCE_RETENTION_MS); return structuredClone(row); }
      const row: StoredOccurrence = { ...structuredClone(seed), flightInstanceId: randomUUID(), createdAt: iso(nowMs),
        lastConfirmedAt: iso(nowMs), retainUntil: iso(nowMs + OCCURRENCE_RETENTION_MS) };
      occurrences.set(row.flightInstanceId, row); occurrenceIds.set(hash, row.flightInstanceId); counters.occurrenceCreates++; return structuredClone(row);
    },
    async readOccurrence(id, nowMs) { const row = occurrences.get(id); return row && Date.parse(row.retainUntil) > nowMs ? structuredClone(row) : null; },
    async issueChoices(selectionTokenHash, rows, nowMs) {
      const selection = selections.get(selectionTokenHash); if (!selection || Date.parse(selection.expiresAt) <= nowMs) throw new RangeError("Selection expired before ambiguity publication");
      counters.choiceIssues += rows.length;
      return rows.map(row => { const token = opaqueToken(), expiresAt = iso(Math.min(nowMs + CANDIDATE_TTL_MS, Date.parse(selection.expiresAt)));
        const candidate = candidateFor(row, token, expiresAt); choices.set(tokenHash(token), { candidate, selectionTokenHash, flightInstanceId: row.flightInstanceId }); return candidate; });
    },
    async readChoice(token) { const row = choices.get(tokenHash(token)); return row ? { candidate: structuredClone(row.candidate), flightInstanceId: row.flightInstanceId, expiresAt: row.candidate.expiresAt } : null; },
    async readDetail(id, nowMs) { const row = details.get(id); return row && Date.parse(row.retainUntil) > nowMs ? structuredClone(row) : null; },
    async claimDetail(id, owner, nowMs) {
      if (!occurrences.has(id)) return null;
      let row = details.get(id); if (!row) { row = { flightInstanceId: id, publicFlight: null, acceptedAt: null,
        nextRevalidationAt: iso(nowMs), detailError: null, buildAttempts: 0, leaseOwner: null, leaseUntil: null,
        fencingGeneration: 0, failureBackoffSeconds: 20, retainUntil: iso(nowMs + OCCURRENCE_RETENTION_MS) }; details.set(id, row); }
      if (row.publicFlight && Date.parse(row.nextRevalidationAt) > nowMs || row.leaseUntil && Date.parse(row.leaseUntil) > nowMs
        || row.buildAttempts >= MAX_HANDOFF_ATTEMPTS || Date.parse(row.retainUntil) <= nowMs) return null;
      row.leaseOwner = owner; row.leaseUntil = iso(nowMs + HANDOFF_LEASE_MS); row.fencingGeneration++; row.buildAttempts++; row.detailError = null; counters.detailClaims++;
      return { flightInstanceId: id, owner, generation: row.fencingGeneration };
    },
    async publishDetail(lease, raw, refreshAfterSeconds, nowMs) {
      const flight = InboundFlightV1Schema.parse(raw), row = details.get(lease.flightInstanceId);
      if (!row || row.leaseOwner !== lease.owner || row.fencingGeneration !== lease.generation || Date.parse(row.leaseUntil!) <= nowMs) return false;
      row.publicFlight = structuredClone(flight); row.acceptedAt = iso(nowMs); row.nextRevalidationAt = iso(nowMs + refreshAfterSeconds * 1_000);
      row.leaseOwner = null; row.leaseUntil = null; row.detailError = null; row.buildAttempts = 0; row.failureBackoffSeconds = 20;
      counters.detailPublishes++; return true;
    },
    async failDetail(lease, message, nowMs) {
      const row = details.get(lease.flightInstanceId);
      if (!row || row.leaseOwner !== lease.owner || row.fencingGeneration !== lease.generation || Date.parse(row.leaseUntil!) <= nowMs) return false;
      row.detailError = { code: "backend_unavailable", message }; row.leaseOwner = null; row.leaseUntil = null;
      row.nextRevalidationAt = iso(nowMs + row.failureBackoffSeconds * 1_000); row.failureBackoffSeconds = Math.min(row.failureBackoffSeconds * 2, 120); return true;
    },
    async cleanup(nowMs) {
      let selectionCount = 0, choiceCount = 0, detailCount = 0, occurrenceCount = 0;
      for (const [hash, row] of choices) if (Date.parse(row.candidate.expiresAt) <= nowMs) { choices.delete(hash); choiceCount++; }
      for (const [hash, row] of selections) if (Date.parse(row.expiresAt) <= nowMs && (!row.leaseUntil || Date.parse(row.leaseUntil) <= nowMs)) { selections.delete(hash); selectionCount++; }
      for (const [fingerprint, active] of activeTokens) if (!selections.has(active.hash)) activeTokens.delete(fingerprint);
      for (const [id, row] of details) if (Date.parse(row.retainUntil) <= nowMs && (!row.leaseUntil || Date.parse(row.leaseUntil) <= nowMs)) { details.delete(id); detailCount++; }
      for (const [id, row] of occurrences) if (Date.parse(row.retainUntil) <= nowMs && !details.has(id)) { occurrences.delete(id); occurrenceIds.delete(occurrenceHash(row)); occurrenceCount++; }
      return { selections: selectionCount, choices: choiceCount, details: detailCount, occurrences: occurrenceCount };
    },
    diagnostics: () => ({ ...counters, rows: { selections: selections.size, occurrences: occurrences.size, choices: choices.size, details: details.size } }),
  };
}

type Instant = Date | string;
const at = (value: Instant): string => (value instanceof Date ? value : new Date(value)).toISOString();
type SelectionRow = {
  environment: string; token_hash: Uint8Array; collection_version: string | number; card_id: string; radar_id: string;
  private_aircraft_identity: string; session_key: string; observed_callsign: string | null; registration: string | null;
  observed_at: Instant; latitude: number; longitude: number; route_evidence: SelectionEvidence["route"];
  dated_binding: SelectionEvidence["datedBinding"]; issued_at: Instant; expires_at: Instant; public_result: FlightResultV1 | null;
  resolution_error: StoredSelection["resolutionError"]; resolution_attempts: number; lease_owner: string | null;
  lease_until: Instant | null; fencing_generation: string | number; next_attempt_at: Instant; failure_backoff_seconds: number;
};
type OccurrenceRow = { flight_instance_id: string; operating_ident: string; display_ident: string; service_date: string | Date;
  service_time_zone: string; origin_iata: string; destination_iata: string; scheduled_departure_at: Instant | null;
  identity_evidence: OccurrenceSeed["identityEvidence"]; created_at: Instant; last_confirmed_at: Instant; retain_until: Instant };
type DetailRow = { flight_instance_id: string; public_flight: InboundFlightV1 | null; accepted_at: Instant | null;
  next_revalidation_at: Instant; detail_error: StoredDetail["detailError"]; build_attempts: number; lease_owner: string | null;
  lease_until: Instant | null; fencing_generation: string | number; failure_backoff_seconds: number; retain_until: Instant };

function storedSelection(row: SelectionRow): StoredSelection {
  return SelectionEvidenceSchema.extend({ tokenHash: z.string(), issuedAt: z.string(), expiresAt: z.string() }).passthrough().parse({
    environment: row.environment, collectionVersion: Number(row.collection_version), cardId: row.card_id, radarId: row.radar_id,
    privateAircraftIdentity: row.private_aircraft_identity, sessionKey: row.session_key, observedCallsign: row.observed_callsign,
    registration: row.registration, observedAt: at(row.observed_at), latitude: row.latitude, longitude: row.longitude,
    route: row.route_evidence, datedBinding: row.dated_binding, tokenHash: Buffer.from(row.token_hash).toString("hex"),
    issuedAt: at(row.issued_at), expiresAt: at(row.expires_at), publicResult: row.public_result ? FlightResultV1Schema.parse(row.public_result) : null,
    resolutionError: row.resolution_error, resolutionAttempts: row.resolution_attempts, leaseOwner: row.lease_owner,
    leaseUntil: row.lease_until ? at(row.lease_until) : null, fencingGeneration: Number(row.fencing_generation),
    nextAttemptAt: at(row.next_attempt_at), failureBackoffSeconds: row.failure_backoff_seconds,
  }) as StoredSelection;
}
function storedOccurrence(row: OccurrenceRow): StoredOccurrence {
  return OccurrenceSeedSchema.extend({ flightInstanceId: z.uuid(), createdAt: z.string(), lastConfirmedAt: z.string(), retainUntil: z.string() }).parse({
    flightInstanceId: row.flight_instance_id, operatingIdent: row.operating_ident, displayIdent: row.display_ident,
    serviceDate: typeof row.service_date === "string" ? row.service_date.slice(0, 10) : row.service_date.toISOString().slice(0, 10),
    serviceTimeZone: row.service_time_zone, originIata: row.origin_iata, destinationIata: row.destination_iata,
    scheduledDepartureAt: row.scheduled_departure_at ? at(row.scheduled_departure_at) : null, identityEvidence: row.identity_evidence,
    createdAt: at(row.created_at), lastConfirmedAt: at(row.last_confirmed_at), retainUntil: at(row.retain_until),
  });
}
function storedDetail(row: DetailRow): StoredDetail { return { flightInstanceId: row.flight_instance_id,
  publicFlight: row.public_flight ? InboundFlightV1Schema.parse(row.public_flight) : null, acceptedAt: row.accepted_at ? at(row.accepted_at) : null,
  nextRevalidationAt: at(row.next_revalidation_at), detailError: row.detail_error, buildAttempts: row.build_attempts,
  leaseOwner: row.lease_owner, leaseUntil: row.lease_until ? at(row.lease_until) : null,
  fencingGeneration: Number(row.fencing_generation), failureBackoffSeconds: row.failure_backoff_seconds, retainUntil: at(row.retain_until) };
}

export function createPostgresFlightHandoffStore(options: { environment: string; sqlProvider?: () => Promise<Sql>; clock?: "database" | "provided" }): FlightHandoffStore {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(options.environment)) throw new RangeError("Invalid handoff environment");
  const sqlProvider = options.sqlProvider ?? (async () => {
    if (!process.env.DATABASE_URL?.trim()) throw new Error("Flight handoff requires the shared Inbound Postgres database");
    const db = await import("../db"); if (db.dbSource !== "neon") throw new Error("Flight handoff requires the shared Inbound Postgres database"); return db.getSql();
  });
  const clockParam = (nowMs: number) => options.clock === "provided" ? new Date(nowMs) : null;
  const clock = "with clock as (select coalesce($1::timestamptz, clock_timestamp()) as instant)";
  const readSelectionHash = async (hash: string) => {
    const sql = await sqlProvider(); const rows = await sql.query<SelectionRow>(`select * from inbound_plugin_v1.selection_handle where environment=$1 and token_hash=$2`, [options.environment, Buffer.from(hash, "hex")]);
    return rows[0] ? storedSelection(rows[0]) : null;
  };
  const readOccurrenceId = async (id: string, nowMs: number) => {
    const sql = await sqlProvider(); const rows = await sql.query<OccurrenceRow>(`${clock} select o.* from inbound_plugin_v1.occurrence_registry o,clock where environment=$2 and flight_instance_id=$3::uuid and retain_until>clock.instant`, [clockParam(nowMs), options.environment, id]);
    return rows[0] ? storedOccurrence(rows[0]) : null;
  };
  return {
    async issueSelection(raw, nowMs) {
      const evidence = SelectionEvidenceSchema.parse(raw); if (evidence.environment !== options.environment) throw new RangeError("Selection environment mismatch");
      const token = opaqueToken(), hash = tokenHash(token), sql = await sqlProvider();
      const rows = await sql.query<{ expires_at: Instant }>(`${clock}
        insert into inbound_plugin_v1.selection_handle (environment,token_hash,collection_version,card_id,radar_id,
          private_aircraft_identity,session_key,observed_callsign,registration,observed_at,latitude,longitude,
          route_evidence,dated_binding,issued_at,expires_at,next_attempt_at)
        select $2,$3,$4,$5::uuid,$6::uuid,$7,$8,$9,$10,$11::timestamptz,$12,$13,$14::jsonb,$15::jsonb,
          greatest(clock.instant,$11::timestamptz),least(greatest(clock.instant,$11::timestamptz)+interval '90 seconds',$11::timestamptz+interval '120 seconds'),greatest(clock.instant,$11::timestamptz)
        from clock where $11::timestamptz<=clock.instant+interval '1 second'
          and least(greatest(clock.instant,$11::timestamptz)+interval '90 seconds',$11::timestamptz+interval '120 seconds')>greatest(clock.instant,$11::timestamptz)
        returning expires_at`, [clockParam(nowMs), evidence.environment, Buffer.from(hash, "hex"), evidence.collectionVersion,
        evidence.cardId, evidence.radarId, evidence.privateAircraftIdentity, evidence.sessionKey, evidence.observedCallsign,
        evidence.registration, evidence.observedAt, evidence.latitude, evidence.longitude, JSON.stringify(evidence.route), JSON.stringify(evidence.datedBinding)]);
      if (!rows[0]) throw new RangeError("Observation cannot receive a selection handle"); return { token, expiresAt: at(rows[0].expires_at) };
    },
    async readSelection(token) { return readSelectionHash(tokenHash(token)); },
    async claimResolution(hash, owner, nowMs) {
      const sql = await sqlProvider(); const rows = await sql.query<SelectionRow>(`${clock}
        update inbound_plugin_v1.selection_handle s set lease_owner=$4::uuid,lease_until=clock.instant+interval '5 seconds',
          fencing_generation=s.fencing_generation+1,resolution_attempts=s.resolution_attempts+1,resolution_error=null
        from clock where s.environment=$2 and s.token_hash=$3 and s.public_result is null and s.expires_at>clock.instant
          and s.next_attempt_at<=clock.instant and s.resolution_attempts<3 and (s.lease_until is null or s.lease_until<=clock.instant)
        returning s.*`, [clockParam(nowMs), options.environment, Buffer.from(hash, "hex"), owner]);
      return rows[0] ? { tokenHash: hash, owner, generation: Number(rows[0].fencing_generation), selection: storedSelection(rows[0]) } : null;
    },
    async publishResolution(lease, raw, nowMs) {
      const result = FlightResultV1Schema.parse(raw), sql = await sqlProvider(); const rows = await sql.query(`${clock}
        update inbound_plugin_v1.selection_handle s set public_result=$6::jsonb,result_accepted_at=clock.instant,
          resolution_error=null,lease_owner=null,lease_until=null
        from clock where s.environment=$2 and s.token_hash=$3 and s.lease_owner=$4::uuid and s.fencing_generation=$5 and s.lease_until>clock.instant returning s.token_hash`,
      [clockParam(nowMs), options.environment, Buffer.from(lease.tokenHash, "hex"), lease.owner, lease.generation, JSON.stringify(result)]); return rows.length === 1;
    },
    async failResolution(lease, message, nowMs) {
      const sql = await sqlProvider(); const rows = await sql.query(`${clock}
        update inbound_plugin_v1.selection_handle s set resolution_error=$6::jsonb,lease_owner=null,lease_until=null,
          next_attempt_at=clock.instant+s.failure_backoff_seconds*interval '1 second',failure_backoff_seconds=least(s.failure_backoff_seconds*2,120)
        from clock where s.environment=$2 and s.token_hash=$3 and s.lease_owner=$4::uuid and s.fencing_generation=$5 and s.lease_until>clock.instant returning s.token_hash`,
      [clockParam(nowMs), options.environment, Buffer.from(lease.tokenHash, "hex"), lease.owner, lease.generation, JSON.stringify({ code: "backend_unavailable", message })]); return rows.length === 1;
    },
    async ensureOccurrence(raw, nowMs) {
      const seed = OccurrenceSeedSchema.parse(raw), hash = occurrenceHash(seed), id = randomUUID(), sql = await sqlProvider();
      const rows = await sql.query<OccurrenceRow>(`${clock}
        insert into inbound_plugin_v1.occurrence_registry (environment,flight_instance_id,occurrence_key_hash,operating_ident,
          display_ident,service_date,service_time_zone,origin_iata,destination_iata,scheduled_departure_at,identity_evidence,
          created_at,last_confirmed_at,retain_until)
        select $2,$3::uuid,$4,$5,$6,$7::date,$8,$9,$10,$11::timestamptz,$12::jsonb,clock.instant,clock.instant,clock.instant+interval '14 days' from clock
        on conflict (environment,occurrence_key_hash) do update set last_confirmed_at=(select instant from clock),retain_until=(select instant from clock)+interval '14 days'
        returning *`, [clockParam(nowMs), options.environment, id, Buffer.from(hash, "hex"), seed.operatingIdent, seed.displayIdent,
        seed.serviceDate, seed.serviceTimeZone, seed.originIata, seed.destinationIata, seed.scheduledDepartureAt, JSON.stringify(seed.identityEvidence)]);
      return storedOccurrence(rows[0]);
    },
    readOccurrence: readOccurrenceId,
    async issueChoices(selectionTokenHash, rows, nowMs) {
      const output: FlightCandidateV1[] = [], sql = await sqlProvider();
      for (const occurrence of rows) {
        const token = opaqueToken(), hash = tokenHash(token); const inserted = await sql.query<{ expires_at: Instant }>(`${clock}
          insert into inbound_plugin_v1.candidate_choice (environment,token_hash,selection_token_hash,flight_instance_id,public_candidate,issued_at,expires_at)
          select $2,$3,$4,$5::uuid,$6::jsonb,clock.instant,least(clock.instant+interval '90 seconds',s.expires_at)
          from inbound_plugin_v1.selection_handle s,clock where s.environment=$2 and s.token_hash=$4 and s.expires_at>clock.instant
            and least(clock.instant+interval '90 seconds',s.expires_at)>clock.instant returning expires_at`,
        [clockParam(nowMs), options.environment, Buffer.from(hash, "hex"), Buffer.from(selectionTokenHash, "hex"), occurrence.flightInstanceId,
          JSON.stringify({ displayIdent: occurrence.displayIdent, originIata: occurrence.originIata, destinationIata: occurrence.destinationIata,
            serviceDate: occurrence.serviceDate, serviceTimeZone: occurrence.serviceTimeZone, scheduledDepartureAt: occurrence.scheduledDepartureAt })]);
        if (!inserted[0]) throw new RangeError("Selection expired before ambiguity publication"); output.push(candidateFor(occurrence, token, at(inserted[0].expires_at)));
      }
      return output;
    },
    async readChoice(token) {
      const sql = await sqlProvider(); const rows = await sql.query<{ flight_instance_id: string; public_candidate: Omit<FlightCandidateV1, "candidateToken" | "expiresAt">; expires_at: Instant }>(
        `select flight_instance_id,public_candidate,expires_at from inbound_plugin_v1.candidate_choice where environment=$1 and token_hash=$2`, [options.environment, Buffer.from(tokenHash(token), "hex")]);
      if (!rows[0]) return null; const expiresAt = at(rows[0].expires_at); return { flightInstanceId: rows[0].flight_instance_id, expiresAt,
        candidate: FlightCandidateV1Schema.parse({ ...rows[0].public_candidate, candidateToken: token, expiresAt }) };
    },
    async readDetail(id, nowMs) {
      const sql = await sqlProvider(); const rows = await sql.query<DetailRow>(`${clock} select d.* from inbound_plugin_v1.detail_snapshot d,clock where environment=$2 and flight_instance_id=$3::uuid and contract_version='1.0' and retain_until>clock.instant`, [clockParam(nowMs), options.environment, id]);
      return rows[0] ? storedDetail(rows[0]) : null;
    },
    async claimDetail(id, owner, nowMs) {
      const sql = await sqlProvider(); await sql.query(`${clock}
        insert into inbound_plugin_v1.detail_snapshot (environment,flight_instance_id,next_revalidation_at,retain_until)
        select $2,$3::uuid,clock.instant,least(o.retain_until,clock.instant+interval '14 days') from inbound_plugin_v1.occurrence_registry o,clock
        where o.environment=$2 and o.flight_instance_id=$3::uuid and o.retain_until>clock.instant on conflict do nothing`, [clockParam(nowMs), options.environment, id]);
      const rows = await sql.query<DetailRow>(`${clock}
        update inbound_plugin_v1.detail_snapshot d set lease_owner=$4::uuid,lease_until=clock.instant+interval '5 seconds',
          fencing_generation=d.fencing_generation+1,build_attempts=d.build_attempts+1,detail_error=null
        from clock where d.environment=$2 and d.flight_instance_id=$3::uuid and d.contract_version='1.0' and d.retain_until>clock.instant
          and d.next_revalidation_at<=clock.instant and d.build_attempts<3
          and (d.lease_until is null or d.lease_until<=clock.instant) returning d.*`, [clockParam(nowMs), options.environment, id, owner]);
      return rows[0] ? { flightInstanceId: id, owner, generation: Number(rows[0].fencing_generation) } : null;
    },
    async publishDetail(lease, raw, refreshAfterSeconds, nowMs) {
      const flight = InboundFlightV1Schema.parse(raw), sql = await sqlProvider(); const rows = await sql.query(`${clock}
        update inbound_plugin_v1.detail_snapshot d set public_flight=$6::jsonb,accepted_at=clock.instant,
          next_revalidation_at=clock.instant+$7*interval '1 second',detail_error=null,lease_owner=null,lease_until=null,
          build_attempts=0,failure_backoff_seconds=20
        from clock where d.environment=$2 and d.flight_instance_id=$3::uuid and d.contract_version='1.0'
          and d.lease_owner=$4::uuid and d.fencing_generation=$5 and d.lease_until>clock.instant returning d.flight_instance_id`,
      [clockParam(nowMs), options.environment, lease.flightInstanceId, lease.owner, lease.generation, JSON.stringify(flight), refreshAfterSeconds]); return rows.length === 1;
    },
    async failDetail(lease, message, nowMs) {
      const sql = await sqlProvider(); const rows = await sql.query(`${clock}
        update inbound_plugin_v1.detail_snapshot d set detail_error=$6::jsonb,lease_owner=null,lease_until=null,
          next_revalidation_at=clock.instant+d.failure_backoff_seconds*interval '1 second',failure_backoff_seconds=least(d.failure_backoff_seconds*2,120)
        from clock where d.environment=$2 and d.flight_instance_id=$3::uuid and d.contract_version='1.0'
          and d.lease_owner=$4::uuid and d.fencing_generation=$5 and d.lease_until>clock.instant returning d.flight_instance_id`,
      [clockParam(nowMs), options.environment, lease.flightInstanceId, lease.owner, lease.generation, JSON.stringify({ code: "backend_unavailable", message })]); return rows.length === 1;
    },
    async cleanup(nowMs) {
      const sql = await sqlProvider(), values = [clockParam(nowMs), options.environment];
      const choices = await sql.query(`${clock} delete from inbound_plugin_v1.candidate_choice c using clock where c.environment=$2 and c.expires_at<=clock.instant returning c.token_hash`, values);
      const selections = await sql.query(`${clock} delete from inbound_plugin_v1.selection_handle s using clock where s.environment=$2 and s.expires_at<=clock.instant and (s.lease_until is null or s.lease_until<=clock.instant) returning s.token_hash`, values);
      const details = await sql.query(`${clock} delete from inbound_plugin_v1.detail_snapshot d using clock where d.environment=$2 and d.retain_until<=clock.instant and (d.lease_until is null or d.lease_until<=clock.instant) returning d.flight_instance_id`, values);
      const occurrences = await sql.query(`${clock} delete from inbound_plugin_v1.occurrence_registry o using clock where o.environment=$2 and o.retain_until<=clock.instant and not exists (select 1 from inbound_plugin_v1.detail_snapshot d where d.environment=o.environment and d.flight_instance_id=o.flight_instance_id) returning o.flight_instance_id`, values);
      return { selections: selections.length, choices: choices.length, details: details.length, occurrences: occurrences.length };
    },
  };
}

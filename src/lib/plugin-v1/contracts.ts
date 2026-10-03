import { z } from "zod";

/** Definition-only V1 boundary. Never imports a provider, story engine, or DB. */
export const SCHEMA_VERSION = "1.0" as const;
export const NEARBY_PAYLOAD_BYTES = 32 * 1024;
export const DETAIL_PAYLOAD_BYTES = 64 * 1024;

const text = (max: number) => z.string().min(1).max(max).refine(
  s => s === s.trim() && !/[\u0000-\u001f\u007f<>]|https?:\/\/|www\./i.test(s),
  "Expected bounded, sanitized display text",
);
export const TimestampSchema = z.iso.datetime().max(32);
export const ServiceDateSchema = z.iso.date();
export const TimeZoneSchema = text(64).refine(s => {
  if (!s.includes("/") && s !== "UTC") return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: s }); return true; }
  catch { return false; }
}, "Expected an IANA time zone");
export const OpaqueIdSchema = z.uuid();
export const HandleSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const LatitudeSchema = z.number().min(-90).max(90);
export const LongitudeSchema = z.number().min(-180).max(180);
export const IataSchema = z.string().regex(/^[A-Z]{3}$/);
export const IcaoSchema = z.string().regex(/^[A-Z0-9]{4}$/);
export const DisplayIdentSchema = z.string().min(1).max(16).regex(/^[A-Z0-9][A-Z0-9 -]*$/);
export const SourceLabelSchema = z.enum(["ADS-B", "Inbound", "Flight schedule", "Airline", "Airport"]);
export const RadiusSchema = z.union([z.literal(12), z.literal(25), z.literal(38)]);
const age = z.number().min(0).max(86400 * 14);
const retry = z.number().int().min(20).max(120).nullable();
const areaName = z.string().min(1).max(64).refine(s => !!s.trim() && !/[\u0000-\u001f\u007f]/.test(s));
const basisValues = ["provider_reported", "provider_actual", "provider_estimated", "inbound_detected", "inbound_inferred", "inbound_estimated", "derived", "unknown"] as const;
export const BasisSchema = z.enum(basisValues);
export type Basis = z.infer<typeof BasisSchema>;
export type Fact<T> = { value: NonNullable<T>; basis: Basis; checkedAt: string | null; sourceLabel: z.infer<typeof SourceLabelSchema> | null };
export function factSchema<T extends z.ZodType>(value: T) {
  return z.strictObject({
    value: value.refine(v => v !== null && v !== undefined, "A missing fact must be null"),
    basis: BasisSchema,
    checkedAt: TimestampSchema.nullable(),
    sourceLabel: SourceLabelSchema.nullable(),
  });
}
export const TimestampFactSchema = factSchema(TimestampSchema);
const timeSlot = (basis: Basis) => TimestampFactSchema.refine(f => f.basis === basis, "Event slot and basis disagree").nullable();
export const EventTimeV1Schema = z.strictObject({
  scheduled: timeSlot("provider_reported"),
  providerEstimated: timeSlot("provider_estimated"),
  providerActual: timeSlot("provider_actual"),
  inboundEstimated: timeSlot("inbound_estimated"),
  detected: timeSlot("inbound_detected"),
  selected: TimestampFactSchema.nullable(),
});
export const AirportV1Schema = z.strictObject({
  iata: IataSchema, icao: IcaoSchema, name: text(80), city: text(64),
  timeZone: TimeZoneSchema, latitude: LatitudeSchema, longitude: LongitudeSchema,
});
export const RunwayV1Schema = z.strictObject({
  designation: z.string().regex(/^(?:0[1-9]|[12][0-9]|3[0-6])[LRC]?$/),
  role: z.enum(["reported", "expected"]), basis: BasisSchema,
  checkedAt: TimestampSchema.nullable(), sourceLabel: SourceLabelSchema.nullable(),
});
export const DelayV1Schema = z.strictObject({
  minutes: z.number().min(-10080).max(10080),
  baselineKind: z.enum(["published_schedule", "inbound_original_baseline", "unknown"]),
  baselineAt: TimestampSchema.nullable(), basis: z.literal("derived"), checkedAt: TimestampSchema.nullable(),
}).refine(d => d.baselineKind === "unknown" ? d.baselineAt === null : d.baselineAt !== null, "Delay baseline metadata disagree");
export const MotionPhaseSchema = z.enum(["taxi", "climb", "cruise", "descent", "approach", "parked"]);
export type MotionPhase = z.infer<typeof MotionPhaseSchema>;
export const MOTION_LABELS: Readonly<Record<MotionPhase, string>> = Object.freeze({
  taxi: "Taxiing", climb: "Climbing", cruise: "In flight", descent: "Descending", approach: "Descending", parked: "At rest",
});
export const AircraftV1Schema = z.strictObject({
  typeCode: z.string().min(1).max(8).regex(/^[A-Z0-9-]+$/).nullable(),
  typeName: text(80).nullable(), registration: DisplayIdentSchema.nullable(),
}).refine(a => a.typeCode !== null || a.typeName !== null || a.registration !== null, "Use aircraft:null when all metadata is missing");
export const NearbyAreaInputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("preset"), nameOrId: areaName }),
  z.strictObject({ kind: z.literal("airport"), code: areaName }),
]);
export const NearbyRequestV1Schema = z.strictObject({
  area: NearbyAreaInputSchema.nullable(), radiusNm: RadiusSchema.optional(),
  limit: z.number().int().min(1).max(5).optional(), includePosition: z.boolean().optional(),
});
export const ResolvedAreaV1Schema = z.strictObject({
  id: z.enum(["preset:chicago", "airport:KORD", "airport:KMDW"]),
  kind: z.enum(["preset", "airport"]), label: text(64),
  reference: z.strictObject({ latitude: LatitudeSchema, longitude: LongitudeSchema, label: text(64) }),
  radiusNm: RadiusSchema, associatedAirports: z.array(IcaoSchema).min(1).max(2),
}).refine(a => a.kind === (a.id.startsWith("preset:") ? "preset" : "airport"), "Area kind and ID disagree");
export const AreaChoiceSchema = z.strictObject({ area: NearbyAreaInputSchema, label: text(64) });
export const NearbyWarningSchema = z.enum(["partial_coverage", "coverage_limited", "refresh_delayed", "stale_data"]);
export const InboundNearbyFlightSchema = z.strictObject({
  cardId: OpaqueIdSchema,
  identity: z.strictObject({ displayIdent: DisplayIdentSchema, observedCallsign: DisplayIdentSchema.nullable(), flightNumber: DisplayIdentSchema.nullable(), airlineName: text(64).nullable() }),
  route: z.strictObject({ originIata: IataSchema.nullable(), destinationIata: IataSchema.nullable(), verification: z.enum(["confirmed", "hint", "unknown"]), checkedAt: TimestampSchema.nullable() }),
  altitudeFt: z.number().min(500).max(200000),
  motion: z.strictObject({ phase: MotionPhaseSchema, label: text(32), verticalTrend: z.enum(["rising", "falling", "level", "unknown"]) }),
  proximity: z.strictObject({ distanceNm: z.number().min(0).max(38) }),
  freshness: z.strictObject({ observedAt: TimestampSchema, ageSeconds: z.number().min(0).max(120), status: z.enum(["current", "stale"]), sourceLabel: SourceLabelSchema.nullable() }),
  selection: z.strictObject({ state: z.enum(["unresolved", "resolved", "unsupported"]), token: HandleSchema.nullable(), expiresAt: TimestampSchema.nullable(), flightInstanceId: OpaqueIdSchema.nullable() }),
  position: z.strictObject({ latitude: LatitudeSchema, longitude: LongitudeSchema, kind: z.enum(["observed", "extrapolated"]) }).nullable(),
  aircraft: AircraftV1Schema.nullable(),
}).superRefine((f, ctx) => {
  const fail = (message: string, path: string[]) => ctx.addIssue({ code: "custom", message, path });
  const r = f.route;
  if (r.verification === "unknown" && (r.originIata !== null || r.destinationIata !== null || r.checkedAt !== null)) fail("Unknown route has no evidence", ["route"]);
  if (r.verification === "hint" && ((!r.originIata && !r.destinationIata) || !r.checkedAt)) fail("Hint needs an endpoint and evidence time", ["route"]);
  if (r.verification === "confirmed" && (!r.originIata || !r.destinationIata || !r.checkedAt)) fail("Confirmed route needs both endpoints and evidence time", ["route"]);
  if (f.identity.flightNumber !== null && (r.verification !== "confirmed" || f.selection.state !== "resolved")) fail("Flight number needs a dated occurrence binding", ["identity", "flightNumber"]);
  if (f.motion.label !== MOTION_LABELS[f.motion.phase]) fail("Motion label must be Inbound-owned", ["motion", "label"]);
  if (f.freshness.status !== (f.freshness.ageSeconds <= 45 ? "current" : "stale")) fail("Freshness status and age disagree", ["freshness"]);
  const s = f.selection;
  if ((s.token === null) !== (s.expiresAt === null)) fail("Token and expiry must be paired", ["selection"]);
  if ((s.state === "resolved") !== (s.flightInstanceId !== null)) fail("Only a resolved selection has an instance ID", ["selection"]);
  if (s.state === "unsupported" && (s.token !== null || s.expiresAt !== null)) fail("Unsupported selection has no handle", ["selection"]);
  if (s.state === "unresolved" && s.token === null) fail("Unresolved current observation needs a handle", ["selection"]);
  if (s.expiresAt && (Date.parse(s.expiresAt) > Date.parse(f.freshness.observedAt) + 120000 || Date.parse(s.expiresAt) <= Date.parse(f.freshness.observedAt))) fail("Handle cannot extend observation lifetime", ["selection", "expiresAt"]);
});
const nearbyInvalidCodes = ["area_required", "unsupported_area", "invalid_radius", "invalid_limit", "invalid_input"] as const;
const nearbyUnavailableCodes = ["warming", "feed_unavailable", "backend_unavailable"] as const;
export const NearbyErrorSchema = z.strictObject({ code: z.enum([...nearbyInvalidCodes, ...nearbyUnavailableCodes]), message: text(160) });

/** UTF-8 bound applies to the serialized boundary, not a provider payload. */
export function serializedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
export const NearbyFlightsResponseV1Schema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION), status: z.enum(["ok", "empty", "unavailable", "invalid_request"]),
  responseAt: TimestampSchema, snapshotAt: TimestampSchema.nullable(), resolvedArea: ResolvedAreaV1Schema.nullable(),
  refreshAfterSeconds: z.union([z.literal(5), z.number().int().min(20).max(120)]).nullable(), stale: z.boolean(), partial: z.boolean(), warnings: z.array(NearbyWarningSchema).max(4),
  flights: z.array(InboundNearbyFlightSchema).max(5), areaChoices: z.array(AreaChoiceSchema).max(3), error: NearbyErrorSchema.nullable(),
}).superRefine((r, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (serializedBytes(r) > NEARBY_PAYLOAD_BYTES) fail("Nearby payload exceeds 32 KiB");
  if (new Set(r.flights.map(f => f.cardId)).size !== r.flights.length) fail("Duplicate card IDs");
  if (new Set(r.warnings).size !== r.warnings.length) fail("Duplicate warnings");
  if (r.status === "invalid_request") {
    if (r.flights.length || r.snapshotAt !== null || r.resolvedArea !== null || r.stale || r.partial || r.refreshAfterSeconds !== null || !r.error || !(nearbyInvalidCodes as readonly string[]).includes(r.error.code) || !r.areaChoices.length) fail("Invalid-request envelope invariant");
    return;
  }
  if (!r.resolvedArea || r.areaChoices.length || r.refreshAfterSeconds === null) fail("Area response metadata invariant");
  if (r.refreshAfterSeconds === 5 && (r.status !== "unavailable" || r.error?.code !== "warming")) fail("Five-second retry is only for a cold warming contender");
  if (r.status === "ok" && (!r.flights.length || r.error !== null || !r.snapshotAt)) fail("OK requires accepted cards and no error");
  if (r.status === "empty" && (r.flights.length || r.stale || r.partial || r.error !== null || !r.snapshotAt || r.warnings.length)) fail("Empty requires fresh complete success");
  if (r.status === "unavailable" && (r.flights.length || !r.error || !(nearbyUnavailableCodes as readonly string[]).includes(r.error.code))) fail("Unavailable requires a safe failure, never cards");
  const now = Date.parse(r.responseAt);
  const snapshotAge = r.snapshotAt ? (now - Date.parse(r.snapshotAt)) / 1000 : null;
  if (snapshotAge !== null && (snapshotAge < -1 || snapshotAge > 120)) fail("Snapshot outside safe window");
  const shouldBeStale = (snapshotAge !== null && snapshotAge > 45) || r.flights.some(f => f.freshness.ageSeconds > 45);
  if (r.stale !== shouldBeStale) fail("Board stale flag disagrees with preserved timestamps");
  if (r.stale && !r.warnings.includes("stale_data")) fail("Stale response needs stale_data warning");
  if (r.partial && !r.warnings.some(w => w === "partial_coverage" || w === "coverage_limited" || w === "refresh_delayed")) fail("Partial response needs a coverage/refresh warning");
  for (const f of r.flights) {
    if (f.motion.phase === "taxi" || f.motion.phase === "parked") fail("Nearby board excludes ground motion");
    const elapsed = (now - Date.parse(f.freshness.observedAt)) / 1000;
    if (elapsed < -1 || Math.abs(f.freshness.ageSeconds - Math.max(0, elapsed)) > 1) fail("Card age must advance from the original fix time");
    if (f.proximity.distanceNm > (r.resolvedArea?.radiusNm ?? 0)) fail("Card outside display radius");
    if (f.selection.expiresAt && Date.parse(f.selection.expiresAt) <= now) fail("Expired handle cannot be served as selectable");
  }
});

const detailedWarnings = ["position_stale", "position_unavailable", "time_provenance_unknown", "schedule_unavailable", "detail_refresh_delayed", "optional_data_unavailable"] as const;
const stringFact = factSchema(text(40)).nullable();
export const InboundFlightV1Schema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION), flightInstanceId: OpaqueIdSchema, snapshotAt: TimestampSchema,
  identity: z.strictObject({ displayIdent: DisplayIdentSchema, operatingIdent: DisplayIdentSchema, flightNumber: DisplayIdentSchema.nullable(), observedCallsign: DisplayIdentSchema.nullable(), airlineName: text(64).nullable(), serviceDate: ServiceDateSchema, serviceTimeZone: TimeZoneSchema }),
  route: z.strictObject({ origin: AirportV1Schema, destination: AirportV1Schema, divertedTo: AirportV1Schema.nullable() }),
  status: z.strictObject({ lifecycle: z.enum(["scheduled", "active", "completed", "cancelled", "unknown"]), text: text(160), basis: BasisSchema, cancelled: factSchema(z.boolean()).nullable(), diverted: factSchema(z.boolean()).nullable() }),
  phase: z.strictObject({ stage: z.enum(["inbound", "origin_gate", "push", "taxi", "ride", "arrival", "final_approach", "taxi_in", "gate", "Takeoff roll"]).nullable(), label: text(64), basis: z.enum(["inbound_inferred", "unknown"]), motion: MotionPhaseSchema.nullable(), arrivalState: factSchema(z.enum(["airborne", "landed", "taxi_in", "gate"])).nullable() }),
  aircraft: AircraftV1Schema.nullable(),
  position: z.strictObject({ latitude: LatitudeSchema, longitude: LongitudeSchema, altitudeFt: z.number().min(-2000).max(200000).nullable(), groundspeedKt: z.number().min(0).max(2000).nullable(), groundTrackDeg: z.number().min(0).lt(360).nullable(), verticalRateFpm: z.number().min(-20000).max(20000).nullable(), onGround: z.boolean().nullable(), kind: z.enum(["observed", "extrapolated"]), observedAt: TimestampSchema.nullable(), ageSeconds: age.nullable(), freshness: z.enum(["current", "stale", "unknown"]) }).nullable(),
  departure: z.strictObject({ terminal: stringFact, gate: stringFact, runway: RunwayV1Schema.nullable() }),
  arrival: z.strictObject({ terminal: stringFact, gate: stringFact, baggage: stringFact, baggageState: z.enum(["posted", "not_posted", "unavailable"]), runway: RunwayV1Schema.nullable() }),
  times: z.strictObject({ gateOut: EventTimeV1Schema, takeoff: EventTimeV1Schema, landing: EventTimeV1Schema, gateIn: EventTimeV1Schema }),
  delay: z.strictObject({ departure: DelayV1Schema.nullable(), landing: DelayV1Schema.nullable() }),
  freshness: z.strictObject({ storyAgeSeconds: age, positionAgeSeconds: age.nullable(), stale: z.boolean(), partial: z.boolean(), warnings: z.array(z.enum(detailedWarnings)).max(6) }),
  map: z.strictObject({ geometryKind: z.literal("mixed_display"), path: z.array(z.tuple([LongitudeSchema, LatitudeSchema])).min(2).max(128) }).nullable(),
}).superRefine((f, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (serializedBytes(f) > DETAIL_PAYLOAD_BYTES) fail("Detail payload exceeds 64 KiB");
  if (f.identity.serviceTimeZone !== f.route.origin.timeZone) fail("Service date uses origin time zone");
  if (f.arrival.baggageState === "posted" ? !f.arrival.baggage : f.arrival.baggage !== null) fail("Baggage state/value disagree");
  if (f.freshness.positionAgeSeconds !== (f.position?.ageSeconds ?? null)) fail("Position-age summaries disagree");
  if (f.position) {
    const p = f.position;
    if ((p.observedAt === null) !== (p.ageSeconds === null)) fail("Unknown fix time and age must remain null together");
    if (p.freshness !== (p.ageSeconds === null ? "unknown" : p.ageSeconds <= 45 ? "current" : "stale")) fail("Position freshness and age disagree");
  }
  if (f.freshness.stale !== (f.freshness.storyAgeSeconds > 45 || f.position?.freshness === "stale")) fail("Story stale flag disagrees");
  if (new Set(f.freshness.warnings).size !== f.freshness.warnings.length) fail("Duplicate detail warnings");
  if (f.status.lifecycle === "cancelled" && (f.phase.stage !== null || f.phase.motion !== null)) fail("Cancelled flights suppress active-phase presentation");
});

export const FlightCandidateV1Schema = z.strictObject({
  candidateToken: HandleSchema, expiresAt: TimestampSchema, displayIdent: DisplayIdentSchema,
  originIata: IataSchema, destinationIata: IataSchema, serviceDate: ServiceDateSchema,
  serviceTimeZone: TimeZoneSchema, scheduledDepartureAt: TimestampSchema.nullable(),
});
const flightErrorCodes = ["invalid_input", "invalid_token", "observation_expired", "choice_expired", "unsupported_aircraft", "unsupported_query", "route_unavailable", "identity_unconfirmed", "identity_changed", "flight_not_found", "date_unavailable", "flight_unavailable", "backend_unavailable", "too_many_candidates"] as const;
const resultErrorCodes = {
  not_found: ["flight_not_found"], unavailable: ["route_unavailable", "identity_unconfirmed", "identity_changed", "date_unavailable", "flight_unavailable", "backend_unavailable", "too_many_candidates"],
  expired: ["observation_expired", "choice_expired"], unsupported: ["unsupported_aircraft", "unsupported_query"], invalid_request: ["invalid_input", "invalid_token"],
} as const;
export const FlightResultV1Schema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION), status: z.enum(["resolved", "ambiguous", "not_found", "unavailable", "expired", "unsupported", "invalid_request"]),
  responseAt: TimestampSchema, refreshAfterSeconds: retry, flightInstanceId: OpaqueIdSchema.nullable(), flight: InboundFlightV1Schema.nullable(),
  candidates: z.array(FlightCandidateV1Schema).max(5), error: z.strictObject({ code: z.enum(flightErrorCodes), message: text(160) }).nullable(),
}).superRefine((r, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (serializedBytes(r) > DETAIL_PAYLOAD_BYTES) fail("Detail envelope exceeds 64 KiB");
  if (r.status === "resolved") {
    if (!r.flight || !r.flightInstanceId || r.flightInstanceId !== r.flight.flightInstanceId || r.candidates.length || r.error !== null || r.refreshAfterSeconds === null) fail("Resolved result invariant");
    if (r.flight) {
      const now = Date.parse(r.responseAt);
      if (Math.abs(r.flight.freshness.storyAgeSeconds - Math.max(0, (now - Date.parse(r.flight.snapshotAt)) / 1000)) > 1 || Date.parse(r.flight.snapshotAt) > now + 1000) fail("Detail snapshot age must be preserved");
      const p = r.flight.position;
      if (p?.observedAt && p.ageSeconds !== null && (Date.parse(p.observedAt) > now + 1000 || Math.abs(p.ageSeconds - Math.max(0, (now - Date.parse(p.observedAt)) / 1000)) > 1)) fail("Detail fix age must be preserved");
    }
  } else if (r.status === "ambiguous") {
    if (r.flight !== null || r.flightInstanceId !== null || r.candidates.length < 2 || r.error !== null || r.refreshAfterSeconds !== null) fail("Ambiguous result invariant");
    if (new Set(r.candidates.map(c => c.candidateToken)).size !== r.candidates.length) fail("Ambiguity tokens must be distinct");
    for (const c of r.candidates) if (Date.parse(c.expiresAt) <= Date.parse(r.responseAt) || Date.parse(c.expiresAt) > Date.parse(r.responseAt) + 120000) fail("Candidate expiry outside safe window");
  } else {
    if (r.flight !== null || r.flightInstanceId !== null || r.candidates.length || !r.error || !(resultErrorCodes[r.status] as readonly string[]).includes(r.error.code)) fail("Failure result invariant");
    if ((r.status === "unavailable") !== (r.refreshAfterSeconds !== null)) fail("Only retryable unavailable failures may poll");
  }
});
export const GetFlightRequestV1Schema = z.strictObject({ target: z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("lookup"), query: text(16), date: z.union([z.enum(["today", "tomorrow", "yesterday"]), ServiceDateSchema]).optional(), originIata: IataSchema.optional(), destinationIata: IataSchema.optional() }),
  z.strictObject({ kind: z.literal("instance"), flightInstanceId: OpaqueIdSchema }),
  z.strictObject({ kind: z.literal("choice"), candidateToken: HandleSchema }),
]) });
export const ResolveNearbyRequestV1Schema = z.strictObject({ selectionToken: HandleSchema });

export type NearbyRequestV1 = z.infer<typeof NearbyRequestV1Schema>;
export type ResolvedAreaV1 = z.infer<typeof ResolvedAreaV1Schema>;
export type InboundNearbyFlight = z.infer<typeof InboundNearbyFlightSchema>;
export type NearbyFlightsResponseV1 = z.infer<typeof NearbyFlightsResponseV1Schema>;
export type InboundFlightV1 = z.infer<typeof InboundFlightV1Schema>;
export type FlightCandidateV1 = z.infer<typeof FlightCandidateV1Schema>;
export type FlightResultV1 = z.infer<typeof FlightResultV1Schema>;
export type EventTimeV1 = z.infer<typeof EventTimeV1Schema>;
export type AirportV1 = z.infer<typeof AirportV1Schema>;
export type RunwayV1 = z.infer<typeof RunwayV1Schema>;
export type DelayV1 = z.infer<typeof DelayV1Schema>;
export type GetFlightRequestV1 = z.infer<typeof GetFlightRequestV1Schema>;
export type ResolveNearbyRequestV1 = z.infer<typeof ResolveNearbyRequestV1Schema>;

/** Structural JSON Schema plus runtime cross-field checks above. No API is wired. */
export function publicJsonSchemas() {
  const schemas = { NearbyRequestV1: NearbyRequestV1Schema, InboundNearbyFlight: InboundNearbyFlightSchema, NearbyFlightsResponseV1: NearbyFlightsResponseV1Schema, FlightCandidateV1: FlightCandidateV1Schema, FlightResultV1: FlightResultV1Schema, InboundFlightV1: InboundFlightV1Schema, EventTimeV1: EventTimeV1Schema, AirportV1: AirportV1Schema, RunwayV1: RunwayV1Schema, DelayV1: DelayV1Schema, GetFlightRequestV1: GetFlightRequestV1Schema, ResolveNearbyRequestV1: ResolveNearbyRequestV1Schema };
  return Object.fromEntries(Object.entries(schemas).map(([name, schema]) => [name, z.toJSONSchema(schema)]));
}

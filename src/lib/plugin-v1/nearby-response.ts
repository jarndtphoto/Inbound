import { z } from "zod";
import type { CollectionHealth } from "../nearby-v1/model";
import { NEARBY_POLICY, observationFreshness } from "../nearby-v1/model";
import type { NearbyView } from "../nearby-v1/views";
import type { AcceptedNearbyObservation } from "../nearby-v1/model";
import { AREA_IDS, areaDefinition, rankingViewKey } from "./areas";
import { DisplayIdentSchema, IataSchema, LatitudeSchema, LongitudeSchema, MOTION_LABELS, MotionPhaseSchema,
  OpaqueIdSchema, RadiusSchema, ResolvedAreaV1Schema, TimestampSchema, serializedBytes, type ResolvedAreaV1 } from "./contracts";
import { currentRoute, type RankedCandidate } from "./ranking";
import { viewProximity } from "./geography";

/** Full public JSON response, including both independent arrays and metadata. */
export const PUBLIC_NEARBY_PAYLOAD_BYTES = 64 * 1024;
export const PUBLIC_RADAR_TARGET_MAX = NEARBY_POLICY.maxRadar;
export const PUBLIC_FEATURED_MAX = 5;
const displayText = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim()
  && !/[\p{Cc}<>]|https?:|www\./iu.test(value), "Expected sanitized display text");

export const NearbyTransportRequestSchema = z.strictObject({
  area: z.enum(AREA_IDS), radiusNm: RadiusSchema.optional(), limit: z.number().int().min(1).max(PUBLIC_FEATURED_MAX).optional(),
});
export type NearbyTransportRequest = z.infer<typeof NearbyTransportRequestSchema>;

/** References are Inbound-owned presets; arbitrary/user coordinates are not a V1 input. */
export const PublicNearbyAreaSchema = ResolvedAreaV1Schema.refine(area => {
  const expected = areaDefinition(area.id);
  return area.kind === expected.kind && area.label === expected.label
    && area.reference.latitude === expected.reference.latitude && area.reference.longitude === expected.reference.longitude
    && area.reference.label === expected.reference.label
    && JSON.stringify(area.associatedAirports) === JSON.stringify(expected.associatedAirports);
}, "Nearby area must use its approved preset reference");

export const PublicNearbyMotionSchema = z.strictObject({
  phase: MotionPhaseSchema, label: displayText(32), verticalTrend: z.enum(["rising", "falling", "level", "unknown"]),
}).refine(motion => motion.label === MOTION_LABELS[motion.phase] && motion.phase !== "taxi" && motion.phase !== "parked",
  "Motion must preserve the private engine's airborne display phase");
export const PublicNearbyFreshnessSchema = z.strictObject({
  ageSeconds: z.number().min(0).max(NEARBY_POLICY.hardStaleMs / 1000), state: z.enum(["fresh", "stale"]),
}).refine(freshness => freshness.state === (freshness.ageSeconds <= NEARBY_POLICY.freshMs / 1000 ? "fresh" : "stale"),
  "Freshness must preserve the observation age");
export const PublicNearbyRouteSchema = z.strictObject({
  originIata: IataSchema.nullable(), destinationIata: IataSchema.nullable(),
  verification: z.enum(["unknown", "hint", "confirmed"]), checkedAt: TimestampSchema.nullable(),
}).refine(route => route.verification === "unknown"
  ? route.originIata === null && route.destinationIata === null && route.checkedAt === null
  : route.checkedAt !== null && (route.verification === "confirmed"
    ? route.originIata !== null && route.destinationIata !== null : route.originIata !== null || route.destinationIata !== null),
"Route evidence and verification must agree");

export const PublicRadarTargetSchema = z.strictObject({
  radarId: OpaqueIdSchema, displayIdent: DisplayIdentSchema,
  latitude: LatitudeSchema, longitude: LongitudeSchema, observedAt: TimestampSchema,
  altitudeFt: z.number().min(500).max(200000).nullable(), groundspeedKt: z.number().min(0).max(2000).nullable(),
  groundTrackDeg: z.number().min(0).lt(360).nullable(), verticalRateFpm: z.number().min(-20000).max(20000).nullable(),
  // Essential public motion guard: an accepted projected fix must not be projected a second time.
  positionKind: z.enum(["observed", "extrapolated"]), motion: PublicNearbyMotionSchema,
  freshness: PublicNearbyFreshnessSchema, featured: z.boolean(), typeCode: z.string().regex(/^[A-Z0-9]{1,8}$/).optional(),
});
export type PublicRadarTarget = z.infer<typeof PublicRadarTargetSchema>;

export const PublicFeaturedFlightSchema = z.strictObject({
  cardId: OpaqueIdSchema, radarId: OpaqueIdSchema, displayIdent: DisplayIdentSchema, route: PublicNearbyRouteSchema,
  distanceNm: z.number().min(0).max(38), bearingDeg: z.number().min(0).lt(360), altitudeFt: z.number().min(500).max(200000),
  motion: PublicNearbyMotionSchema, freshness: PublicNearbyFreshnessSchema, airlineName: displayText(64).optional(),
});
export type PublicFeaturedFlight = z.infer<typeof PublicFeaturedFlightSchema>;

/** Strict public allowlist. No fields are spread from private candidates or engine state. */
export const InboundNearbyResponseSchema = z.strictObject({
  area: PublicNearbyAreaSchema, collectionVersion: z.number().int().min(1).nullable(),
  health: z.enum(["ok", "partial", "stale", "unavailable"]), generatedAt: TimestampSchema,
  radarTargets: z.array(PublicRadarTargetSchema).max(PUBLIC_RADAR_TARGET_MAX),
  featuredFlights: z.array(PublicFeaturedFlightSchema).max(PUBLIC_FEATURED_MAX),
  status: displayText(160).optional(), warning: displayText(160).optional(),
}).superRefine((response, context) => {
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  if (serializedBytes(response) > PUBLIC_NEARBY_PAYLOAD_BYTES) fail("Public Nearby response exceeds 64 KiB UTF-8");
  if (serializedBytes(response.radarTargets) > NEARBY_POLICY.maxRadarBytes) fail("Radar array exceeds its certified 49,152-byte envelope");
  if (new Set(response.radarTargets.map(target => target.radarId)).size !== response.radarTargets.length) fail("Duplicate Radar ID");
  if (new Set(response.featuredFlights.map(flight => flight.cardId)).size !== response.featuredFlights.length
    || new Set(response.featuredFlights.map(flight => flight.radarId)).size !== response.featuredFlights.length) fail("Duplicate Featured ID");
  if (response.health === "unavailable") {
    if (response.radarTargets.length || response.featuredFlights.length || response.collectionVersion !== null || !response.status) fail("Unavailable must explain the absence of current data");
  } else if (response.collectionVersion === null) fail("Available response needs an accepted collection version");
  if (response.health !== "ok" && !response.warning) fail("Degraded response needs a safe coverage warning");
  const nowMs = Date.parse(response.generatedAt);
  for (const target of response.radarTargets) {
    const age = (nowMs - Date.parse(target.observedAt)) / 1000;
    if (age < -1 || Math.abs(target.freshness.ageSeconds - Math.max(0, age)) > .001) fail("Radar age disagrees with the authoritative fix");
    if (viewProximity(response.area, target).distanceNm >= response.area.radiusNm) fail("Radar target outside requested display radius");
  }
  for (const flight of response.featuredFlights) {
    if (flight.distanceNm >= response.area.radiusNm) fail("Featured flight outside requested display radius");
    if (flight.route.checkedAt && Date.parse(flight.route.checkedAt) > nowMs + 1000) fail("Route evidence is in the future");
  }
});
export type InboundNearbyResponse = z.infer<typeof InboundNearbyResponseSchema>;

export const publicNearbyResponseBytes = serializedBytes;
export type PrivateNearbyResponse = { health: CollectionHealth; view: NearbyView | null };

function displayIdent(row: RankedCandidate): string {
  // Registration is private even when the original board uses it as a fallback identifier.
  const callsign = row.candidate.observedCallsign;
  return DisplayIdentSchema.safeParse(callsign).success ? callsign! : "AIRCRAFT";
}
function motionProjection(motion: RankedCandidate["motion"]) {
  return { phase: motion.phase, label: motion.label, verticalTrend: motion.verticalTrend };
}

/** Thin engine-result adapter: no acquisition, lookup, ranking, phase or motion inference. */
export function serializeNearbyResponse(result: PrivateNearbyResponse, area: ResolvedAreaV1, nowMs: number): InboundNearbyResponse {
  if (!Number.isFinite(nowMs)) throw new RangeError("Invalid public Nearby clock");
  PublicNearbyAreaSchema.parse(area);
  const generatedAt = new Date(nowMs).toISOString();
  const health = result.view === null ? "unavailable" : result.health;
  if (health === "unavailable") return InboundNearbyResponseSchema.parse({
    area, collectionVersion: null, health, generatedAt, radarTargets: [], featuredFlights: [],
    status: "Nearby aircraft data is temporarily unavailable.", warning: "No current aircraft snapshot is available. Try again shortly.",
  });
  const view = result.view!;
  if (view.viewKey !== rankingViewKey(area)) throw new RangeError("Nearby view does not match requested area");
  const rankedByRadarId = new Map(view.ranked.map(row => [(row.candidate as AcceptedNearbyObservation).radarId, row]));
  const radarTargets = view.radar.map(target => {
    const row = rankedByRadarId.get(target.radarId);
    return {
      radarId: target.radarId, displayIdent: row ? displayIdent(row) : "AIRCRAFT",
      latitude: target.latitude, longitude: target.longitude, observedAt: target.observedAt,
      altitudeFt: target.altitudeFt, groundspeedKt: target.groundspeedKt, groundTrackDeg: target.groundTrackDeg,
      verticalRateFpm: target.verticalRateFpm, positionKind: target.positionKind,
      motion: motionProjection(target.motion), freshness: observationFreshness(target.observedAt, nowMs),
      featured: target.featured, ...(target.typeCode ? { typeCode: target.typeCode } : {}),
    };
  });
  const featuredFlights = view.featured.map(row => ({
    cardId: row.candidate.cardId, radarId: (row.candidate as AcceptedNearbyObservation).radarId, displayIdent: displayIdent(row),
    // Reuse the existing dated-evidence guard, including its safe confirmed→hint downgrade.
    route: currentRoute(row.candidate, nowMs), distanceNm: row.distanceNm, bearingDeg: row.bearingDeg, altitudeFt: row.candidate.altitudeFt,
    motion: motionProjection(row.motion), freshness: observationFreshness(row.candidate.observedAt!, nowMs),
  }));
  return InboundNearbyResponseSchema.parse({ area, collectionVersion: view.collectionVersion, health, generatedAt, radarTargets, featuredFlights,
    ...(health === "partial" ? { warning: "Coverage is partial. Available aircraft remain visible." } : {}),
    ...(health === "stale" ? { warning: "Aircraft observations are delayed. Display motion is paused." } : {}),
  });
}

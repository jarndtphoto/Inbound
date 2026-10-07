import { AIRPORT_BY_ICAO } from "../airports";
import { NearbyFlightsResponseV1Schema, NearbyRequestV1Schema, TimestampSchema, type NearbyFlightsResponseV1, type ResolvedAreaV1 } from "./contracts";

export const AREA_IDS = ["preset:chicago", "airport:KORD", "airport:KMDW"] as const;
export const DISPLAY_RADII_NM = [12, 25, 38] as const;
export const DEFAULT_LIMIT = 4;
export const MAX_LIMIT = 5;
/** Proposed covering geometry only. This module performs no acquisition. */
export const CHICAGO_COLLECTION = Object.freeze({ id: "nearby:telemetry:v1:chicago:50", latitude: 41.90, longitude: -87.80, radiusNm: 50 });

const ord = AIRPORT_BY_ICAO.KORD!;
const mdw = AIRPORT_BY_ICAO.KMDW!;
const definitions: Readonly<Record<(typeof AREA_IDS)[number], ResolvedAreaV1>> = {
  "preset:chicago": { id: "preset:chicago", kind: "preset", label: "Chicago area", reference: { latitude: 41.90, longitude: -87.80, label: "Chicago area center" }, radiusNm: 38, associatedAirports: ["KORD", "KMDW"] },
  "airport:KORD": { id: "airport:KORD", kind: "airport", label: "ORD — Chicago O'Hare", reference: { latitude: ord.lat, longitude: ord.lon, label: "ORD reference" }, radiusNm: 25, associatedAirports: ["KORD"] },
  "airport:KMDW": { id: "airport:KMDW", kind: "airport", label: "MDW — Chicago Midway", reference: { latitude: mdw.lat, longitude: mdw.lon, label: "MDW reference" }, radiusNm: 25, associatedAirports: ["KMDW"] },
};
const aliases: Readonly<Record<string, (typeof AREA_IDS)[number]>> = {
  chicago: "preset:chicago", "chicago area": "preset:chicago", "preset:chicago": "preset:chicago",
  ord: "airport:KORD", kord: "airport:KORD", "o'hare": "airport:KORD", ohare: "airport:KORD", "chicago o'hare": "airport:KORD",
  mdw: "airport:KMDW", kmdw: "airport:KMDW", midway: "airport:KMDW", "chicago midway": "airport:KMDW",
};
export const AREA_CHOICES: NearbyFlightsResponseV1["areaChoices"] = [
  { area: { kind: "preset", nameOrId: "chicago" }, label: "Chicago area" },
  { area: { kind: "airport", code: "ORD" }, label: "ORD — Chicago O'Hare" },
  { area: { kind: "airport", code: "MDW" }, label: "MDW — Chicago Midway" },
];
const errorMessages = {
  area_required: "Choose Chicago, ORD, or MDW to open Inbound Live.",
  unsupported_area: "Nearby V1 supports Chicago, ORD, and MDW.",
  invalid_radius: "Choose a radius of 12, 25, or 38 nautical miles.",
  invalid_limit: "Choose between one and five cards.",
  invalid_input: "Check the Nearby request and try again.",
} as const;
export function invalidNearbyRequest(code: keyof typeof errorMessages, responseAt: string): NearbyFlightsResponseV1 {
  return NearbyFlightsResponseV1Schema.parse({
    schemaVersion: "1.0", status: "invalid_request", responseAt: TimestampSchema.parse(responseAt), snapshotAt: null,
    resolvedArea: null, refreshAfterSeconds: null, stale: false, partial: false, warnings: [], flights: [],
    areaChoices: structuredClone(AREA_CHOICES), error: { code, message: errorMessages[code] },
  });
}
export type ResolvedNearbyRequest = { ok: true; area: ResolvedAreaV1; limit: number; includePosition: boolean } | { ok: false; response: NearbyFlightsResponseV1 };

/** Pure validation/resolution. Unsupported input never reaches an acquisition API. */
export function resolveNearbyRequest(input: unknown, responseAt: string): ResolvedNearbyRequest {
  TimestampSchema.parse(responseAt);
  const parsed = NearbyRequestV1Schema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    const missingArea = typeof input === "object" && input !== null && !Object.hasOwn(input, "area") && issues.every(i => i.path[0] === "area");
    const code = missingArea ? "area_required" : issues.every(i => i.path[0] === "radiusNm") ? "invalid_radius" : issues.every(i => i.path[0] === "limit") ? "invalid_limit" : "invalid_input";
    return { ok: false, response: invalidNearbyRequest(code, responseAt) };
  }
  if (!parsed.data.area) return { ok: false, response: invalidNearbyRequest("area_required", responseAt) };
  const a = parsed.data.area;
  const name = (a.kind === "preset" ? a.nameOrId : a.code).trim().toLowerCase().replace(/’/g, "'").replace(/\s+/g, " ");
  const id = aliases[name];
  if (!id || definitions[id].kind !== a.kind) return { ok: false, response: invalidNearbyRequest("unsupported_area", responseAt) };
  return { ok: true, area: { ...structuredClone(definitions[id]), radiusNm: parsed.data.radiusNm ?? definitions[id].radiusNm }, limit: parsed.data.limit ?? DEFAULT_LIMIT, includePosition: parsed.data.includePosition ?? false };
}
export function areaDefinition(id: (typeof AREA_IDS)[number]): ResolvedAreaV1 { return structuredClone(definitions[id]); }

/** Future private view key: deliberately excludes user, limit, and position flag. */
export function rankingViewKey(area: ResolvedAreaV1): string { return `${area.id}:${area.radiusNm}:ranking-v1`; }

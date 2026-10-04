import { DisplayIdentSchema, IataSchema, TimestampSchema } from "../plugin-v1/contracts";

/** Private route construction policy; no provider is configured by this module. */
export const ROUTE_HINT_POLICY = Object.freeze({
  enrichmentPool: 12,
  newLookupsPerCollection: 2,
  newLookupsPerMinute: 6,
  minuteWindowMs: 60_000,
  positiveTtlMs: 1_800_000,
  negativeTtlMs: 60_000,
  leaseMs: 10_000,
  lookupTimeoutMs: 2_000,
  maxCacheRows: 192,
});

export type NearbyRouteHint = {
  observedCallsign: string;
  originIata: string | null;
  destinationIata: string | null;
  airlineLabel: string | null;
  outcome: "positive" | "negative";
  checkedAt: string;
  expiresAt: string;
  sourceClass: string;
  /** A generic lookup can never establish a dated flight occurrence. */
  verification: "hint" | "unknown";
};
export type NearbyRouteLookupResult = Omit<NearbyRouteHint, "checkedAt" | "expiresAt">;
export type NearbyRouteLookup = (observedCallsign: string, context: { signal: AbortSignal }) => Promise<NearbyRouteLookupResult>;
export type NearbyRouteHintLease = {
  observedCallsign: string; owner: string; generation: number; claimedAtMs: number; leaseUntilMs: number;
};
export interface NearbyRouteHintStore {
  read(observedCallsigns: readonly string[], nowMs: number): Promise<NearbyRouteHint[]>;
  claim(input: { observedCallsign: string; collectionVersion: number; owner: string; nowMs: number }): Promise<NearbyRouteHintLease | null>;
  publish(lease: NearbyRouteHintLease, hint: NearbyRouteHint, nowMs: number): Promise<boolean>;
  fail(lease: NearbyRouteHintLease, nowMs: number): Promise<boolean>;
  cleanup(nowMs: number): Promise<{ hints: number; budgets: number }>;
}

/** Match accepted identity formatting without guessing marketing/operating aliases. */
export function normalizeObservedCallsign(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const accepted = value.trim().toUpperCase();
  if (!DisplayIdentSchema.safeParse(accepted).success) return null;
  const key = accepted.replace(/ /g, "");
  return /^[A-Z0-9][A-Z0-9-]{0,15}$/.test(key) ? key : null;
}
const lookupFields = ["observedCallsign", "originIata", "destinationIata", "airlineLabel", "outcome", "sourceClass", "verification"];
function validateFields(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== fields.length || Object.keys(value).some(key => !fields.includes(key))) throw new RangeError("Invalid private route hint shape");
}
function validateLookup(value: unknown): asserts value is NearbyRouteLookupResult {
  validateFields(value, lookupFields);
  const key = normalizeObservedCallsign(value.observedCallsign);
  if (!key || key !== value.observedCallsign
    || value.originIata !== null && !IataSchema.safeParse(value.originIata).success
    || value.destinationIata !== null && !IataSchema.safeParse(value.destinationIata).success
    || value.airlineLabel !== null && (typeof value.airlineLabel !== "string" || !value.airlineLabel.trim() || value.airlineLabel.trim() !== value.airlineLabel
      || value.airlineLabel.length > 64 || /[\p{Cc}<>]|https?:|www\./iu.test(value.airlineLabel))
    || typeof value.sourceClass !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(value.sourceClass)
    || value.outcome !== "positive" && value.outcome !== "negative"
    || value.outcome === "positive" && (value.verification !== "hint" || !value.originIata && !value.destinationIata)
    || value.outcome === "negative" && (value.verification !== "unknown" || value.originIata !== null
      || value.destinationIata !== null || value.airlineLabel !== null)) throw new RangeError("Invalid private route hint");
}
export function routeHintFromLookup(result: NearbyRouteLookupResult, nowMs: number): NearbyRouteHint {
  validateLookup(result);
  if (!Number.isFinite(nowMs)) throw new RangeError("Invalid route hint clock");
  return { ...result, checkedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + (result.outcome === "positive" ? ROUTE_HINT_POLICY.positiveTtlMs : ROUTE_HINT_POLICY.negativeTtlMs)).toISOString() };
}
export function validateRouteHint(value: unknown): asserts value is NearbyRouteHint {
  validateFields(value, [...lookupFields, "checkedAt", "expiresAt"]);
  const { checkedAt, expiresAt, ...lookup } = value;
  validateLookup(lookup);
  if (!TimestampSchema.safeParse(checkedAt).success || !TimestampSchema.safeParse(expiresAt).success) throw new RangeError("Invalid route hint timestamp");
  const ttl = Date.parse(expiresAt as string) - Date.parse(checkedAt as string);
  if (ttl <= 0 || ttl > (lookup.outcome === "positive" ? ROUTE_HINT_POLICY.positiveTtlMs : ROUTE_HINT_POLICY.negativeTtlMs)) throw new RangeError("Invalid route hint TTL");
}
export function routeHintUsable(hint: NearbyRouteHint, nowMs: number): boolean {
  try { validateRouteHint(hint); } catch { return false; }
  return Number.isFinite(nowMs) && Date.parse(hint.checkedAt) <= nowMs + 1000 && Date.parse(hint.expiresAt) > nowMs;
}

import { randomUUID } from "node:crypto";
import type { ResolvedAreaV1 } from "../plugin-v1/contracts";
import { rankingViewKey } from "../plugin-v1/areas";
import { currentRoute, rankNearbyCandidates, type RankedCandidate } from "../plugin-v1/ranking";
import type { NearbyStabilityState } from "../plugin-v1/stability";
import { NEARBY_POLICY, observationFreshness, type AcceptedNearbyObservation, type SharedCollection } from "./model";
import { normalizeObservedCallsign, routeHintFromLookup, routeHintUsable, ROUTE_HINT_POLICY,
  type NearbyRouteHint, type NearbyRouteHintStore, type NearbyRouteLookup } from "./route-hints";

const unknownRoute = () => ({ originIata: null, destinationIata: null, verification: "unknown" as const, checkedAt: null });
export type RouteConstructionInput = {
  collection: SharedCollection; area: ResolvedAreaV1; previousStability?: NearbyStabilityState | null; nowMs: number;
};
export type RouteConstructionResult = { poolSize: number; cacheHits: number; lookupsStarted: number; published: number; failed: number };
export type NearbyFeaturedRouteDisplay = RankedCandidate["route"] & { airlineLabel?: string };
export interface NearbyRouteEnrichmentService {
  read(input: RouteConstructionInput): Promise<SharedCollection>;
  construct(input: RouteConstructionInput): Promise<RouteConstructionResult>;
  cleanup(nowMs: number): Promise<{ hints: number; budgets: number }>;
}

/** Five incumbents plus route-neutral challengers, never N lookups for N Radar rows. */
export function routeEnrichmentPool(input: RouteConstructionInput): AcceptedNearbyObservation[] {
  const { collection, area, nowMs, previousStability } = input;
  const snapshotAt = collection.acceptedSnapshotAtMs;
  if (!Number.isFinite(nowMs) || snapshotAt === null || snapshotAt > nowMs + 1000
    || nowMs - snapshotAt > NEARBY_POLICY.hardStaleMs || collection.collectionVersion < 1) return [];
  const originals = new Map<object, AcceptedNearbyObservation>();
  const neutral = collection.observations.filter(o => observationFreshness(o.observedAt, nowMs).state !== "expired")
    .map(o => { const copy = { ...o, route: unknownRoute(), datedBinding: null }; originals.set(copy, o); return copy; });
  const ranked = rankNearbyCandidates(neutral, area, snapshotAt);
  const eligibleById = new Map(ranked.map(row => [row.candidate.cardId, originals.get(row.candidate)!]));
  const pool = new Map<string, AcceptedNearbyObservation>();
  if (previousStability?.viewKey === rankingViewKey(area) && previousStability.inactiveExpiresAtMs > nowMs) {
    for (const slot of previousStability.slots.slice(0, 5)) {
      const candidate = eligibleById.get(slot.cardId);
      if (candidate) pool.set(candidate.cardId, candidate);
    }
  }
  for (const row of ranked) {
    if (pool.size >= ROUTE_HINT_POLICY.enrichmentPool) break;
    pool.set(row.candidate.cardId, eligibleById.get(row.candidate.cardId)!);
  }
  return [...pool.values()];
}

/** Overlay private copies only. Existing Inbound route evidence takes precedence. */
export function applyRouteHints(input: RouteConstructionInput, hints: readonly NearbyRouteHint[]): SharedCollection {
  const pool = new Set(routeEnrichmentPool(input).map(o => o.cardId));
  const usable = new Map(hints.filter(hint => routeHintUsable(hint, input.nowMs)).map(hint => [hint.observedCallsign, hint]));
  return { ...input.collection, observations: input.collection.observations.map(observation => {
    if (!pool.has(observation.cardId) || currentRoute(observation, input.nowMs).verification !== "unknown") return observation;
    const key = normalizeObservedCallsign(observation.observedCallsign);
    const hint = key ? usable.get(key) : null;
    if (!hint || hint.outcome !== "positive") return observation;
    return { ...observation, route: { originIata: hint.originIata, destinationIata: hint.destinationIata,
      verification: "hint", checkedAt: hint.checkedAt }, datedBinding: null };
  }) };
}

/** Explicit allowlist for the eventual renderer; no cache/provider/occurrence identifiers. */
export function featuredRouteDisplay(row: RankedCandidate, hint?: NearbyRouteHint, nowMs = Date.now()): NearbyFeaturedRouteDisplay {
  const route = currentRoute(row.candidate, nowMs);
  const key = normalizeObservedCallsign(row.candidate.observedCallsign);
  return { originIata: route.originIata, destinationIata: route.destinationIata,
    verification: route.verification, checkedAt: route.checkedAt,
    ...(hint && hint.outcome === "positive" && routeHintUsable(hint, nowMs) && key === hint.observedCallsign
      && route.verification === "hint" && route.originIata === hint.originIata && route.destinationIata === hint.destinationIata
      && hint.airlineLabel ? { airlineLabel: hint.airlineLabel } : {}) };
}

/**
 * Provider-neutral private worker. Call construct explicitly in a bounded task;
 * viewer/Radar reads never await a provider or spawn fire-and-forget lookups.
 * There is deliberately no default provider or live external route adapter.
 */
export function createRouteEnrichmentService(options: {
  store: NearbyRouteHintStore; lookup: NearbyRouteLookup; clock?: () => number; leaseOwner?: () => string;
}): NearbyRouteEnrichmentService {
  const clock = options.clock ?? Date.now;
  const owner = options.leaseOwner ?? randomUUID;
  const keysFor = (pool: readonly AcceptedNearbyObservation[]) => [...new Set(pool.flatMap(o => {
    const key = normalizeObservedCallsign(o.observedCallsign); return key ? [key] : [];
  }))];
  return {
    async read(input) {
      const keys = keysFor(routeEnrichmentPool(input));
      if (!keys.length) return input.collection;
      try { return applyRouteHints(input, await options.store.read(keys, input.nowMs)); }
      catch { return input.collection; } // Cache outage never removes accepted aircraft.
    },
    async construct(input) {
      const pool = routeEnrichmentPool(input);
      const result: RouteConstructionResult = { poolSize: pool.length, cacheHits: 0, lookupsStarted: 0, published: 0, failed: 0 };
      if (input.collection.lastAttemptFailed || input.collection.acceptedSnapshotAtMs === null
        || input.nowMs - input.collection.acceptedSnapshotAtMs > NEARBY_POLICY.freshMs) return result;
      const keys = keysFor(pool.filter(o => currentRoute(o, input.nowMs).verification === "unknown"));
      let cached: NearbyRouteHint[];
      try { cached = await options.store.read(keys, input.nowMs); } catch { return result; }
      const hits = new Set(cached.filter(hint => routeHintUsable(hint, input.nowMs)).map(hint => hint.observedCallsign));
      result.cacheHits = hits.size;
      for (const key of keys) {
        if (hits.has(key)) continue;
        // A bounded local loop is only an optimization; the SQL claim provides
        // both global quota and callsign collapse across every worker/viewer.
        if (result.lookupsStarted >= ROUTE_HINT_POLICY.newLookupsPerCollection) break;
        let lease;
        try { lease = await options.store.claim({ observedCallsign: key, collectionVersion: input.collection.collectionVersion, owner: owner(), nowMs: clock() }); }
        catch { break; }
        if (!lease) continue;
        result.lookupsStarted++;
        const abort = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const response = await Promise.race([options.lookup(key, { signal: abort.signal }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => { abort.abort(); reject(new Error("Private route lookup timed out")); }, ROUTE_HINT_POLICY.lookupTimeoutMs); })]);
          const hint = routeHintFromLookup(response, clock());
          if (hint.observedCallsign !== key) throw new RangeError("Route lookup callsign mismatch");
          if (await options.store.publish(lease, hint, clock())) result.published++;
        } catch {
          result.failed++;
          try { await options.store.fail(lease, clock()); } catch { /* Shared lease/retry still fences another worker. */ }
        } finally { if (timer) clearTimeout(timer); abort.abort(); }
      }
      return result;
    },
    cleanup: nowMs => options.store.cleanup(nowMs),
  };
}

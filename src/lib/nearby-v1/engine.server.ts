import { randomUUID } from "node:crypto";
import { areaDefinition, DISPLAY_RADII_NM, type AREA_IDS } from "../plugin-v1/areas";
import { acquireNearbyChicago } from "./acquisition.server";
import { createNearbyCollectionService } from "./collection";
import type { NearbyAcquire } from "./model";
import { createNearbyCollectionStore, type NearbyStableCollectionStore } from "./store.server";
import { buildNearbyView, type NearbyViewOptions } from "./views";
import type { NearbyRouteEnrichmentService } from "./route-enrichment";

/**
 * Private Inbound entry point. Intentionally unmounted: no public endpoint,
 * createServerFn, fixture tool, or ChatGPT resource calls this in Part 3B.2.
 * A real shared database with the explicit minimal migration is required.
 */
export function createPrivateNearbyEngine(options: {
  environment: string;
  store?: NearbyStableCollectionStore;
  acquire?: NearbyAcquire;
  clock?: () => number;
  /** Explicit private worker with an injected lookup; no live route provider default. */
  routeEnrichment?: NearbyRouteEnrichmentService;
}) {
  const clock = options.clock ?? Date.now;
  const store = options.store ?? createNearbyCollectionStore({ environment: options.environment });
  const collection = createNearbyCollectionService({ store, acquire: options.acquire ?? acquireNearbyChicago, clock, leaseOwner: randomUUID });
  function resolvedArea(areaId: (typeof AREA_IDS)[number], radiusNm?: 12 | 25 | 38) {
    const area = areaDefinition(areaId);
    if (!area) throw new RangeError("Unsupported Nearby area");
    if (radiusNm !== undefined) {
      if (!(DISPLAY_RADII_NM as readonly number[]).includes(radiusNm)) throw new RangeError("Unsupported Nearby radius");
      area.radiusNm = radiusNm;
    }
    return area;
  }
  async function overlay(current: NonNullable<Awaited<ReturnType<typeof collection.read>>["collection"]>,
    area: ReturnType<typeof resolvedArea>, previousStability: Awaited<ReturnType<typeof store.readStableView>>) {
    if (!options.routeEnrichment) return current;
    try { return await options.routeEnrichment.read({ collection: current, area, previousStability, nowMs: clock() }); }
    catch { return current; }
  }
  function viewWithRoutes(current: Parameters<typeof buildNearbyView>[0], enriched: Parameters<typeof buildNearbyView>[0],
    area: ReturnType<typeof resolvedArea>, nowMs: number, input: NearbyViewOptions) {
    const view = buildNearbyView(enriched, area, nowMs, input);
    // Cached route scores construct Featured only. Radar telemetry selection,
    // motion and byte accounting continue to use the accepted snapshot.
    return enriched === current ? view : { ...view, radar: buildNearbyView(current, area, nowMs, { ...input, previousStability: view.stability }).radar };
  }
  return {
    /** Telemetry-only fast path: no route cache, worker, or lookup is awaited. */
    async requestRadar(areaId: (typeof AREA_IDS)[number], input: { radiusNm?: 12 | 25 | 38 } = {}) {
      const area = resolvedArea(areaId, input.radiusNm);
      const current = await collection.request();
      if (!current.collection || current.health === "unavailable") return { health: current.health, radar: [] };
      return { health: current.health, radar: buildNearbyView(current.collection, area, clock()).radar };
    },
    /** Explicit task entry point. It is never started by a viewer/Radar request. */
    async constructRouteHints(areaId: (typeof AREA_IDS)[number], input: { radiusNm?: 12 | 25 | 38 } = {}) {
      const area = resolvedArea(areaId, input.radiusNm);
      if (!options.routeEnrichment) return { poolSize: 0, cacheHits: 0, lookupsStarted: 0, published: 0, failed: 0 };
      const current = await collection.read();
      if (!current.collection || current.health === "unavailable") return { poolSize: 0, cacheHits: 0, lookupsStarted: 0, published: 0, failed: 0 };
      const prior = await store.readStableView(areaId, area.radiusNm as 12 | 25 | 38, clock());
      return options.routeEnrichment.construct({ collection: current.collection, area, previousStability: prior, nowMs: clock() });
    },
    async request(areaId: (typeof AREA_IDS)[number], input: { radiusNm?: 12 | 25 | 38; limit?: number } = {}) {
      const area = resolvedArea(areaId, input.radiusNm);
      const limit = input.limit ?? 4;
      if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new RangeError("Featured limit must be 1–5");
      let current = await collection.request();
      const radiusNm = area.radiusNm as 12 | 25 | 38;
      // Two bounded CAS passes cover an acquisition racing view construction.
      // Every returned position belongs to the re-read collection; an older
      // board is applied through existing stability rules, never reset merely
      // because a new collection arrived while this request was assembling.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (!current.collection || current.health === "unavailable") return { health: current.health, view: null };
        const prior = await store.readStableView(areaId, radiusNm, clock());
        const enriched = await overlay(current.collection, area, prior);
        const preliminary = buildNearbyView(enriched, area, clock(), { limit, previousStability: prior });
        const stability = await store.stableView({ areaId, radiusNm,
          collectionVersion: current.collection.collectionVersion, nowMs: clock(), successfulCollection: !current.collection.lastAttemptFailed, ranked: preliminary.ranked });
        const latest = await collection.read();
        if (!latest.collection || latest.health === "unavailable") return { health: latest.health, view: null };
        if (latest.collection.collectionVersion === current.collection.collectionVersion) {
          const latestEnriched = await overlay(latest.collection, area, stability ?? prior);
          return { health: latest.health, view: viewWithRoutes(latest.collection, latestEnriched, area, clock(), { limit, previousStability: stability ?? prior }) };
        }
        current = latest;
      }
      const prior = await store.readStableView(areaId, radiusNm, clock());
      const enriched = await overlay(current.collection!, area, prior);
      return { health: current.health, view: viewWithRoutes(current.collection!, enriched, area, clock(), { limit,
        previousStability: prior && prior.collectionVersion <= current.collection!.collectionVersion ? prior : null }) };
    },
    tick: collection.tick,
    read: collection.read,
    cleanup: collection.cleanup,
    cleanupRouteHints: () => options.routeEnrichment?.cleanup(clock()) ?? Promise.resolve({ hints: 0, budgets: 0 }),
  };
}

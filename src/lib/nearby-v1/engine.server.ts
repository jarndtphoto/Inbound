import { randomUUID } from "node:crypto";
import { areaDefinition, DISPLAY_RADII_NM, type AREA_IDS } from "../plugin-v1/areas";
import { acquireNearbyChicago } from "./acquisition.server";
import { createNearbyCollectionService } from "./collection";
import type { NearbyAcquire } from "./model";
import { createNearbyCollectionStore, type NearbyStableCollectionStore } from "./store.server";
import { buildNearbyView } from "./views";

/**
 * Private Inbound entry point. Intentionally unmounted: no public endpoint,
 * createServerFn, fixture tool, or ChatGPT resource calls this in Part 3B.1.
 * A real shared database with the explicit minimal migration is required.
 */
export function createPrivateNearbyEngine(options: {
  environment: string;
  store?: NearbyStableCollectionStore;
  acquire?: NearbyAcquire;
  clock?: () => number;
}) {
  const clock = options.clock ?? Date.now;
  const store = options.store ?? createNearbyCollectionStore({ environment: options.environment });
  const collection = createNearbyCollectionService({ store, acquire: options.acquire ?? acquireNearbyChicago, clock, leaseOwner: randomUUID });
  return {
    async request(areaId: (typeof AREA_IDS)[number], input: { radiusNm?: 12 | 25 | 38; limit?: number } = {}) {
      const area = areaDefinition(areaId);
      if (!area) throw new RangeError("Unsupported Nearby area");
      if (input.radiusNm !== undefined) {
        if (!(DISPLAY_RADII_NM as readonly number[]).includes(input.radiusNm)) throw new RangeError("Unsupported Nearby radius");
        area.radiusNm = input.radiusNm;
      }
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
        const preliminary = buildNearbyView(current.collection, area, clock(), { limit, previousStability: prior });
        const stability = await store.stableView({ areaId, radiusNm,
          collectionVersion: current.collection.collectionVersion, nowMs: clock(), successfulCollection: !current.collection.lastAttemptFailed, ranked: preliminary.ranked });
        const latest = await collection.read();
        if (!latest.collection || latest.health === "unavailable") return { health: latest.health, view: null };
        if (latest.collection.collectionVersion === current.collection.collectionVersion) {
          return { health: latest.health, view: buildNearbyView(latest.collection, area, clock(), { limit, previousStability: stability ?? prior }) };
        }
        current = latest;
      }
      const prior = await store.readStableView(areaId, radiusNm, clock());
      return { health: current.health, view: buildNearbyView(current.collection!, area, clock(), { limit,
        previousStability: prior && prior.collectionVersion <= current.collection!.collectionVersion ? prior : null }) };
    },
    tick: collection.tick,
    read: collection.read,
    cleanup: collection.cleanup,
  };
}

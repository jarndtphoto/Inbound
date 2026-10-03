import { CHICAGO_COLLECTION } from "../plugin-v1/areas";
import { NEARBY_POLICY, observationFreshness, type CollectionRead, type NearbyAcquire, type NearbyCollectionStore, type SharedCollection } from "./model";

/** Logical expiry is enforced even when physical cleanup has not run. */
export function readCollectionHealth(collection: SharedCollection | null, nowMs: number): CollectionRead {
  if (!Number.isFinite(nowMs)) throw new RangeError("Invalid collection clock");
  const unavailable = (): CollectionRead => ({ health: "unavailable", collection, observations: [] });
  if (!collection || collection.collectionKey !== CHICAGO_COLLECTION.id || collection.inactiveExpiresAtMs <= nowMs
    || collection.acceptedSnapshotAtMs === null || collection.acceptedSnapshotAtMs > nowMs + 1_000
    || nowMs - collection.acceptedSnapshotAtMs > NEARBY_POLICY.hardStaleMs) return unavailable();
  const observations = collection.observations.filter(o => Date.parse(o.observedAt) <= nowMs + 1_000 && observationFreshness(o.observedAt, nowMs).state !== "expired")
    .map(o => ({ ...o, freshness: observationFreshness(o.observedAt, nowMs) }));
  if (collection.observations.length > 0 && observations.length === 0) return unavailable();
  const stale = collection.lastAttemptFailed || nowMs - collection.acceptedSnapshotAtMs > NEARBY_POLICY.freshMs
    || observations.some(o => o.freshness.state === "stale");
  return { health: stale ? "stale" : collection.partial || observations.length < collection.observations.length ? "partial" : "ok", collection, observations };
}

/**
 * No polling loop is started here. Requests (or a future private bounded tick)
 * trigger a claim only when due. Contenders serve current state without waiting
 * on the winner; cold contenders explicitly return unavailable/warming state.
 */
export function createNearbyCollectionService(options: {
  store: NearbyCollectionStore;
  acquire: NearbyAcquire;
  clock?: () => number;
  leaseOwner: () => string;
}) {
  const clock = options.clock ?? Date.now;
  async function attempt(): Promise<CollectionRead> {
    const lease = await options.store.claim(options.leaseOwner(), clock());
    if (lease) {
      try {
        const result = await options.acquire(lease.collection.observations);
        await options.store.publish(lease, result, clock());
      } catch {
        // No fallback acquisition: a DB outage must never create per-viewer calls.
        // A provider failure only changes retry metadata, preserving the snapshot.
        await options.store.fail(lease, clock());
      }
    }
    return readCollectionHealth(await options.store.read(clock()), clock());
  }
  return {
    async request(): Promise<CollectionRead> {
      await options.store.touch(clock());
      return attempt();
    },
    /** Does not extend activity. Once activeUntil expires, no lease can be won. */
    async tick(): Promise<CollectionRead> { return attempt(); },
    async read(): Promise<CollectionRead> { return readCollectionHealth(await options.store.read(clock()), clock()); },
    async cleanup(): Promise<number> { return options.store.cleanup(clock()); },
  };
}

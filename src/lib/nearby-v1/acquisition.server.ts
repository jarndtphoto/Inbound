import { fetchAroundWithStatus, fuseProviderLists, type AdsbRaw, type ProviderAcquisitionPack, type ProviderPack } from "../adsb-fusion";
import { CHICAGO_COLLECTION } from "../plugin-v1/areas";
import { normalizeAcceptedNearby } from "./normalize";
import type { NearbyAcquire, AcquisitionMetadata } from "./model";

type AcquisitionDependencies = {
  clock?: () => number;
  fetchAround?: (latitude: number, longitude: number, radiusNm: number) => Promise<ProviderAcquisitionPack[]>;
  fuse?: (packs: ProviderPack[], options: { now: number; airside: boolean; preferObserved: boolean }) => AdsbRaw[];
};
export class NearbyAcquisitionUnavailable extends Error {
  readonly metadata: AcquisitionMetadata;
  constructor(metadata: AcquisitionMetadata) {
    super("Nearby aviation collection unavailable");
    this.name = "NearbyAcquisitionUnavailable";
    this.metadata = metadata;
  }
}
/** Inbound-owned real acquisition only. There is no route, MCP, or public tool
 * registration importing this module in Part 3B.1. */
export function createNearbyAcquire(dependencies: AcquisitionDependencies = {}): NearbyAcquire {
  const clock = dependencies.clock ?? Date.now;
  const fetchAround = dependencies.fetchAround ?? fetchAroundWithStatus;
  const fuse = dependencies.fuse ?? fuseProviderLists;
  return async previous => {
    const packs = await fetchAround(CHICAGO_COLLECTION.latitude, CHICAGO_COLLECTION.longitude, CHICAGO_COLLECTION.radiusNm);
    const successfulProviders = packs.filter(pack => pack.status === "ok").length;
    const nowMs = clock();
    const successfulPacks = packs.filter(pack => pack.status === "ok");
    const rawCount = successfulPacks.reduce((count, pack) => count + pack.ac.length, 0);
    // A successful zero-aircraft response is real empty sky. Fusion's warm track
    // fallback must not repopulate it from another airport or earlier request.
    const fused = rawCount ? fuse(successfulPacks, { now: nowMs, airside: true, preferObserved: true }) : [];
    const observations = normalizeAcceptedNearby(successfulPacks, fused, previous, nowMs);
    const metadata: AcquisitionMetadata = {
      providerCalls: packs.filter(pack => pack.attempted).length, rawCount, fusedCount: fused.length,
      rejectedCount: Math.max(0, rawCount - observations.length), successfulProviders, failedProviders: packs.length - successfulProviders,
    };
    // Coverage failure, bad-only rows, or an empty response from only a subset
    // of providers cannot replace a last-safe collection with an empty sky.
    if (!successfulProviders || !observations.length && (rawCount > 0 || successfulProviders < packs.length)) {
      throw new NearbyAcquisitionUnavailable(metadata);
    }
    return {
      observations, partial: successfulProviders < packs.length,
      metadata,
    };
  };
}
export const acquireNearbyChicago: NearbyAcquire = createNearbyAcquire();

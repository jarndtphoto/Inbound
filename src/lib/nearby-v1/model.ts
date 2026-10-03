import type { NearbyCandidate } from "../plugin-v1/ranking";

/** Private Inbound engine state. This is deliberately not a public plugin DTO. */
export const NEARBY_POLICY = Object.freeze({
  cadenceMs: 20_000,
  leaseMs: 10_000,
  activeForMs: 60_000,
  inactiveRetentionMs: 3_600_000,
  freshMs: 45_000,
  hardStaleMs: 120_000,
  maxExtrapolationMs: 25_000,
  maxAccepted: 1_000,
  maxRadar: 100,
  maxRadarBytes: 49_152,
  failureBackoffSeconds: [20, 40, 80, 120] as readonly number[],
});
export type Freshness = { ageSeconds: number; state: "fresh" | "stale" | "expired" };
export type AcceptedNearbyObservation = NearbyCandidate & {
  radarId: string;
  observedAt: string;
  groundTrackDeg: number | null;
  /** Private continuity evidence; never presented as the current observation. */
  sessionIdentity?: { observedCallsign: string | null; registration: string | null };
  freshness: Freshness;
  provenance: {
    source: string;
    receivedAt: string;
    positionAgeSeconds: number;
    acceptance: "inbound-fusion";
  };
};
export type AcquisitionMetadata = {
  providerCalls: number;
  rawCount: number;
  fusedCount: number;
  rejectedCount: number;
  successfulProviders: number;
  failedProviders: number;
};
export type AcquisitionResult = {
  observations: AcceptedNearbyObservation[];
  partial: boolean;
  metadata: AcquisitionMetadata;
};
export type SharedCollection = {
  collectionKey: string;
  collectionVersion: number;
  acceptedSnapshotAtMs: number | null;
  observations: AcceptedNearbyObservation[];
  metadata: AcquisitionMetadata | null;
  partial: boolean;
  lastAttemptFailed: boolean;
  leaseOwner: string | null;
  leaseUntilMs: number | null;
  fencingGeneration: number;
  nextAttemptAtMs: number;
  failureBackoffSeconds: number;
  activeUntilMs: number;
  inactiveExpiresAtMs: number;
};
export type CollectionHealth = "ok" | "partial" | "stale" | "unavailable";
export type CollectionRead = {
  health: CollectionHealth;
  collection: SharedCollection | null;
  observations: AcceptedNearbyObservation[];
};
export type CollectionLease = {
  owner: string;
  generation: number;
  collection: SharedCollection;
};
/** Atomic store implementations coordinate servers; an in-process cache cannot win a lease. */
export interface NearbyCollectionStore {
  touch(nowMs: number): Promise<SharedCollection>;
  read(nowMs: number): Promise<SharedCollection | null>;
  claim(owner: string, nowMs: number): Promise<CollectionLease | null>;
  publish(lease: CollectionLease, result: AcquisitionResult, nowMs: number): Promise<boolean>;
  fail(lease: CollectionLease, nowMs: number): Promise<boolean>;
  cleanup(nowMs: number): Promise<number>;
}
export type NearbyAcquire = (previous: readonly AcceptedNearbyObservation[]) => Promise<AcquisitionResult>;
export function observationFreshness(observedAt: string, nowMs: number): Freshness {
  const ageSeconds = Math.max(0, (nowMs - Date.parse(observedAt)) / 1_000);
  return { ageSeconds, state: !Number.isFinite(ageSeconds) || ageSeconds > NEARBY_POLICY.hardStaleMs / 1_000 ? "expired" : ageSeconds > NEARBY_POLICY.freshMs / 1_000 ? "stale" : "fresh" };
}

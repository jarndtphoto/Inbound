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
  maxAcceptedBytes: 1_048_576,
  /** Six preceding polls cover the shared classifier's 120-second window. */
  maxPhaseSamples: 6,
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
/** Conservative size of PostgreSQL JSONB text, whose separators include spaces.
 * Numeric exponents can expand in JSONB text. Strings are counted as UTF-8 and
 * their punctuation is never mistaken for a structural separator. */
export function nearbyStorageBytes(value: unknown): number {
  const json = JSON.stringify(value);
  let bytes = new TextEncoder().encode(json).length;
  let quoted = false, escaped = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "," || ch === ":") bytes++;
    else if (ch === "-" || ch >= "0" && ch <= "9") {
      const token = json.slice(i).match(/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i)![0];
      const exponent = token.match(/^(-?)(\d+)(?:\.(\d+))?e([+-]?\d+)$/i);
      if (exponent) {
        const digits = exponent[2] + (exponent[3] ?? ""), point = exponent[2].length + Number(exponent[4]);
        const expanded = exponent[1].length + (point <= 0 ? 2 - point + digits.length : point >= digits.length ? point : digits.length + 1);
        bytes += Math.max(0, expanded - token.length);
      }
      i += token.length - 1;
    }
  }
  return bytes;
}
export function observationFreshness(observedAt: string, nowMs: number): Freshness {
  const ageSeconds = Math.max(0, (nowMs - Date.parse(observedAt)) / 1_000);
  return { ageSeconds, state: !Number.isFinite(ageSeconds) || ageSeconds > NEARBY_POLICY.hardStaleMs / 1_000 ? "expired" : ageSeconds > NEARBY_POLICY.freshMs / 1_000 ? "stale" : "fresh" };
}

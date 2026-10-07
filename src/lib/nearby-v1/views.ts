import { CHICAGO_COLLECTION, DEFAULT_LIMIT, rankingViewKey } from "../plugin-v1/areas";
import { DisplayIdentSchema, ResolvedAreaV1Schema, type InboundNearbyFlight, type ResolvedAreaV1 } from "../plugin-v1/contracts";
import { currentRoute, rankNearbyCandidates, type RankedCandidate } from "../plugin-v1/ranking";
import { stablePrefix, updateStableView, type NearbyStabilityState } from "../plugin-v1/stability";
import { NEARBY_POLICY, observationFreshness, type AcceptedNearbyObservation, type Freshness, type SharedCollection } from "./model";

/** Private renderer boundary. No provider, aircraft identity, or handoff tokens. */
export type NearbyRadarObservation = {
  radarId: string;
  displayIdent: string;
  latitude: number;
  longitude: number;
  observedAt: string;
  altitudeFt: number | null;
  groundspeedKt: number | null;
  groundTrackDeg: number | null;
  verticalRateFpm: number | null;
  positionKind: AcceptedNearbyObservation["positionKind"];
  freshness: Freshness;
  motion: InboundNearbyFlight["motion"];
  distanceNm: number;
  bearingDeg: number;
  featured: boolean;
  typeCode?: string;
};
export type NearbyView = {
  collectionKey: string;
  collectionVersion: number;
  viewKey: string;
  radar: NearbyRadarObservation[];
  featured: RankedCandidate[];
  /** All eligible rows for shared ranked-view persistence, not just the prefix. */
  ranked: RankedCandidate[];
  stability: NearbyStabilityState | null;
};
export type NearbyViewOptions = { limit?: number; previousStability?: NearbyStabilityState | null };

function usableIdent(ident: string | null): boolean {
  return DisplayIdentSchema.safeParse(ident).success;
}
function withCurrentAge(row: RankedCandidate, nowMs: number): RankedCandidate {
  return { ...row, ageSeconds: observationFreshness(row.candidate.observedAt!, nowMs).ageSeconds, route: currentRoute(row.candidate, nowMs) };
}

/**
 * One accepted Chicago collection produces each area's own geometry/ranking.
 * Rank at its publication time so outage reads preserve the last-safe board;
 * enforce absolute telemetry age again at display time without refreshing it.
 */
export function buildNearbyView(collection: SharedCollection, area: ResolvedAreaV1, nowMs: number, options: NearbyViewOptions = {}): NearbyView {
  if (!Number.isFinite(nowMs)) throw new RangeError("Invalid view time");
  ResolvedAreaV1Schema.parse(area);
  if (collection.collectionKey !== CHICAGO_COLLECTION.id) throw new RangeError("Unsupported collection");
  const limit = options.limit ?? DEFAULT_LIMIT;
  // Keep exactly the existing one-to-five presentation-prefix contract.
  stablePrefix(null, limit);
  const viewKey = rankingViewKey(area);
  const snapshotAtMs = collection.acceptedSnapshotAtMs;
  const empty = (): NearbyView => ({ collectionKey: collection.collectionKey, collectionVersion: collection.collectionVersion, viewKey, radar: [], featured: [], ranked: [], stability: options.previousStability?.viewKey === viewKey && options.previousStability.inactiveExpiresAtMs > nowMs ? structuredClone(options.previousStability) : null });
  if (snapshotAtMs === null || !Number.isFinite(snapshotAtMs) || snapshotAtMs > nowMs + 1_000
    || nowMs - snapshotAtMs > NEARBY_POLICY.hardStaleMs || collection.collectionVersion < 1) return empty();

  const current = collection.observations.filter(o => observationFreshness(o.observedAt, nowMs).state !== "expired")
    .map(o => ({ ...o, freshness: observationFreshness(o.observedAt, nowMs) }));
  const ranked = rankNearbyCandidates(current, area, snapshotAtMs).map(r => withCurrentAge(r, nowMs));
  const previous = options.previousStability?.viewKey === viewKey && options.previousStability.inactiveExpiresAtMs > nowMs ? options.previousStability : null;
  const stability = updateStableView(previous, {
    viewKey, collectionVersion: collection.collectionVersion, nowMs,
    // A cold view can seed from the last accepted publication during an outage.
    // A previously published view retains its order while acquisition fails.
    successfulCollection: !collection.lastAttemptFailed || previous === null,
    ranked,
  });
  const byCardId = new Map(ranked.map(r => [r.candidate.cardId, r]));
  const featured = stablePrefix(stability, limit).flatMap(cardId => {
    const row = byCardId.get(cardId); return row ? [row] : [];
  });
  const featuredIds = new Set(featured.map(r => r.candidate.cardId));

  // Unidentified accepted aircraft still get neutral symbols. They remain
  // excluded from featured cards, whose original identity rules are unchanged.
  const radarCandidates = current.map(o => usableIdent(o.observedCallsign) || usableIdent(o.registration) ? o
    : { ...o, observedCallsign: "AIRCRAFT", registration: null });
  const radarRows = rankNearbyCandidates(radarCandidates, area, snapshotAtMs)
    .sort((a, b) => Number(featuredIds.has(b.candidate.cardId)) - Number(featuredIds.has(a.candidate.cardId)));
  const radar: NearbyRadarObservation[] = [];
  const encoder = new TextEncoder();
  let bytes = 2; // JSON array brackets.
  for (const r of radarRows) {
    if (radar.length >= NEARBY_POLICY.maxRadar) break;
    // The ranking winner itself owns the telemetry; a separate card-ID map
    // could accidentally substitute an older duplicate fix from the input.
    const o = r.candidate as AcceptedNearbyObservation;
    const entry: NearbyRadarObservation = {
      radarId: o.radarId, displayIdent: r.displayIdent,
      latitude: o.latitude, longitude: o.longitude, observedAt: o.observedAt,
      altitudeFt: o.altitudeFt, groundspeedKt: o.groundspeedKt, groundTrackDeg: o.groundTrackDeg,
      verticalRateFpm: o.verticalRateFpm, positionKind: o.positionKind,
      freshness: observationFreshness(o.observedAt, nowMs), motion: r.motion,
      distanceNm: r.distanceNm, bearingDeg: r.bearingDeg, featured: featuredIds.has(o.cardId),
      ...(o.typeCode && /^[A-Z0-9]{1,8}$/.test(o.typeCode) ? { typeCode: o.typeCode } : {}),
    };
    const entryBytes = encoder.encode(JSON.stringify(entry)).length + (radar.length ? 1 : 0);
    if (bytes + entryBytes > NEARBY_POLICY.maxRadarBytes) continue;
    radar.push(entry); bytes += entryBytes;
  }
  return { collectionKey: collection.collectionKey, collectionVersion: collection.collectionVersion, viewKey, radar, featured, ranked, stability };
}

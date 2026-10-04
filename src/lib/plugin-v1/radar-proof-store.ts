import { CHICAGO_COLLECTION } from "./areas";
import { updateStableView, type NearbyStabilityState } from "./stability";
import { NEARBY_POLICY, nearbyStorageBytes, type AcquisitionResult, type SharedCollection } from "../nearby-v1/model";
import type { NearbyStableCollectionStore } from "../nearby-v1/store.server";
import { normalizeObservedCallsign, routeHintUsable, validateRouteHint, ROUTE_HINT_POLICY,
  type NearbyRouteHint, type NearbyRouteHintLease, type NearbyRouteHintStore } from "../nearby-v1/route-hints";

/** Disposable fake host-proof storage. This is never a production SQL adapter.
 * One instance is shared by every proof viewer; atomic methods contain no await
 * before their state update. Production SQL and its certification stay intact. */
export function createFakeRadarProofStores() {
  let current: SharedCollection | null = null;
  const views = new Map<string, NearbyStabilityState>();
  type HintRow = { generation: number; lease: NearbyRouteHintLease | null; hint: NearbyRouteHint | null; retryAtMs: number };
  const hints = new Map<string, HintRow>();
  let cycleVersion = 0, cycleStarts = 0;
  let recentStarts: number[] = [];
  let leaseWinners = 0, chargedRouteStarts = 0;
  const clone = <T>(value: T): T => structuredClone(value);
  const key = (areaId: string, radiusNm: number) => `${areaId}:${radiusNm}:ranking-v1`;
  const usableCurrent = (at: number) => current && current.inactiveExpiresAtMs > at ? current : null;
  const owns = (owner: string, generation: number, at: number) => !!current && current.leaseOwner === owner
    && current.fencingGeneration === generation && current.leaseUntilMs !== null && current.leaseUntilMs > at
    && current.inactiveExpiresAtMs > at;

  const collection: NearbyStableCollectionStore = {
    async touch(at) {
      if (!Number.isFinite(at)) throw new RangeError("Invalid fake proof clock");
      current ??= { collectionKey: CHICAGO_COLLECTION.id, collectionVersion: 0, acceptedSnapshotAtMs: null,
        observations: [], metadata: null, partial: false, lastAttemptFailed: false, leaseOwner: null, leaseUntilMs: null,
        fencingGeneration: 0, nextAttemptAtMs: at, failureBackoffSeconds: 20,
        activeUntilMs: at + NEARBY_POLICY.activeForMs, inactiveExpiresAtMs: at + NEARBY_POLICY.inactiveRetentionMs };
      current.activeUntilMs = Math.max(current.activeUntilMs, at + NEARBY_POLICY.activeForMs);
      current.inactiveExpiresAtMs = Math.max(current.inactiveExpiresAtMs, at + NEARBY_POLICY.inactiveRetentionMs);
      return clone(current);
    },
    async read(at) { return clone(usableCurrent(at)); },
    async claim(owner, at) {
      if (!current || current.activeUntilMs <= at || current.inactiveExpiresAtMs <= at || current.nextAttemptAtMs > at
        || current.leaseUntilMs !== null && current.leaseUntilMs > at) return null;
      current.leaseOwner = owner;
      current.leaseUntilMs = at + NEARBY_POLICY.leaseMs;
      current.fencingGeneration++;
      current.nextAttemptAtMs = Math.max(current.nextAttemptAtMs, at + NEARBY_POLICY.cadenceMs);
      leaseWinners++;
      return { owner, generation: current.fencingGeneration, collection: clone(current) };
    },
    async publish(lease, result: AcquisitionResult, at) {
      if (!owns(lease.owner, lease.generation, at)) return false;
      if (result.observations.length > NEARBY_POLICY.maxAccepted || nearbyStorageBytes(result.observations) > NEARBY_POLICY.maxAcceptedBytes
        || result.observations.some(row => row.phaseEvidence && row.phaseEvidence.length > NEARBY_POLICY.maxPhaseSamples
          || at - Date.parse(row.observedAt) > NEARBY_POLICY.freshMs || Date.parse(row.observedAt) > at + 1000)) {
        throw new RangeError("Invalid invented snapshot bounds");
      }
      current!.collectionVersion++;
      current!.acceptedSnapshotAtMs = at;
      current!.observations = clone(result.observations);
      current!.metadata = clone(result.metadata);
      current!.partial = result.partial;
      current!.lastAttemptFailed = false;
      current!.leaseOwner = null;
      current!.leaseUntilMs = null;
      current!.nextAttemptAtMs = at + NEARBY_POLICY.cadenceMs;
      current!.failureBackoffSeconds = 20;
      return true;
    },
    async fail(lease, at) {
      if (!owns(lease.owner, lease.generation, at)) return false;
      current!.lastAttemptFailed = true;
      current!.leaseOwner = null;
      current!.leaseUntilMs = null;
      current!.nextAttemptAtMs = at + current!.failureBackoffSeconds * 1000;
      current!.failureBackoffSeconds = Math.min(current!.failureBackoffSeconds * 2, 120);
      return true;
    },
    async cleanup(at) {
      if (!current || current.inactiveExpiresAtMs > at || current.leaseUntilMs !== null && current.leaseUntilMs > at) return 0;
      current = null;
      views.clear();
      return 1;
    },
    async readStableView(areaId, radiusNm, at) {
      const view = views.get(key(areaId, radiusNm));
      return usableCurrent(at) && view && view.inactiveExpiresAtMs > at ? clone(view) : null;
    },
    async stableView(input) {
      if (!usableCurrent(input.nowMs) || current!.collectionVersion !== input.collectionVersion) return null;
      const viewKey = key(input.areaId, input.radiusNm);
      const next = updateStableView(views.get(viewKey) ?? null, { ...input, viewKey });
      if (next) views.set(viewKey, clone(next));
      return clone(next);
    },
  };
  const route: NearbyRouteHintStore = {
    async read(callsigns, at) {
      return callsigns.flatMap(callsign => { const row = hints.get(callsign); return row?.hint && routeHintUsable(row.hint, at) ? [clone(row.hint)] : []; });
    },
    async claim(input) {
      const { observedCallsign, owner, nowMs: at, collectionVersion } = input;
      if (normalizeObservedCallsign(observedCallsign) !== observedCallsign || !usableCurrent(at)
        || current!.activeUntilMs <= at || current!.lastAttemptFailed || current!.collectionVersion !== collectionVersion
        || current!.acceptedSnapshotAtMs === null || at - current!.acceptedSnapshotAtMs > NEARBY_POLICY.freshMs) return null;
      for (const [callsign, row] of hints) {
        if (!row.lease && (!row.hint || !routeHintUsable(row.hint, at)) && row.retryAtMs <= at) hints.delete(callsign);
      }
      const previous = hints.get(observedCallsign);
      if (previous?.hint && routeHintUsable(previous.hint, at) || previous && previous.retryAtMs > at
        || previous?.lease && previous.lease.leaseUntilMs > at) return null;
      if (!previous && hints.size >= ROUTE_HINT_POLICY.maxCacheRows) return null;
      if (cycleVersion !== collectionVersion) { cycleVersion = collectionVersion; cycleStarts = 0; }
      recentStarts = recentStarts.filter(start => start > at - ROUTE_HINT_POLICY.minuteWindowMs);
      if (cycleStarts >= ROUTE_HINT_POLICY.newLookupsPerCollection || recentStarts.length >= ROUTE_HINT_POLICY.newLookupsPerMinute) return null;
      const lease = { observedCallsign, owner, generation: (previous?.generation ?? 0) + 1,
        claimedAtMs: at, leaseUntilMs: at + ROUTE_HINT_POLICY.leaseMs };
      hints.set(observedCallsign, { generation: lease.generation, lease, hint: null, retryAtMs: at + ROUTE_HINT_POLICY.negativeTtlMs });
      cycleStarts++;
      chargedRouteStarts++;
      recentStarts.push(at);
      return clone(lease);
    },
    async publish(lease, hint, at) {
      validateRouteHint(hint);
      const row = hints.get(lease.observedCallsign);
      if (!row?.lease || row.lease.owner !== lease.owner || row.generation !== lease.generation || row.lease.leaseUntilMs <= at
        || hint.observedCallsign !== lease.observedCallsign || !usableCurrent(at)) return false;
      row.hint = clone(hint);
      row.retryAtMs = Date.parse(hint.expiresAt);
      row.lease = null;
      return true;
    },
    async fail(lease, at) {
      const row = hints.get(lease.observedCallsign);
      if (!row?.lease || row.lease.owner !== lease.owner || row.generation !== lease.generation || row.lease.leaseUntilMs <= at) return false;
      row.lease = null;
      row.hint = null;
      row.retryAtMs = at + ROUTE_HINT_POLICY.negativeTtlMs;
      return true;
    },
    async cleanup(at) {
      let removed = 0;
      for (const [callsign, row] of hints) {
        if ((!row.lease || row.lease.leaseUntilMs <= at) && row.retryAtMs <= at) { hints.delete(callsign); removed++; }
      }
      const budgetExpired = !usableCurrent(at);
      if (budgetExpired) { recentStarts = []; cycleVersion = 0; cycleStarts = 0; }
      return { hints: removed, budgets: Number(budgetExpired) };
    },
  };
  return { collection, route, diagnostics: () => ({ collectionRows: current ? 1 : 0,
    collectionVersion: current?.collectionVersion ?? 0, acceptedObservations: current?.observations.length ?? 0,
    rankedViews: views.size, routeRows: hints.size, cycleStarts, recentStarts: recentStarts.length,
    leaseWinners, chargedRouteStarts, historyRows: 0 as const }),
    dispose() { current = null; views.clear(); hints.clear(); recentStarts = []; } };
}

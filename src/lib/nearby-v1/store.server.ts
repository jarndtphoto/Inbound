import type { Sql } from "../db";
import { CHICAGO_COLLECTION } from "../plugin-v1/areas";
import { DisplayIdentSchema } from "../plugin-v1/contracts";
import type { RankedCandidate } from "../plugin-v1/ranking";
import { updateStableView, type NearbyStabilityState } from "../plugin-v1/stability";
import { NEARBY_POLICY, type AcquisitionMetadata, type AcquisitionResult, type CollectionLease, type NearbyCollectionStore, type SharedCollection } from "./model";

type Instant = Date | string;
type CollectionRow = {
  collection_key: string; collection_version: number | string; accepted_snapshot_at: Instant | null;
  accepted_collection: SharedCollection["observations"] | null;
  last_safe_snapshot_metadata: { metadata: AcquisitionMetadata; partial: boolean } | null;
  last_attempt_failed: boolean; lease_owner: string | null; lease_until: Instant | null;
  fencing_generation: number | string; next_attempt_at: Instant; failure_backoff_seconds: number;
  active_until: Instant; inactive_expires_at: Instant;
};
type ViewRow = { applied_collection_version: number | string; revision: number | string; slots: NearbyStabilityState["slots"]; inactive_expires_at: Instant };
export type StableViewInput = {
  areaId: "preset:chicago" | "airport:KORD" | "airport:KMDW";
  radiusNm: 12 | 25 | 38; collectionVersion: number; nowMs: number;
  successfulCollection: boolean; ranked: readonly RankedCandidate[];
};
export interface NearbyStableCollectionStore extends NearbyCollectionStore {
  stableView(input: StableViewInput): Promise<NearbyStabilityState | null>;
  readStableView(areaId: StableViewInput["areaId"], radiusNm: StableViewInput["radiusNm"], nowMs: number): Promise<NearbyStabilityState | null>;
}
function milliseconds(value: Instant): number { return value instanceof Date ? value.getTime() : Date.parse(value); }
function collection(row: CollectionRow): SharedCollection {
  return {
    collectionKey: row.collection_key, collectionVersion: Number(row.collection_version),
    acceptedSnapshotAtMs: row.accepted_snapshot_at === null ? null : milliseconds(row.accepted_snapshot_at),
    observations: row.accepted_collection ?? [], metadata: row.last_safe_snapshot_metadata?.metadata ?? null,
    partial: row.last_safe_snapshot_metadata?.partial ?? false, lastAttemptFailed: row.last_attempt_failed,
    leaseOwner: row.lease_owner, leaseUntilMs: row.lease_until === null ? null : milliseconds(row.lease_until),
    fencingGeneration: Number(row.fencing_generation), nextAttemptAtMs: milliseconds(row.next_attempt_at),
    failureBackoffSeconds: row.failure_backoff_seconds, activeUntilMs: milliseconds(row.active_until),
    inactiveExpiresAtMs: milliseconds(row.inactive_expires_at),
  };
}
function validateView(areaId: string, radiusNm: number) {
  if (!["preset:chicago", "airport:KORD", "airport:KMDW"].includes(areaId) || ![12, 25, 38].includes(radiusNm)) throw new RangeError("Unsupported Nearby view");
}
function viewKey(areaId: string, radiusNm: number) { return `${areaId}:${radiusNm}:ranking-v1`; }
function stable(row: ViewRow, areaId: string, radiusNm: number): NearbyStabilityState {
  return { viewKey: viewKey(areaId, radiusNm), collectionVersion: Number(row.applied_collection_version), slots: row.slots, inactiveExpiresAtMs: milliseconds(row.inactive_expires_at) };
}
const observationFields = new Set(["cardId", "privateAircraftIdentity", "sessionKey", "observedCallsign", "registration", "latitude", "longitude", "altitudeFt", "groundspeedKt", "verticalRateFpm", "onGround", "observedAt", "positionKind", "acceptedPosition", "identityConflict", "typeCode", "category", "operator", "interesting", "route", "datedBinding", "radarId", "groundTrackDeg", "sessionIdentity", "freshness", "provenance"]);
const metadataFields = new Set(["providerCalls", "rawCount", "fusedCount", "rejectedCount", "successfulProviders", "failedProviders"]);
function validatePublication(result: AcquisitionResult, nowMs: number) {
  if (!Array.isArray(result.observations) || result.observations.length > NEARBY_POLICY.maxAccepted
    || typeof result.partial !== "boolean" || !result.metadata
    || Object.keys(result.metadata).length !== metadataFields.size || Object.keys(result.metadata).some(key => !metadataFields.has(key))
    || Object.values(result.metadata).some(value => !Number.isSafeInteger(value) || value < 0)) throw new RangeError("Invalid Nearby publication");
  const identities = new Set<string>();
  for (const observation of result.observations) {
    if (!observation || Object.keys(observation).some(key => !observationFields.has(key))
      || typeof observation.privateAircraftIdentity !== "string" || !observation.privateAircraftIdentity
      || identities.has(observation.privateAircraftIdentity) || !observation.acceptedPosition || observation.identityConflict
      || !["observed", "extrapolated"].includes(observation.positionKind)
      || !Number.isFinite(observation.latitude) || Math.abs(observation.latitude) > 90
      || !Number.isFinite(observation.longitude) || Math.abs(observation.longitude) > 180
      || !Number.isFinite(Date.parse(observation.observedAt)) || Date.parse(observation.observedAt) > nowMs + 1000
      || nowMs - Date.parse(observation.observedAt) > NEARBY_POLICY.freshMs
      || !observation.radarId || !observation.sessionKey || !observation.cardId
      || observation.groundTrackDeg !== null && (!Number.isFinite(observation.groundTrackDeg) || observation.groundTrackDeg < 0 || observation.groundTrackDeg >= 360)
      || [observation.altitudeFt, observation.groundspeedKt, observation.verticalRateFpm].some(value => value !== null && !Number.isFinite(value))
      || observation.sessionIdentity !== undefined && (!observation.sessionIdentity || typeof observation.sessionIdentity !== "object"
        || Array.isArray(observation.sessionIdentity) || Object.keys(observation.sessionIdentity).length !== 2
        || Object.keys(observation.sessionIdentity).some(key => !["observedCallsign", "registration"].includes(key))
        || [observation.sessionIdentity.observedCallsign, observation.sessionIdentity.registration].some(value => value !== null && !DisplayIdentSchema.safeParse(value).success))
      || observation.provenance?.acceptance !== "inbound-fusion"
      || Object.keys(observation.provenance).some(key => !["source", "receivedAt", "positionAgeSeconds", "acceptance"].includes(key))) throw new RangeError("Invalid accepted Nearby observation");
    identities.add(observation.privateAircraftIdentity);
  }
  if (Buffer.byteLength(JSON.stringify(result.observations), "utf8") > 1048576) throw new RangeError("Nearby collection exceeds payload bound");
}

/**
 * Private SQL coordination. Every acquisition claim/publication is one atomic
 * statement; no process-local lock or provider fallback bypasses the shared DB.
 * Production uses the database clock. Tests explicitly opt into a supplied clock.
 * DDL remains an explicitly applied isolated migration; imports never migrate it.
 */
export function createNearbyCollectionStore(options: {
  environment: string; sqlProvider?: () => Promise<Sql>; clock?: "database" | "provided";
}): NearbyStableCollectionStore {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(options.environment)) throw new RangeError("Invalid Nearby environment");
  const sqlProvider = options.sqlProvider ?? (async () => {
    // An unconfigured process-local PGlite DB cannot coordinate serverless
    // instances. Do not even import db.ts's eager bootstrap on this path.
    if (!process.env.DATABASE_URL?.trim()) throw new Error("Nearby acquisition requires the shared Inbound Postgres database");
    const db = await import("../db");
    if (db.dbSource !== "neon") throw new Error("Nearby acquisition requires the shared Inbound Postgres database");
    return db.getSql();
  });
  const params = (nowMs: number): unknown[] => {
    if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) throw new RangeError("Invalid Nearby clock");
    return [options.environment, CHICAGO_COLLECTION.id, options.clock === "provided" ? new Date(nowMs) : null];
  };
  const clock = "with clock as (select coalesce($3::timestamptz, clock_timestamp()) as instant)";
  async function readView(areaId: StableViewInput["areaId"], radiusNm: StableViewInput["radiusNm"], nowMs: number): Promise<ViewRow | null> {
    validateView(areaId, radiusNm);
    const sql = await sqlProvider();
    const rows = await sql.query<ViewRow>(`${clock}
      select v.* from inbound_plugin_v1.ranked_view v join inbound_plugin_v1.current_collection c
      using (environment, collection_key), clock
      where v.environment=$1 and v.collection_key=$2 and v.area_id=$4 and v.radius_nm=$5 and v.ranking_version=1
        and v.inactive_expires_at>clock.instant and c.inactive_expires_at>clock.instant`, [...params(nowMs), areaId, radiusNm]);
    return rows[0] ?? null;
  }
  return {
    async touch(nowMs) {
      const sql = await sqlProvider();
      const rows = await sql.query<CollectionRow>(`${clock}
        insert into inbound_plugin_v1.current_collection (environment, collection_key, next_attempt_at, active_until, inactive_expires_at)
        select $1,$2,clock.instant,clock.instant+$4*interval '1 millisecond',clock.instant+$5*interval '1 millisecond' from clock
        on conflict (environment, collection_key) do update set
          active_until=greatest(current_collection.active_until,excluded.active_until),
          inactive_expires_at=greatest(current_collection.inactive_expires_at,excluded.inactive_expires_at)
        returning *`, [...params(nowMs), NEARBY_POLICY.activeForMs, NEARBY_POLICY.inactiveRetentionMs]);
      return collection(rows[0]);
    },
    async read(nowMs) {
      const sql = await sqlProvider();
      const rows = await sql.query<CollectionRow>(`${clock}
        select c.* from inbound_plugin_v1.current_collection c,clock
        where environment=$1 and collection_key=$2 and inactive_expires_at>clock.instant`, params(nowMs));
      return rows[0] ? collection(rows[0]) : null;
    },
    async claim(owner, nowMs) {
      const sql = await sqlProvider();
      const rows = await sql.query<CollectionRow>(`${clock}
        update inbound_plugin_v1.current_collection c set lease_owner=$4::uuid,
          lease_until=clock.instant+$5*interval '1 millisecond',fencing_generation=c.fencing_generation+1,
          next_attempt_at=greatest(c.next_attempt_at,clock.instant+$6*interval '1 millisecond')
        from clock where c.environment=$1 and c.collection_key=$2
          and c.active_until>clock.instant and c.inactive_expires_at>clock.instant and c.next_attempt_at<=clock.instant
          and (c.lease_until is null or c.lease_until<=clock.instant) returning c.*`, [...params(nowMs), owner, NEARBY_POLICY.leaseMs, NEARBY_POLICY.cadenceMs]);
      if (!rows[0]) return null;
      const current = collection(rows[0]);
      return { owner, generation: current.fencingGeneration, collection: current };
    },
    async publish(lease: CollectionLease, result: AcquisitionResult, nowMs) {
      validatePublication(result, nowMs);
      const sql = await sqlProvider();
      const rows = await sql.query(`${clock}
        update inbound_plugin_v1.current_collection c set collection_version=c.collection_version+1,
          accepted_snapshot_at=clock.instant,accepted_collection=$6::jsonb,last_safe_snapshot_metadata=$7::jsonb,
          last_attempt_failed=false,lease_owner=null,lease_until=null,
          next_attempt_at=clock.instant+$8*interval '1 millisecond',failure_backoff_seconds=20
        from clock where c.environment=$1 and c.collection_key=$2 and c.lease_owner=$4::uuid
          and c.fencing_generation=$5 and c.lease_until>clock.instant and c.inactive_expires_at>clock.instant
        returning c.collection_version`, [...params(nowMs), lease.owner, lease.generation, JSON.stringify(result.observations), JSON.stringify({ metadata: result.metadata, partial: result.partial }), NEARBY_POLICY.cadenceMs]);
      return rows.length === 1;
    },
    async fail(lease, nowMs) {
      const sql = await sqlProvider();
      const rows = await sql.query(`${clock}
        update inbound_plugin_v1.current_collection c set last_attempt_failed=true,lease_owner=null,lease_until=null,
          next_attempt_at=clock.instant+c.failure_backoff_seconds*interval '1 second',
          failure_backoff_seconds=least(c.failure_backoff_seconds*2,120)
        from clock where c.environment=$1 and c.collection_key=$2 and c.lease_owner=$4::uuid
          and c.fencing_generation=$5 and c.lease_until>clock.instant and c.inactive_expires_at>clock.instant
        returning c.collection_version`, [...params(nowMs), lease.owner, lease.generation]);
      return rows.length === 1;
    },
    async cleanup(nowMs) {
      const sql = await sqlProvider();
      const rows = await sql.query(`${clock}
        delete from inbound_plugin_v1.current_collection c using clock
        where c.environment=$1 and c.collection_key=$2 and c.inactive_expires_at<=clock.instant
          and (c.lease_until is null or c.lease_until<=clock.instant) returning c.collection_key`, params(nowMs));
      return rows.length;
    },
    async readStableView(areaId, radiusNm, nowMs) {
      const row = await readView(areaId, radiusNm, nowMs);
      return row ? stable(row, areaId, radiusNm) : null;
    },
    async stableView(input) {
      const { areaId, radiusNm, nowMs, collectionVersion, successfulCollection, ranked } = input;
      validateView(areaId, radiusNm);
      if (!Number.isSafeInteger(collectionVersion) || collectionVersion < 1) throw new RangeError("Invalid Nearby collection version");
      // CAS retries rebase on the winner's slots; a stale acquisition/view never
      // replaces a newer collection's ranking or applies a second replacement.
      for (let attempt = 0; attempt < 8; attempt++) {
        const row = await readView(areaId, radiusNm, nowMs);
        const previous = row ? stable(row, areaId, radiusNm) : null;
        if (!successfulCollection && previous || previous && previous.collectionVersion >= collectionVersion) return previous;
        // A cold viewer during an outage may seed the accepted snapshot's
        // original ranking. This never ranks the failed provider response.
        const next = updateStableView(previous, { viewKey: viewKey(areaId, radiusNm), collectionVersion, nowMs, successfulCollection: true, ranked });
        if (!next) return null;
        const sql = await sqlProvider();
        const rows = await sql.query<ViewRow>(`${clock}
          insert into inbound_plugin_v1.ranked_view (environment,collection_key,area_id,radius_nm,ranking_version,applied_collection_version,slots,inactive_expires_at)
          select $1,$2,$4,$5,1,$6,$7::jsonb,clock.instant+$8*interval '1 millisecond'
          from inbound_plugin_v1.current_collection c,clock
          where c.environment=$1 and c.collection_key=$2 and c.collection_version=$6 and c.inactive_expires_at>clock.instant
          for share of c
          on conflict (environment,collection_key,area_id,radius_nm,ranking_version) do update set
            applied_collection_version=excluded.applied_collection_version,slots=excluded.slots,
            revision=ranked_view.revision+1,inactive_expires_at=excluded.inactive_expires_at
          where (ranked_view.revision=$9 and ranked_view.applied_collection_version<excluded.applied_collection_version)
            or ranked_view.inactive_expires_at<=(select instant from clock)
          returning *`, [...params(nowMs), areaId, radiusNm, collectionVersion, JSON.stringify(next.slots), NEARBY_POLICY.inactiveRetentionMs, row ? Number(row.revision) : 0]);
        if (rows[0]) return stable(rows[0], areaId, radiusNm);
        const current = await this.read(nowMs);
        if (!current || current.collectionVersion !== collectionVersion) return await this.readStableView(areaId, radiusNm, nowMs);
      }
      throw new Error("Nearby ranking contention exceeded retry budget");
    },
  };
}

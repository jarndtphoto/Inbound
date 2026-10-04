import type { Sql } from "../db";
import {
  ROUTE_HINT_POLICY, normalizeObservedCallsign, routeHintUsable, validateRouteHint,
  type NearbyRouteHint, type NearbyRouteHintLease, type NearbyRouteHintStore,
} from "./route-hints";

type Instant = Date | string;
type HintRow = {
  observed_callsign: string; origin_iata: string | null; destination_iata: string | null;
  airline_label: string | null; outcome: NearbyRouteHint["outcome"]; checked_at: Instant;
  expires_at: Instant; source_class: string; verification: NearbyRouteHint["verification"];
};
type LeaseRow = { observed_callsign: string; lease_owner: string; fencing_generation: string | number; claimed_at: Instant; lease_until: Instant };
const milliseconds = (instant: Instant) => instant instanceof Date ? instant.getTime() : Date.parse(instant);
const iso = (instant: Instant) => new Date(milliseconds(instant)).toISOString();
function hint(row: HintRow): NearbyRouteHint {
  const result: NearbyRouteHint = {
    observedCallsign: row.observed_callsign, originIata: row.origin_iata, destinationIata: row.destination_iata,
    airlineLabel: row.airline_label, outcome: row.outcome, checkedAt: iso(row.checked_at), expiresAt: iso(row.expires_at),
    sourceClass: row.source_class, verification: row.verification,
  };
  validateRouteHint(result);
  return result;
}
function callsign(value: string): string {
  const normalized = normalizeObservedCallsign(value);
  if (!normalized || normalized !== value) throw new RangeError("Invalid normalized route callsign");
  return normalized;
}
function validateLease(lease: NearbyRouteHintLease) {
  callsign(lease.observedCallsign);
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(lease.owner)
    || !Number.isSafeInteger(lease.generation) || lease.generation < 1
    || !Number.isFinite(lease.claimedAtMs) || !Number.isFinite(lease.leaseUntilMs)
    || lease.leaseUntilMs <= lease.claimedAtMs) throw new RangeError("Invalid route hint lease");
}

/** Shared private cache. Importing it never migrates or opens a local fallback. */
export function createNearbyRouteHintStore(options: {
  environment: string; sqlProvider?: () => Promise<Sql>; clock?: "database" | "provided";
}): NearbyRouteHintStore {
  if (!/^[a-zA-Z0-9_-]{1,32}$/.test(options.environment)) throw new RangeError("Invalid Nearby route environment");
  const sqlProvider = options.sqlProvider ?? (async () => {
    if (!process.env.DATABASE_URL?.trim()) throw new Error("Nearby route enrichment requires the shared Inbound Postgres database");
    const db = await import("../db");
    if (db.dbSource !== "neon") throw new Error("Nearby route enrichment requires the shared Inbound Postgres database");
    return db.getSql();
  });
  const clockValue = (nowMs: number) => {
    if (!Number.isFinite(nowMs) || !Number.isFinite(new Date(nowMs).getTime())) throw new RangeError("Invalid route hint clock");
    return options.clock === "provided" ? new Date(nowMs) : null;
  };
  const clock = "with clock as (select coalesce($2::timestamptz, clock_timestamp()) as instant)";
  async function complete(lease: NearbyRouteHintLease, value: NearbyRouteHint | null, nowMs: number): Promise<boolean> {
    validateLease(lease);
    const ttl = value ? Date.parse(value.expiresAt) - Date.parse(value.checkedAt) : ROUTE_HINT_POLICY.negativeTtlMs;
    const sql = await sqlProvider();
    const rows = await sql.query(`${clock}
      update inbound_plugin_v1.route_hint h set origin_iata=$6,destination_iata=$7,airline_label=$8,
        outcome=$9,checked_at=clock.instant,expires_at=clock.instant+$12*interval '1 millisecond',
        source_class=$10,verification=$11,lease_owner=null,lease_until=null,
        next_attempt_at=clock.instant+$12*interval '1 millisecond'
      from clock where h.environment=$1 and h.observed_callsign=$3 and h.lease_owner=$4::uuid
        and h.fencing_generation=$5 and h.lease_until>clock.instant
      returning h.observed_callsign`, [options.environment, clockValue(nowMs), lease.observedCallsign, lease.owner, lease.generation,
      value?.originIata ?? null, value?.destinationIata ?? null, value?.airlineLabel ?? null,
      value?.outcome ?? "negative", value?.sourceClass ?? "lookup_failure", value?.verification ?? "unknown", ttl]);
    return rows.length === 1;
  }
  return {
    async read(observedCallsigns, nowMs) {
      if (observedCallsigns.length > ROUTE_HINT_POLICY.enrichmentPool) throw new RangeError("Route hint read exceeds enrichment pool");
      const keys = [...new Set(observedCallsigns.map(callsign))];
      const instant = clockValue(nowMs);
      if (!keys.length) return [];
      const sql = await sqlProvider();
      const rows = await sql.query<HintRow>(`${clock}
        select h.* from inbound_plugin_v1.route_hint h,clock
        where h.environment=$1 and h.observed_callsign=any($3::text[])
          and h.outcome is not null and h.checked_at<=clock.instant+interval '1 second' and h.expires_at>clock.instant
        order by h.observed_callsign`, [options.environment, instant, keys]);
      return rows.map(hint);
    },
    async claim(input) {
      callsign(input.observedCallsign);
      if (!Number.isSafeInteger(input.collectionVersion) || input.collectionVersion < 1) throw new RangeError("Invalid route collection version");
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.owner)) throw new RangeError("Invalid route claim owner");
      const sql = await sqlProvider();
      const rows = await sql.query<LeaseRow>("select * from inbound_plugin_v1.claim_nearby_route_hint($1,$2,$3,$4::uuid,$5::timestamptz)",
        [options.environment, input.observedCallsign, input.collectionVersion, input.owner, clockValue(input.nowMs)]);
      return rows[0] ? { observedCallsign: rows[0].observed_callsign, owner: rows[0].lease_owner,
        generation: Number(rows[0].fencing_generation), claimedAtMs: milliseconds(rows[0].claimed_at), leaseUntilMs: milliseconds(rows[0].lease_until) } : null;
    },
    async publish(lease, value, nowMs) {
      validateRouteHint(value);
      if (value.observedCallsign !== lease.observedCallsign || !routeHintUsable(value, nowMs)) throw new RangeError("Invalid route hint publication");
      return complete(lease, value, nowMs);
    },
    async fail(lease, nowMs) { return complete(lease, null, nowMs); },
    async cleanup(nowMs) {
      const sql = await sqlProvider();
      const rows = await sql.query<{ hints: string | number; budgets: string | number }>(
        "select * from inbound_plugin_v1.cleanup_nearby_route_hints($1,$2::timestamptz)", [options.environment, clockValue(nowMs)]);
      return { hints: Number(rows[0].hints), budgets: Number(rows[0].budgets) };
    },
  };
}

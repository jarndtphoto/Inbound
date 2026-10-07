import type { Sql } from "./db.ts";
import { cleanupFlightStateRows, type FlightStateCleanup } from "./flight-state-retention.server.ts";

export type GroundCachedPosition = {
  lat: number;
  lon: number;
  altFt: number | null;
  gsKt: number | null;
  track: number | null;
  onGround: boolean;
  seenAt: number;
  registration: string | null;
  callsign: string | null;
  provider: "adsb" | "fr24" | "saved";
};

export type GroundState = {
  landKey: string;
  requestedIdent: string;
  serviceDate: string | null;
  originIata: string;
  destIata: string;
  airportIata: string;
  airportLat: number;
  airportLon: number;
  movementKind: "departure" | "arrival";
  hex: string | null;
  registration: string | null;
  callsign: string | null;
  lastPosition: GroundCachedPosition | null;
  positionSeenAt: number | null;
  updatedAt: number;
};

export type GroundStateScope = Pick<GroundState, "landKey" | "serviceDate" | "originIata" | "destIata">;

type Row = {
  land_key: string;
  requested_ident: string;
  service_date: string | null;
  origin_iata: string;
  dest_iata: string;
  airport_iata: string;
  airport_lat: number;
  airport_lon: number;
  movement_kind: "departure" | "arrival";
  hex: string | null;
  registration: string | null;
  callsign: string | null;
  last_position: GroundCachedPosition | null;
  position_seen_at: number | null;
  updated_at_ms: number;
};

function fromRow(row: Row | undefined): GroundState | null {
  if (!row) return null;
  return {
    landKey: row.land_key,
    requestedIdent: row.requested_ident,
    serviceDate: row.service_date,
    originIata: row.origin_iata,
    destIata: row.dest_iata,
    airportIata: row.airport_iata,
    airportLat: row.airport_lat,
    airportLon: row.airport_lon,
    movementKind: row.movement_kind,
    hex: row.hex,
    registration: row.registration,
    callsign: row.callsign,
    lastPosition: row.last_position,
    positionSeenAt: row.position_seen_at,
    updatedAt: row.updated_at_ms,
  };
}

export function createFlightGroundStateStore(
  sqlProvider: () => Promise<Sql>,
  cleanup: FlightStateCleanup = cleanupFlightStateRows,
) {
  async function load(landKey: string): Promise<GroundState | null> {
    if (!landKey) return null;
    try {
      const sql = await sqlProvider();
      const rows = await sql<Row>`select land_key, requested_ident, service_date, origin_iata, dest_iata,
        airport_iata, airport_lat, airport_lon, movement_kind, hex, registration, callsign,
        last_position, position_seen_at, extract(epoch from updated_at) * 1000 as updated_at_ms
        from flight_ground_state where land_key = ${landKey}`;
      return fromRow(rows[0]);
    } catch (error) {
      console.error("[flight-ground-state] load failed", { landKey, error });
      return null;
    }
  }

  async function loadRecent(requestedIdent: string, scope?: GroundStateScope): Promise<GroundState | null> {
    const ident = String(requestedIdent || "").replace(/\s/g, "").toUpperCase();
    if (!ident || !scope?.landKey || !scope.serviceDate || !scope.originIata || !scope.destIata) return null;
    try {
      const sql = await sqlProvider();
      const rows = await sql<Row>`select land_key, requested_ident, service_date, origin_iata, dest_iata,
        airport_iata, airport_lat, airport_lon, movement_kind, hex, registration, callsign,
        last_position, position_seen_at, extract(epoch from updated_at) * 1000 as updated_at_ms
        from flight_ground_state
        where requested_ident = ${ident} and land_key = ${scope.landKey}
          and service_date = ${scope.serviceDate} and origin_iata = ${scope.originIata}
          and dest_iata = ${scope.destIata} and updated_at >= now() - interval '6 hours'
        order by updated_at desc limit 1`;
      return fromRow(rows[0]);
    } catch (error) {
      console.error("[flight-ground-state] recent load failed", { ident, error });
      return null;
    }
  }

  async function save(next: Omit<GroundState, "updatedAt">, requestStartedAt = Date.now()): Promise<void> {
    if (!next.landKey || !next.requestedIdent || !Number.isFinite(requestStartedAt)) return;
    try {
      const sql = await sqlProvider();
      await sql`insert into flight_ground_state (
          land_key, requested_ident, service_date, origin_iata, dest_iata,
          airport_iata, airport_lat, airport_lon, movement_kind, hex, registration, callsign,
          last_position, position_seen_at, updated_at
        ) values (
          ${next.landKey}, ${next.requestedIdent}, ${next.serviceDate},
          ${next.originIata}, ${next.destIata}, ${next.airportIata},
          ${next.airportLat}, ${next.airportLon}, ${next.movementKind},
          ${next.hex}, ${next.registration}, ${next.callsign},
          ${next.lastPosition ? JSON.stringify(next.lastPosition) : null}::jsonb,
          ${next.positionSeenAt}, now()
        )
        on conflict (land_key) do update set
          requested_ident = excluded.requested_ident,
          service_date = coalesce(excluded.service_date, flight_ground_state.service_date),
          origin_iata = excluded.origin_iata,
          dest_iata = excluded.dest_iata,
          airport_iata = excluded.airport_iata,
          airport_lat = excluded.airport_lat,
          airport_lon = excluded.airport_lon,
          movement_kind = excluded.movement_kind,
          hex = case when ((excluded.registration is not null
              and ((flight_ground_state.registration is not null and excluded.registration <> flight_ground_state.registration)
                or (flight_ground_state.registration is null and flight_ground_state.hex is not null)))
            or (excluded.hex is not null and flight_ground_state.hex is not null
              and excluded.hex <> flight_ground_state.hex)) then excluded.hex else coalesce(excluded.hex, flight_ground_state.hex) end,
          registration = case when ((excluded.registration is not null
              and ((flight_ground_state.registration is not null and excluded.registration <> flight_ground_state.registration)
                or (flight_ground_state.registration is null and flight_ground_state.hex is not null)))
            or (excluded.hex is not null and flight_ground_state.hex is not null
              and excluded.hex <> flight_ground_state.hex)) then excluded.registration else coalesce(excluded.registration, flight_ground_state.registration) end,
          callsign = coalesce(excluded.callsign, flight_ground_state.callsign),
          last_position = case
            when excluded.airport_iata is distinct from flight_ground_state.airport_iata
              or excluded.movement_kind is distinct from flight_ground_state.movement_kind
            then excluded.last_position
            when ((excluded.registration is not null
              and ((flight_ground_state.registration is not null and excluded.registration <> flight_ground_state.registration)
                or (flight_ground_state.registration is null and flight_ground_state.hex is not null)))
            or (excluded.hex is not null and flight_ground_state.hex is not null
              and excluded.hex <> flight_ground_state.hex)) then excluded.last_position
            when excluded.position_seen_at is not null
              and (flight_ground_state.position_seen_at is null or excluded.position_seen_at >= flight_ground_state.position_seen_at)
            then excluded.last_position else flight_ground_state.last_position end,
          position_seen_at = case
            when excluded.airport_iata is distinct from flight_ground_state.airport_iata
              or excluded.movement_kind is distinct from flight_ground_state.movement_kind
            then excluded.position_seen_at
            when ((excluded.registration is not null
              and ((flight_ground_state.registration is not null and excluded.registration <> flight_ground_state.registration)
                or (flight_ground_state.registration is null and flight_ground_state.hex is not null)))
            or (excluded.hex is not null and flight_ground_state.hex is not null
              and excluded.hex <> flight_ground_state.hex)) then excluded.position_seen_at
            when excluded.position_seen_at is not null
              and (flight_ground_state.position_seen_at is null or excluded.position_seen_at >= flight_ground_state.position_seen_at)
            then excluded.position_seen_at else flight_ground_state.position_seen_at end,
          updated_at = now()
        where date_trunc('milliseconds', flight_ground_state.updated_at) <= to_timestamp(${requestStartedAt} / 1000.0)
          and not (((excluded.registration is not null
              and ((flight_ground_state.registration is not null and excluded.registration <> flight_ground_state.registration)
                or (flight_ground_state.registration is null and flight_ground_state.hex is not null)))
            or (excluded.hex is not null and flight_ground_state.hex is not null
              and excluded.hex <> flight_ground_state.hex))
            and excluded.position_seen_at is not null and flight_ground_state.position_seen_at is not null
            and excluded.position_seen_at < flight_ground_state.position_seen_at)`;
      await cleanup(sql);
    } catch (error) {
      console.error("[flight-ground-state] save failed", { landKey: next.landKey, error });
    }
  }

  return { load, loadRecent, save };
}

export const flightGroundStateStore = createFlightGroundStateStore(async () => (await import("./db.ts")).getSql());

-- Durable identity + last known surface position for fast ground-map startup.
create table if not exists flight_ground_state (
  land_key text primary key,
  requested_ident text not null,
  service_date text,
  origin_iata text not null,
  dest_iata text not null,
  airport_iata text not null,
  airport_lat double precision not null,
  airport_lon double precision not null,
  movement_kind text not null check (movement_kind in ('departure','arrival')),
  hex text,
  registration text,
  callsign text,
  last_position jsonb,
  position_seen_at double precision,
  updated_at timestamptz not null default now()
);

create index if not exists flight_ground_state_requested_ident_updated_at_idx
  on flight_ground_state (requested_ident, updated_at desc);

create index if not exists flight_ground_state_updated_at_idx
  on flight_ground_state (updated_at);

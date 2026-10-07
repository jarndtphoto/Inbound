-- Part 3B.4 private current-state handoff storage. Apply explicitly after
-- 0006_nearby_collection.sql and 0007_route_hint.sql to an isolated database.
-- This migration is deliberately outside automatic migrations/*.sql.
-- It stores no viewer identity, per-user history, raw provider payloads or
-- append-only aircraft traffic. Public handles are represented only by SHA-256.
create schema if not exists inbound_plugin_v1;

create table if not exists inbound_plugin_v1.occurrence_registry (
  environment text not null check (environment ~ '^[a-zA-Z0-9_-]{1,32}$'),
  flight_instance_id uuid not null,
  occurrence_key_hash bytea not null check (octet_length(occurrence_key_hash) = 32),
  operating_ident text not null check (operating_ident ~ '^[A-Z0-9][A-Z0-9 -]{0,15}$'),
  display_ident text not null check (display_ident ~ '^[A-Z0-9][A-Z0-9 -]{0,15}$'),
  service_date date not null,
  service_time_zone text not null check (length(service_time_zone) between 1 and 64),
  origin_iata text not null check (origin_iata ~ '^[A-Z]{3}$'),
  destination_iata text not null check (destination_iata ~ '^[A-Z]{3}$'),
  scheduled_departure_at timestamptz,
  identity_evidence jsonb not null check (jsonb_typeof(identity_evidence) = 'object'
    and octet_length(identity_evidence::text) <= 4096),
  created_at timestamptz not null,
  last_confirmed_at timestamptz not null,
  retain_until timestamptz not null,
  primary key (environment, flight_instance_id),
  unique (environment, occurrence_key_hash),
  check (last_confirmed_at >= created_at and retain_until > last_confirmed_at
    and retain_until <= last_confirmed_at + interval '14 days')
);

create table if not exists inbound_plugin_v1.selection_handle (
  environment text not null check (environment ~ '^[a-zA-Z0-9_-]{1,32}$'),
  token_hash bytea not null check (octet_length(token_hash) = 32),
  collection_version bigint not null check (collection_version >= 1),
  card_id uuid not null,
  radar_id uuid not null,
  private_aircraft_identity text not null check (length(private_aircraft_identity) between 1 and 128),
  session_key text not null check (length(session_key) between 1 and 128),
  observed_callsign text check (observed_callsign is null or observed_callsign ~ '^[A-Z0-9][A-Z0-9 -]{0,15}$'),
  registration text check (registration is null or registration ~ '^[A-Z0-9][A-Z0-9 -]{0,15}$'),
  observed_at timestamptz not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  route_evidence jsonb not null check (jsonb_typeof(route_evidence) = 'object'
    and octet_length(route_evidence::text) <= 2048),
  dated_binding jsonb check (dated_binding is null or (jsonb_typeof(dated_binding) = 'object'
    and octet_length(dated_binding::text) <= 2048)),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  public_result jsonb check (public_result is null or (jsonb_typeof(public_result) = 'object'
    and octet_length(public_result::text) <= 65536)),
  result_accepted_at timestamptz,
  resolution_error jsonb check (resolution_error is null or (jsonb_typeof(resolution_error) = 'object'
    and octet_length(resolution_error::text) <= 1024)),
  resolution_attempts integer not null default 0 check (resolution_attempts between 0 and 3),
  lease_owner uuid,
  lease_until timestamptz,
  fencing_generation bigint not null default 0 check (fencing_generation >= 0),
  next_attempt_at timestamptz not null,
  failure_backoff_seconds integer not null default 20 check (failure_backoff_seconds in (20, 40, 80, 120)),
  primary key (environment, token_hash),
  check (issued_at >= observed_at and expires_at > issued_at
    and expires_at <= observed_at + interval '120 seconds'),
  check ((lease_owner is null) = (lease_until is null)),
  check ((public_result is null) = (result_accepted_at is null)),
  check (public_result is null or (lease_owner is null and resolution_error is null))
);

create table if not exists inbound_plugin_v1.candidate_choice (
  environment text not null check (environment ~ '^[a-zA-Z0-9_-]{1,32}$'),
  token_hash bytea not null check (octet_length(token_hash) = 32),
  selection_token_hash bytea not null check (octet_length(selection_token_hash) = 32),
  flight_instance_id uuid not null,
  public_candidate jsonb not null check (jsonb_typeof(public_candidate) = 'object'
    and octet_length(public_candidate::text) <= 4096),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (environment, token_hash),
  foreign key (environment, selection_token_hash)
    references inbound_plugin_v1.selection_handle (environment, token_hash) on delete cascade,
  foreign key (environment, flight_instance_id)
    references inbound_plugin_v1.occurrence_registry (environment, flight_instance_id) on delete cascade,
  check (expires_at > issued_at and expires_at <= issued_at + interval '120 seconds')
);

create table if not exists inbound_plugin_v1.detail_snapshot (
  environment text not null check (environment ~ '^[a-zA-Z0-9_-]{1,32}$'),
  flight_instance_id uuid not null,
  contract_version text not null default '1.0' check (contract_version = '1.0'),
  public_flight jsonb check (public_flight is null or (jsonb_typeof(public_flight) = 'object'
    and octet_length(public_flight::text) <= 65536)),
  accepted_at timestamptz,
  next_revalidation_at timestamptz not null,
  detail_error jsonb check (detail_error is null or (jsonb_typeof(detail_error) = 'object'
    and octet_length(detail_error::text) <= 1024)),
  build_attempts integer not null default 0 check (build_attempts between 0 and 3),
  lease_owner uuid,
  lease_until timestamptz,
  fencing_generation bigint not null default 0 check (fencing_generation >= 0),
  failure_backoff_seconds integer not null default 20 check (failure_backoff_seconds in (20, 40, 80, 120)),
  retain_until timestamptz not null,
  primary key (environment, flight_instance_id, contract_version),
  foreign key (environment, flight_instance_id)
    references inbound_plugin_v1.occurrence_registry (environment, flight_instance_id) on delete cascade,
  check ((lease_owner is null) = (lease_until is null)),
  check ((public_flight is null) = (accepted_at is null)),
  -- A last-safe public snapshot deliberately remains available while a
  -- bounded revalidation lease or failure/backoff is in progress.
  check (retain_until > next_revalidation_at)
);

create index if not exists plugin_v1_occurrence_expiry
  on inbound_plugin_v1.occurrence_registry (retain_until);
create index if not exists plugin_v1_selection_expiry
  on inbound_plugin_v1.selection_handle (expires_at, next_attempt_at);
create index if not exists plugin_v1_choice_expiry
  on inbound_plugin_v1.candidate_choice (expires_at);
create index if not exists plugin_v1_detail_expiry
  on inbound_plugin_v1.detail_snapshot (retain_until, next_revalidation_at);

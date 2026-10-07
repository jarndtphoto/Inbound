-- STAGED DESIGN ONLY. Not in migrations/*.sql; no automatic application.
-- Superseded for Part 3B.1 by 0006_nearby_collection.sql in this directory.
-- Do NOT apply this full staged design before or after the actual minimal DDL:
-- current_collection/ranked_view now require different runtime columns. Future
-- stages must add explicit incremental migrations to the actual minimal schema.
-- Existing getSql()/Sql abstraction and Postgres (local tests: PGLite).
-- No historical traffic rows. Each environment/group overwrites one collection.
create schema if not exists inbound_plugin_v1;

create table if not exists inbound_plugin_v1.current_collection (
  environment text not null check (length(environment) between 1 and 32),
  collection_key text not null check (collection_key = 'nearby:telemetry:v1:chicago:50'),
  collection_version bigint not null default 0 check (collection_version >= 0),
  accepted_snapshot_at timestamptz,
  accepted_collection jsonb check (accepted_collection is null or (
    jsonb_typeof(accepted_collection) = 'array' and jsonb_array_length(accepted_collection) <= 1000
    and octet_length(accepted_collection::text) <= 1048576)),
  -- Minimal accepted receipt/freshness metadata; update in place on success.
  last_safe_snapshot_metadata jsonb check (last_safe_snapshot_metadata is null or octet_length(last_safe_snapshot_metadata::text) <= 16384),
  lease_owner uuid, lease_until timestamptz,
  fencing_generation bigint not null default 0 check (fencing_generation >= 0),
  next_attempt_at timestamptz not null,
  failure_backoff_seconds integer not null default 20 check (failure_backoff_seconds in (20, 40, 80, 120)),
  active_until timestamptz not null,
  inactive_expires_at timestamptz not null,
  primary key (environment, collection_key),
  check ((accepted_snapshot_at is null) = (accepted_collection is null)),
  check ((lease_owner is null) = (lease_until is null)),
  check (inactive_expires_at >= active_until)
);

create table if not exists inbound_plugin_v1.ranked_view (
  environment text not null,
  collection_key text not null,
  area_id text not null check (area_id in ('preset:chicago', 'airport:KORD', 'airport:KMDW')),
  radius_nm integer not null check (radius_nm in (12, 25, 38)),
  ranking_version integer not null default 1 check (ranking_version = 1),
  applied_collection_version bigint not null check (applied_collection_version >= 1),
  slots jsonb not null check (jsonb_typeof(slots) = 'array' and jsonb_array_length(slots) <= 5 and octet_length(slots::text) <= 4096),
  inactive_expires_at timestamptz not null,
  primary key (environment, collection_key, area_id, radius_nm, ranking_version),
  foreign key (environment, collection_key) references inbound_plugin_v1.current_collection on delete cascade
);

create table if not exists inbound_plugin_v1.route_hint (
  environment text not null check (length(environment) between 1 and 32),
  observed_callsign text not null check (observed_callsign ~ '^[A-Z0-9][A-Z0-9 -]{0,15}$'),
  hint_version integer not null default 1 check (hint_version = 1),
  origin_iata text check (origin_iata ~ '^[A-Z]{3}$'),
  destination_iata text check (destination_iata ~ '^[A-Z]{3}$'),
  airline_label text check (length(airline_label) <= 64),
  outcome text not null check (outcome in ('positive', 'negative')),
  checked_at timestamptz not null, expires_at timestamptz not null,
  primary key (environment, observed_callsign, hint_version),
  check (expires_at > checked_at),
  check (expires_at <= checked_at + case when outcome = 'positive' then interval '30 minutes' else interval '60 seconds' end),
  check (outcome <> 'positive' or origin_iata is not null or destination_iata is not null)
);

create table if not exists inbound_plugin_v1.card_session (
  environment text not null,
  collection_key text not null,
  card_id uuid not null,
  private_aircraft_identity text not null check (length(private_aircraft_identity) between 1 and 64),
  observed_callsign text check (length(observed_callsign) between 1 and 16),
  observed_registration text check (length(observed_registration) between 1 and 16),
  continuity_start_at timestamptz not null,
  last_observed_at timestamptz not null,
  inactive_expires_at timestamptz not null,
  primary key (environment, card_id),
  -- One CURRENT session per private aircraft/group, replaced at identity/gap change.
  unique (environment, collection_key, private_aircraft_identity),
  foreign key (environment, collection_key) references inbound_plugin_v1.current_collection on delete cascade,
  check (last_observed_at >= continuity_start_at)
);

create table if not exists inbound_plugin_v1.occurrence_registry (
  environment text not null check (length(environment) between 1 and 32),
  flight_instance_id uuid not null,
  operating_ident text not null check (length(operating_ident) between 1 and 16),
  service_date date not null, service_time_zone text not null check (length(service_time_zone) between 1 and 64),
  initial_origin_icao text not null check (initial_origin_icao ~ '^[A-Z0-9]{4}$'),
  initial_destination_icao text not null check (initial_destination_icao ~ '^[A-Z0-9]{4}$'),
  first_published_departure_at timestamptz not null,
  -- Bounded accepted private aliases, never raw provider payload or a story history.
  accepted_aliases jsonb not null default '[]' check (jsonb_typeof(accepted_aliases) = 'array' and jsonb_array_length(accepted_aliases) <= 32 and octet_length(accepted_aliases::text) <= 8192),
  created_at timestamptz not null, expires_at timestamptz not null,
  primary key (environment, flight_instance_id),
  unique (environment, operating_ident, service_date, initial_origin_icao, initial_destination_icao, first_published_departure_at),
  check (expires_at > created_at and expires_at <= created_at + interval '14 days')
);

create table if not exists inbound_plugin_v1.selection_handle (
  environment text not null,
  token_hash bytea not null check (octet_length(token_hash) = 32),
  card_id uuid not null,
  observed_at timestamptz not null, created_at timestamptz not null, expires_at timestamptz not null,
  accepted_context jsonb not null check (octet_length(accepted_context::text) <= 8192),
  flight_instance_id uuid,
  primary key (environment, token_hash),
  foreign key (environment, card_id) references inbound_plugin_v1.card_session on delete cascade,
  foreign key (environment, flight_instance_id) references inbound_plugin_v1.occurrence_registry,
  check (created_at >= observed_at and expires_at > created_at and expires_at <= observed_at + interval '120 seconds')
);

create table if not exists inbound_plugin_v1.candidate_choice (
  environment text not null,
  token_hash bytea not null check (octet_length(token_hash) = 32),
  created_at timestamptz not null, expires_at timestamptz not null,
  originating_observation_expires_at timestamptz,
  bound_context jsonb not null check (octet_length(bound_context::text) <= 16384),
  primary key (environment, token_hash),
  check (expires_at > created_at and expires_at <= created_at + interval '120 seconds'),
  check (originating_observation_expires_at is null or expires_at <= originating_observation_expires_at)
);

create table if not exists inbound_plugin_v1.detail_snapshot (
  environment text not null,
  flight_instance_id uuid not null,
  contract_version text not null default '1.0' check (contract_version = '1.0'),
  accepted_snapshot_at timestamptz,
  public_flight jsonb check (public_flight is null or octet_length(public_flight::text) <= 65536),
  lifecycle text not null check (lifecycle in ('scheduled', 'active', 'completed', 'cancelled', 'unknown')),
  next_revalidation_at timestamptz not null, expires_at timestamptz not null,
  lease_owner uuid, lease_until timestamptz,
  fencing_generation bigint not null default 0 check (fencing_generation >= 0),
  primary key (environment, flight_instance_id, contract_version),
  foreign key (environment, flight_instance_id) references inbound_plugin_v1.occurrence_registry on delete cascade,
  check ((accepted_snapshot_at is null) = (public_flight is null)),
  check ((lease_owner is null) = (lease_until is null))
);

create table if not exists inbound_plugin_v1.lookup_work (
  environment text not null check (length(environment) between 1 and 32),
  -- Hash of Inbound-normalized target/date-policy/route constraints/version.
  target_hash bytea not null check (octet_length(target_hash) = 32),
  public_result jsonb check (public_result is null or octet_length(public_result::text) <= 65536),
  accepted_at timestamptz, expires_at timestamptz not null,
  lease_owner uuid, lease_until timestamptz,
  fencing_generation bigint not null default 0 check (fencing_generation >= 0),
  primary key (environment, target_hash),
  check (accepted_at is null or expires_at <= accepted_at + interval '20 seconds'),
  check ((lease_owner is null) = (lease_until is null))
);

create table if not exists inbound_plugin_v1.construction_budget (
  environment text primary key check (length(environment) between 1 and 32),
  -- One bounded rolling list, overwritten; no append-only construction history.
  recent_started_at jsonb not null default '[]' check (jsonb_typeof(recent_started_at) = 'array' and jsonb_array_length(recent_started_at) <= 30 and octet_length(recent_started_at::text) <= 2048),
  expires_at timestamptz not null
);

-- Logical expiry must be checked on EVERY read, even before cleanup runs.
create index if not exists plugin_v1_collection_expiry on inbound_plugin_v1.current_collection (inactive_expires_at);
create index if not exists plugin_v1_rank_expiry on inbound_plugin_v1.ranked_view (inactive_expires_at);
create index if not exists plugin_v1_hint_expiry on inbound_plugin_v1.route_hint (expires_at);
create index if not exists plugin_v1_card_expiry on inbound_plugin_v1.card_session (inactive_expires_at);
create index if not exists plugin_v1_selection_expiry on inbound_plugin_v1.selection_handle (expires_at);
create index if not exists plugin_v1_choice_expiry on inbound_plugin_v1.candidate_choice (expires_at);
create index if not exists plugin_v1_occurrence_expiry on inbound_plugin_v1.occurrence_registry (expires_at);
create index if not exists plugin_v1_detail_expiry on inbound_plugin_v1.detail_snapshot (expires_at);
create index if not exists plugin_v1_lookup_expiry on inbound_plugin_v1.lookup_work (expires_at);

-- Part 3B must implement atomic claims/publications, fencing, logical TTLs,
-- shared-token reuse/cleanup, request limits and scoped access. This DDL alone
-- does not guarantee distributed acquisition/cost/identity correctness.

-- Part 3B.1 private current-state storage only. Deliberately outside automatic
-- migrations/*.sql; apply explicitly to an isolated database before integration.
-- No aviation history, per-user rows, lookup/handoff tables or production edits.
create schema if not exists inbound_plugin_v1;

create table if not exists inbound_plugin_v1.current_collection (
  environment text not null check (length(environment) between 1 and 32),
  collection_key text not null check (collection_key = 'nearby:telemetry:v1:chicago:50'),
  collection_version bigint not null default 0 check (collection_version >= 0),
  accepted_snapshot_at timestamptz,
  accepted_collection jsonb check (accepted_collection is null or (
    jsonb_typeof(accepted_collection) = 'array'
    and jsonb_array_length(accepted_collection) <= 1000
    and octet_length(accepted_collection::text) <= 1048576)),
  last_safe_snapshot_metadata jsonb check (last_safe_snapshot_metadata is null or (
    jsonb_typeof(last_safe_snapshot_metadata) = 'object'
    and octet_length(last_safe_snapshot_metadata::text) <= 16384)),
  last_attempt_failed boolean not null default false,
  lease_owner uuid,
  lease_until timestamptz,
  fencing_generation bigint not null default 0 check (fencing_generation >= 0),
  next_attempt_at timestamptz not null,
  -- The next failure's delay: use 20 first, then advance to 40/80/120.
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
  -- CAS revision prevents two servers applying different incumbent decisions.
  revision bigint not null default 1 check (revision >= 1),
  slots jsonb not null check (jsonb_typeof(slots) = 'array'
    and jsonb_array_length(slots) <= 5 and octet_length(slots::text) <= 4096),
  inactive_expires_at timestamptz not null,
  primary key (environment, collection_key, area_id, radius_nm, ranking_version),
  foreign key (environment, collection_key) references inbound_plugin_v1.current_collection on delete cascade
);

-- Expiry is enforced on every read before physical cleanup.
create index if not exists plugin_v1_collection_expiry on inbound_plugin_v1.current_collection (inactive_expires_at);
create index if not exists plugin_v1_rank_expiry on inbound_plugin_v1.ranked_view (inactive_expires_at);

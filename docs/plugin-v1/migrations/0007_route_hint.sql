-- Part 3B.2 private mutable route hints. Apply after 0006 only to an explicitly
-- chosen isolated database; this file is outside automatic application DDL.
-- No aircraft identity, viewer key, raw provider payload or route history.
create schema if not exists inbound_plugin_v1;

create table if not exists inbound_plugin_v1.route_hint (
  environment text not null check (environment ~ '^[a-zA-Z0-9_-]{1,32}$'),
  observed_callsign text not null check (observed_callsign ~ '^[A-Z0-9][A-Z0-9-]{0,15}$'),
  origin_iata text check (origin_iata is null or origin_iata ~ '^[A-Z]{3}$'),
  destination_iata text check (destination_iata is null or destination_iata ~ '^[A-Z]{3}$'),
  airline_label text check (airline_label is null or (length(airline_label) between 1 and 64
    and airline_label = btrim(airline_label) and length(btrim(airline_label)) > 0 and airline_label !~ '[[:cntrl:]<>]' and airline_label !~* 'https?:|www\.')),
  outcome text check (outcome in ('positive', 'negative')),
  checked_at timestamptz,
  expires_at timestamptz,
  source_class text check (source_class is null or source_class ~ '^[a-zA-Z0-9_-]{1,32}$'),
  verification text check (verification in ('hint', 'unknown')),
  lease_owner uuid,
  lease_until timestamptz,
  fencing_generation bigint not null default 0 check (fencing_generation >= 0),
  next_attempt_at timestamptz not null,
  primary key (environment, observed_callsign),
  check ((lease_owner is null) = (lease_until is null)),
  check ((outcome is null and origin_iata is null and destination_iata is null and airline_label is null
      and checked_at is null and expires_at is null and source_class is null and verification is null and lease_owner is not null)
    or (outcome is not null and checked_at is not null and expires_at is not null and source_class is not null
      and verification is not null and expires_at > checked_at and lease_owner is null
      and ((outcome = 'positive' and verification = 'hint' and (origin_iata is not null or destination_iata is not null)
          and expires_at <= checked_at + interval '30 minutes')
        or (outcome = 'negative' and verification = 'unknown' and origin_iata is null and destination_iata is null
          and airline_label is null and expires_at <= checked_at + interval '60 seconds'))))
);

-- One mutable shared budget row. It deliberately has no FK to the collection:
-- deleting/recreating telemetry must not erase the preceding minute's starts.
create table if not exists inbound_plugin_v1.route_construction_budget (
  environment text not null check (environment ~ '^[a-zA-Z0-9_-]{1,32}$'),
  collection_key text not null check (collection_key = 'nearby:telemetry:v1:chicago:50'),
  collection_version bigint not null check (collection_version >= 1),
  collection_snapshot_at timestamptz not null,
  cycle_lookups integer not null default 0 check (cycle_lookups between 0 and 2),
  recent_starts timestamptz[] not null default '{}'
    check (cardinality(recent_starts) <= 6 and array_position(recent_starts, null) is null),
  retain_until timestamptz not null,
  primary key (environment, collection_key)
);
create index if not exists plugin_v1_route_hint_expiry on inbound_plugin_v1.route_hint (expires_at, next_attempt_at);
create index if not exists plugin_v1_route_budget_expiry on inbound_plugin_v1.route_construction_budget (retain_until);

-- A single invocation is a transaction on every Sql driver, including pooled
-- serverless connections. Budget and callsign locks serialize claims; losers
-- and cache hits consume zero quota. Supplied time is for explicit test opt-in.
create or replace function inbound_plugin_v1.claim_nearby_route_hint(
  p_environment text, p_callsign text, p_collection_version bigint, p_owner uuid,
  p_test_clock timestamptz default null
) returns table (observed_callsign text, lease_owner uuid, fencing_generation bigint, claimed_at timestamptz, lease_until timestamptz)
language plpgsql as $$
declare
  v_now timestamptz := coalesce(p_test_clock, clock_timestamp());
  v_collection inbound_plugin_v1.current_collection%rowtype;
  v_budget inbound_plugin_v1.route_construction_budget%rowtype;
  v_hint inbound_plugin_v1.route_hint%rowtype;
  v_recent timestamptz[];
  v_cycle integer;
begin
  if p_environment is null or p_environment !~ '^[a-zA-Z0-9_-]{1,32}$'
      or p_callsign is null or p_callsign !~ '^[A-Z0-9][A-Z0-9-]{0,15}$'
      or p_collection_version is null or p_collection_version < 1 or p_owner is null then
    raise exception 'Invalid Nearby route claim';
  end if;
  select c.* into v_collection from inbound_plugin_v1.current_collection c
    where c.environment = p_environment and c.collection_key = 'nearby:telemetry:v1:chicago:50'
      and c.collection_version = p_collection_version and not c.last_attempt_failed
      and c.active_until > v_now and c.inactive_expires_at > v_now
      and c.accepted_snapshot_at >= v_now - interval '45 seconds' and c.accepted_snapshot_at <= v_now + interval '1 second'
    for share of c;
  if not found then return; end if;
  insert into inbound_plugin_v1.route_construction_budget as b
    (environment, collection_key, collection_version, collection_snapshot_at, retain_until)
    values (p_environment, v_collection.collection_key, p_collection_version, v_collection.accepted_snapshot_at, v_collection.inactive_expires_at)
    on conflict (environment, collection_key) do nothing;
  select b.* into v_budget from inbound_plugin_v1.route_construction_budget b
    where b.environment = p_environment and b.collection_key = v_collection.collection_key for update;
  -- A queued connection must not claim using its pre-lock wall clock.
  -- The collection share lock keeps these selected fields current while we wait.
  v_now := coalesce(p_test_clock, clock_timestamp());
  if v_collection.active_until <= v_now or v_collection.inactive_expires_at <= v_now
      or v_collection.accepted_snapshot_at < v_now - interval '45 seconds'
      or v_collection.accepted_snapshot_at > v_now + interval '1 second' then return; end if;
  select h.* into v_hint from inbound_plugin_v1.route_hint h
    where h.environment = p_environment and h.observed_callsign = p_callsign for update;
  -- A callsign writer can also delay the row lock; use the post-wait clock for
  -- cache expiry, rolling quota, retry cooldown and the returned lease.
  v_now := coalesce(p_test_clock, clock_timestamp());
  if v_collection.active_until <= v_now or v_collection.inactive_expires_at <= v_now
      or v_collection.accepted_snapshot_at < v_now - interval '45 seconds'
      or v_collection.accepted_snapshot_at > v_now + interval '1 second' then return; end if;
  if v_hint.observed_callsign is not null and ((v_hint.expires_at is not null and v_hint.expires_at > v_now)
      or v_hint.next_attempt_at > v_now or v_hint.lease_until > v_now) then return; end if;
  select coalesce(array_agg(t.started order by t.started), '{}') into v_recent
    from unnest(v_budget.recent_starts) as t(started) where t.started > v_now - interval '60 seconds';
  v_cycle := case when v_budget.collection_version = p_collection_version and v_budget.collection_snapshot_at = v_collection.accepted_snapshot_at then v_budget.cycle_lookups else 0 end;
  if v_cycle >= 2 or cardinality(v_recent) >= 6 then return; end if;
  -- Expired rows are removed opportunistically, bounding storage even if a
  -- separate cleanup task is delayed. Pending work retains its 60-second retry.
  delete from inbound_plugin_v1.route_hint h where h.environment = p_environment
    and h.observed_callsign <> p_callsign and (h.expires_at is null or h.expires_at <= v_now)
    and h.next_attempt_at <= v_now and (h.lease_until is null or h.lease_until <= v_now);
  -- The rolling limit and TTL already bound occupancy. This additional hard
  -- bound is deliberately above 6 starts/minute over the 30-minute lifetime.
  if not exists (select 1 from inbound_plugin_v1.route_hint h where h.environment = p_environment and h.observed_callsign = p_callsign)
      and (select count(*) from inbound_plugin_v1.route_hint h where h.environment = p_environment) >= 192 then return; end if;
  insert into inbound_plugin_v1.route_hint as h
    (environment, observed_callsign, lease_owner, lease_until, fencing_generation, next_attempt_at)
    values (p_environment, p_callsign, p_owner, v_now + interval '10 seconds', 1, v_now + interval '60 seconds')
    on conflict on constraint route_hint_pkey do update set
      origin_iata = null, destination_iata = null, airline_label = null, outcome = null,
      checked_at = null, expires_at = null, source_class = null, verification = null,
      lease_owner = excluded.lease_owner, lease_until = excluded.lease_until,
      fencing_generation = h.fencing_generation + 1, next_attempt_at = excluded.next_attempt_at
    returning h.* into v_hint;
  update inbound_plugin_v1.route_construction_budget b set
    collection_version = p_collection_version, collection_snapshot_at = v_collection.accepted_snapshot_at, cycle_lookups = v_cycle + 1,
    recent_starts = array_append(v_recent, v_now),
    retain_until = greatest(b.retain_until, v_collection.inactive_expires_at, v_now + interval '60 seconds')
    where b.environment = p_environment and b.collection_key = v_collection.collection_key;
  return query select v_hint.observed_callsign, v_hint.lease_owner, v_hint.fencing_generation, v_now, v_hint.lease_until;
end;
$$;

-- Match claim's budget-before-hint order. A single helper avoids row-lock
-- inversion between independently pooled cleanup/claim connections. Reads of
-- the collection below do not acquire a collection row lock.
create or replace function inbound_plugin_v1.cleanup_nearby_route_hints(
  p_environment text, p_test_clock timestamptz default null
) returns table (hints bigint, budgets bigint)
language plpgsql as $$
declare
  v_now timestamptz := coalesce(p_test_clock, clock_timestamp());
  v_hints bigint;
  v_budgets bigint;
begin
  if p_environment is null or p_environment !~ '^[a-zA-Z0-9_-]{1,32}$' then
    raise exception 'Invalid Nearby route cleanup';
  end if;
  perform 1 from inbound_plugin_v1.route_construction_budget b
    where b.environment = p_environment and b.collection_key = 'nearby:telemetry:v1:chicago:50' for update;
  delete from inbound_plugin_v1.route_hint h where h.environment = p_environment
    and (h.expires_at is null or h.expires_at <= v_now) and h.next_attempt_at <= v_now
    and (h.lease_until is null or h.lease_until <= v_now);
  get diagnostics v_hints = row_count;
  delete from inbound_plugin_v1.route_construction_budget b
    where b.environment = p_environment and b.collection_key = 'nearby:telemetry:v1:chicago:50'
      and b.retain_until <= v_now
      and not exists (select 1 from unnest(b.recent_starts) as t(started) where t.started > v_now - interval '60 seconds')
      and not exists (select 1 from inbound_plugin_v1.current_collection c where c.environment = b.environment
        and c.collection_key = b.collection_key and c.inactive_expires_at > v_now);
  get diagnostics v_budgets = row_count;
  return query select v_hints, v_budgets;
end;
$$;

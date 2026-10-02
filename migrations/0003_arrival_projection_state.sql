-- Arrival display state is independent of flight_phase_state and its version.
-- Never changes departure/arrival stage classification.
create table if not exists arrival_projection_state (
  land_key text primary key,
  state jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);
create index if not exists arrival_projection_updated on arrival_projection_state (updated_at);

-- Last successful bulletin only: a failed fetch must not replace good ATIS.
create table if not exists arrival_atis_cache (
  airport text primary key,
  entries jsonb not null,
  fetched_at bigint not null
);

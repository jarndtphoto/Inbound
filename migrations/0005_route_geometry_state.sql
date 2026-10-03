-- Public, per-dated-leg route continuity across provider and serverless gaps.
create table if not exists flight_route_state (
  land_key text primary key,
  state jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

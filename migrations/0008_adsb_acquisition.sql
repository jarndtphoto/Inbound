-- Free ADS-B acquisition only. Never stores FR24 data or authorizes paid calls.
create table if not exists adsb_provider_gate (
  provider text primary key,
  cooldown_until bigint not null default 0,
  failures integer not null default 0,
  last_failure_at bigint not null default 0,
  admitted_at bigint not null default 0,
  window_at bigint not null default 0,
  window_calls integer not null default 0
);
create table if not exists adsb_shared_cache (
  cache_key text primary key,
  provider text not null,
  payload jsonb,
  received_at bigint,
  fresh_until bigint not null default 0,
  retain_until bigint not null default 0,
  refresh_token text,
  refresh_expires_at bigint not null default 0
);
create index if not exists adsb_shared_cache_expiry_idx on adsb_shared_cache(retain_until);

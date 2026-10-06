-- Shared Flightradar24 spend guard and response cache.
--
-- All paid FR24 requests reserve their worst-case credits here before the
-- network call. The conditional upsert is the cross-instance atomic gate;
-- serverless process memory is never used to decide whether a call is allowed.
create table if not exists fr24_daily_usage (
  usage_day date primary key,
  calls integer not null default 0 check (calls >= 0),
  credits integer not null default 0 check (credits >= 0),
  reserved_credits integer not null default 0 check (reserved_credits >= 0),
  credit_cap integer not null check (credit_cap > 0),
  updated_at timestamptz not null default now()
);

-- One row per actual upstream request. Cache hits and budget-blocked attempts
-- are not FR24 calls and therefore do not appear here.
create table if not exists fr24_call_log (
  id bigserial primary key,
  called_at timestamptz not null default now(),
  usage_day date not null,
  deployment text not null,
  environment text not null,
  ident text not null,
  endpoint text not null,
  credits integer not null check (credits >= 0),
  status_code integer,
  result_count integer,
  error_kind text
);
create index if not exists fr24_call_log_called_at_idx on fr24_call_log (called_at);
create index if not exists fr24_call_log_usage_day_idx on fr24_call_log (usage_day, deployment, endpoint, ident);

-- A short lease prevents two cold instances from filling the same cache key
-- concurrently. The response itself is shared for at least twenty seconds.
create table if not exists fr24_shared_cache (
  cache_key text primary key,
  endpoint text not null,
  ident text not null,
  payload jsonb,
  fetched_at bigint,
  refresh_token text,
  refresh_expires_at bigint,
  updated_at timestamptz not null default now()
);
create index if not exists fr24_shared_cache_updated_at_idx on fr24_shared_cache (updated_at);

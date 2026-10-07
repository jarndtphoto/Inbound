-- A Preview allowance is one explicitly configured session, never a daily or
-- per-deployment allowance. Reservation permanently consumes worst-case credits
-- and an attempt before any upstream request. There are deliberately no refunds.
create table if not exists fr24_preview_sessions (
  session_id text primary key,
  credit_cap integer not null check (credit_cap >= 8),
  attempt_cap integer not null check (attempt_cap > 0),
  expires_at bigint not null check (expires_at > 0),
  credits_consumed integer not null default 0 check (credits_consumed >= 0 and credits_consumed <= credit_cap),
  attempts integer not null default 0 check (attempts >= 0 and attempts <= attempt_cap),
  stopped_402 boolean not null default false,
  active_reservation_id text,
  last_status_code integer check (last_status_code between 100 and 599),
  last_error_kind text,
  last_finished_at bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (attempt_cap <= credit_cap / 8)
);

-- A durable receipt makes finish idempotent. No token, full request URL,
-- provider payload, or arbitrary error message is stored in this ledger.
create table if not exists fr24_preview_reservations (
  reservation_id text primary key,
  session_id text not null references fr24_preview_sessions(session_id),
  maximum_credits integer not null check (maximum_credits > 0),
  reserved_at bigint not null,
  dispatched_at bigint,
  finished_at bigint,
  status_code integer check (status_code between 100 and 599),
  error_kind text
);
create index if not exists fr24_preview_reservations_session_idx
  on fr24_preview_reservations(session_id, reserved_at);

-- Even a future accidental upsert must not renew an existing session or
-- replenish its counters. A new allowance requires a distinct session ID.
create or replace function protect_fr24_preview_session() returns trigger as $$
begin
  if new.session_id is distinct from old.session_id
    or new.credit_cap is distinct from old.credit_cap
    or new.attempt_cap is distinct from old.attempt_cap
    or new.expires_at is distinct from old.expires_at
    or new.credits_consumed < old.credits_consumed
    or new.attempts < old.attempts
    or (old.stopped_402 and not new.stopped_402)
  then
    raise exception 'FR24 Preview sessions cannot be renewed or replenished';
  end if;
  return new;
end;
$$ language plpgsql;
drop trigger if exists fr24_preview_session_immutable on fr24_preview_sessions;
create trigger fr24_preview_session_immutable before update on fr24_preview_sessions
  for each row execute function protect_fr24_preview_session();

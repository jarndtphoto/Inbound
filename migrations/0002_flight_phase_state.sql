-- Durable per-flight-instance ground-phase state.
--
-- Replaces the in-memory pushLatch / taxiOutLatch Maps that used to live at
-- module scope in src/lib/story.server.ts. Those Maps lived in serverless
-- function process memory, which Vercel does not keep durable or shared
-- across cold starts or across the multiple concurrent instances that serve
-- traffic under load -- so "have we already observed this flight push back /
-- start taxiing" could be silently forgotten depending on which instance
-- happened to answer a given poll. This table is the single durable source
-- of truth instead, keyed by the same land_key (flightInstanceKey()) that
-- story.server.ts already computes per flight instance.
--
-- Rows are small and short-lived in practice (one flight's departure ground
-- ops, at most a few hours); nothing here auto-deletes old rows yet -- see
-- the updated_at index, intended for a future periodic cleanup job.

-- version is an optimistic-concurrency guard, not a display field: two
-- near-simultaneous polls for the same flight (two instances, two tabs) can
-- both load the same row, compute independently, and race to write it back.
-- Without a guard the slower write can silently overwrite a newer, more
-- advanced observation with a stale one. Every write is a conditional
-- UPDATE ... WHERE version = <the version this write read> (see
-- savePhaseState in flight-phase-state.server.ts); a write that loses the
-- race affects zero rows instead of clobbering the winner.
create table if not exists flight_phase_state (
  land_key text primary key,
  push_unix double precision,
  push_source text,
  push_live boolean,
  push_at double precision,
  taxi_out_at double precision,
  version integer not null default 1,
  updated_at timestamptz not null default now()
);

create index if not exists flight_phase_state_updated_at_idx
  on flight_phase_state (updated_at);

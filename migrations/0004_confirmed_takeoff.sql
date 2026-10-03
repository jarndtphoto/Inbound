-- Durable departure confirmation for the selected dated leg. An observed
-- airborne fix confirms the phase, but never invents an actual takeoff time.
alter table flight_phase_state add column if not exists confirmed_takeoff jsonb;

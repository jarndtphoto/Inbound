-- Monotonic evidence that a tail's earlier trace segment belongs to another
-- departure. Null preserves pre-boundary rows; provider actuals stay valid.
alter table flight_phase_state add column if not exists push_not_before_unix double precision;

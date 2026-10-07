-- Hold a free-provider slot through HTTP completion, then leave a safety gap.
-- Existing fixed-window columns remain for compatibility; new code ignores them.
alter table adsb_provider_gate add column if not exists dispatch_token text;
alter table adsb_provider_gate add column if not exists dispatch_expires_at bigint not null default 0;
alter table adsb_provider_gate add column if not exists next_dispatch_at bigint not null default 0;
alter table adsb_provider_gate add column if not exists rate_limit_failures integer not null default 0;
alter table adsb_provider_gate add column if not exists last_rate_limit_at bigint not null default 0;
-- Old rows did not distinguish 429 from other failures; preserve conservatively.
update adsb_provider_gate set rate_limit_failures=greatest(rate_limit_failures, least(failures, 3)),
  last_rate_limit_at=greatest(last_rate_limit_at, last_failure_at);
update adsb_provider_gate set next_dispatch_at = greatest(next_dispatch_at, admitted_at + 1250);

-- Access denial is service-specific: a trace host403 must not block the live
-- API. Legacy rows did not store status, so preserve trace cooldowns on their
-- original service rather than promoting an unknown denial to the whole family.
create table if not exists adsb_source_access (
  provider text primary key,
  denied_until bigint not null default 0
);
insert into adsb_source_access(provider, denied_until)
select provider, cooldown_until from adsb_provider_gate where provider in ('trace-fi', 'trace-al', 'trace-airtraffic')
on conflict(provider) do update set denied_until=greatest(adsb_source_access.denied_until, excluded.denied_until);

-- Preserve known recent dispatch spacing across the newly grouped host family,
-- without copying service-specific or unclassified legacy denials to live APIs.
insert into adsb_provider_gate(provider, admitted_at, next_dispatch_at)
select case provider when 'trace-fi' then 'fi' when 'trace-al' then 'al' end,
  admitted_at, next_dispatch_at from adsb_provider_gate where provider in ('trace-fi', 'trace-al')
on conflict(provider) do update set
  admitted_at=greatest(adsb_provider_gate.admitted_at, excluded.admitted_at),
  next_dispatch_at=greatest(adsb_provider_gate.next_dispatch_at, excluded.next_dispatch_at);

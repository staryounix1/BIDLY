-- 0003_dispute_events.sql
-- The dispute module records a timeline of events (opened / message / escalated /
-- withdrawn / resolved). The original schema modelled static state on `disputes`
-- plus an evidence table, but the API was written against a `dispute_events`
-- timeline table that was never created, so every dispute endpoint failed at
-- runtime. This migration adds the missing table.

create table if not exists dispute_events (
  id             uuid primary key default gen_random_uuid(),
  dispute_id     uuid not null references disputes(id) on delete cascade,
  actor_id       uuid references users(id) on delete set null,
  type           text not null,
  note           text,
  attachment_url text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_dispute_events_dispute on dispute_events(dispute_id, created_at);

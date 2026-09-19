-- =====================================================================
-- BIDLY — 0002_part2_data_models.sql
--
-- Additive migration for the PART 2 data-model layer.
--
-- Scope: this file only closes gaps found after auditing 0001_init.sql
-- against the Part 2 requirements. Everything that already satisfied a
-- requirement was deliberately left untouched — no table or enum is
-- redefined, renamed, or dropped.
--
-- Gaps closed here:
--   1. reviews lacked per-category sub-ratings (punctuality, quality,
--      communication, value) that the API layer already expects.
--   2. there was no generic attachment store; media was modelled only
--      for requests, leaving chat / completion evidence / disputes /
--      verification with ad-hoc URL columns.
--   3. requests stored a precise pickup point with no way to publish an
--      intentionally blurred location before a provider is selected.
--   4. no explicit guard prevented a review being written before the
--      job reached a completed state.
--
-- Conventions match 0001_init.sql:
--   * money      : bigint minor units + char(3) currency  (never float)
--   * time       : timestamptz (UTC)
--   * ids        : uuid, gen_random_uuid() default
--   * soft delete: deleted_at on user-visible domain rows
--   * append-only: rows that must never be rewritten
--
-- Idempotent / re-runnable.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Review category ratings
--
-- The product asks the customer to rate a provider on several axes in
-- addition to the overall score. These are nullable so an older or
-- simple review (overall rating only) remains valid, and each is
-- constrained to the same 1–5 scale as `rating` itself.
-- ---------------------------------------------------------------------
alter table reviews
  add column if not exists rating_punctuality   smallint
    check (rating_punctuality is null or rating_punctuality between 1 and 5),
  add column if not exists rating_quality       smallint
    check (rating_quality is null or rating_quality between 1 and 5),
  add column if not exists rating_communication smallint
    check (rating_communication is null or rating_communication between 1 and 5),
  add column if not exists rating_value         smallint
    check (rating_value is null or rating_value between 1 and 5);

comment on column reviews.rating_punctuality is
  'Optional 1-5 sub-rating: did the provider arrive / deliver on time.';
comment on column reviews.rating_quality is
  'Optional 1-5 sub-rating: quality of the completed work.';
comment on column reviews.rating_communication is
  'Optional 1-5 sub-rating: clarity and responsiveness of communication.';
comment on column reviews.rating_value is
  'Optional 1-5 sub-rating: value for money.';


-- ---------------------------------------------------------------------
-- 2. Review eligibility guard
--
-- A review must only exist for a job that has actually been completed.
-- The unique index from 0001 already prevents a duplicate review per
-- job per direction; this trigger additionally prevents writing a
-- review too early. It is enforced in the database so no application
-- path can bypass it.
-- ---------------------------------------------------------------------
create or replace function enforce_review_eligibility() returns trigger
language plpgsql as $$
declare
  v_status bidly_job_status;
begin
  select status into v_status from jobs where id = new.job_id;

  if v_status is null then
    raise exception 'Cannot review a job that does not exist (job_id=%)', new.job_id
      using errcode = 'foreign_key_violation';
  end if;

  if v_status not in ('COMPLETED', 'PAYMENT_PENDING', 'PAID', 'DISPUTED', 'REFUNDED') then
    raise exception
      'Cannot review job % in status %; the job must be completed first',
      new.job_id, v_status
      using errcode = 'check_violation';
  end if;

  return new;
end $$;

drop trigger if exists trg_reviews_eligibility on reviews;
create trigger trg_reviews_eligibility
  before insert on reviews
  for each row execute function enforce_review_eligibility();


-- ---------------------------------------------------------------------
-- 3. Generic attachments
--
-- One table for every uploaded file, regardless of what it belongs to.
-- The owner is expressed as (owner_type, owner_id) rather than four
-- separate nullable foreign keys, which keeps the store generic and
-- avoids a widening set of columns as new features arrive.
--
-- No binary content is stored here: only metadata plus a storage key
-- that resolves to a private bucket via signed URLs.
-- ---------------------------------------------------------------------
do $$ begin
  create type bidly_attachment_owner as enum (
    'REQUEST', 'MESSAGE', 'JOB_COMPLETION', 'DISPUTE', 'VERIFICATION',
    'SUPPORT_TICKET', 'REVIEW', 'PROVIDER_PROFILE', 'USER_PROFILE'
  );
exception when duplicate_object then null; end $$;

create table if not exists attachments (
  id             uuid primary key default gen_random_uuid(),
  owner_type     bidly_attachment_owner not null,
  owner_id       uuid not null,
  uploader_id    uuid references users(id) on delete set null,
  kind           bidly_media_kind not null default 'IMAGE',

  storage_bucket text,
  storage_key    text not null,
  url            text,
  mime_type      text,
  size_bytes     bigint check (size_bytes is null or size_bytes >= 0),
  width          int check (width is null or width > 0),
  height         int check (height is null or height > 0),
  duration_sec   int check (duration_sec is null or duration_sec >= 0),
  checksum       text,

  is_public      boolean not null default false,
  sort_order     int not null default 0,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Look up everything attached to one owner (a request, a message, ...).
create index if not exists idx_attachments_owner
  on attachments(owner_type, owner_id)
  where deleted_at is null;

create index if not exists idx_attachments_uploader
  on attachments(uploader_id, created_at desc)
  where deleted_at is null;

-- Used by retention jobs that sweep unreferenced objects.
create index if not exists idx_attachments_key on attachments(storage_key);

select attach_updated_at('attachments');

comment on table attachments is
  'Generic metadata store for uploaded files. No binary content: storage_key resolves to a private bucket.';
comment on column attachments.owner_type is
  'What the file belongs to. Paired with owner_id; no database-level FK because the target table varies.';


-- ---------------------------------------------------------------------
-- 4. Request location privacy
--
-- Before a provider is selected the customer's exact position must not
-- be exposed. `requests.approx_lat/lng` hold a deliberately coarsened
-- point (rounded / jittered by the application) that is safe to show in
-- the open request feed, while the precise `pickup_lat/lng` from 0001
-- remain the source of truth and are only revealed once a provider is
-- chosen.
--
-- `location_precision` makes the current exposure level explicit so a
-- client cannot accidentally read the precise columns early.
-- ---------------------------------------------------------------------
do $$ begin
  create type bidly_location_precision as enum ('APPROXIMATE', 'EXACT');
exception when duplicate_object then null; end $$;

alter table requests
  add column if not exists approx_lat double precision
    check (approx_lat is null or (approx_lat between -90 and 90)),
  add column if not exists approx_lng double precision
    check (approx_lng is null or (approx_lng between -180 and 180)),
  add column if not exists approx_geohash text,
  add column if not exists location_precision bidly_location_precision
    not null default 'APPROXIMATE';

-- A precise point must never be marked APPROXIMATE silently, and an
-- exact-precision request must actually carry coordinates.
alter table requests
  drop constraint if exists requests_exact_location_present;
alter table requests
  add constraint requests_exact_location_present check (
    location_precision <> 'EXACT'
    or (pickup_lat is not null and pickup_lng is not null)
  );

create index if not exists idx_requests_approx_geohash
  on requests(approx_geohash)
  where deleted_at is null and approx_geohash is not null;

comment on column requests.approx_lat is
  'Coarsened latitude safe to publish before a provider is selected.';
comment on column requests.location_precision is
  'APPROXIMATE until a provider is selected; EXACT afterwards. Never read pickup_lat/lng while APPROXIMATE.';


-- ---------------------------------------------------------------------
-- 5. Seed the location-precision setting
--
-- The rounding granularity is configurable rather than hard-coded so a
-- denser market can choose a different precision. The value is the
-- number of decimal places retained for the approximate point.
-- ---------------------------------------------------------------------
insert into settings (key, value, description, is_public)
values (
  'geo.approx_decimals',
  '2'::jsonb,
  'Decimal places retained when coarsening a request location for the open feed (2 ≈ 1.1 km).',
  false
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 6. Fix request auto-advance on the first offer
--
-- `trg_offers_count` used to promote a request straight from PUBLISHED to
-- RECEIVING_OFFERS, but the documented request state machine (docs/05,
-- docs/12, packages/state-machines) requires PUBLISHED -> MATCHING ->
-- RECEIVING_OFFERS. The old code therefore raised
-- 'Illegal request transition PUBLISHED -> RECEIVING_OFFERS' as soon as
-- an offer arrived on a request that had been published but not matched,
-- and disagreed with the state machine the application enforces.
--
-- Recreate the trigger so it only advances a request that is already in
-- MATCHING. A PUBLISHED request keeps its status: offers may only exist
-- for a request that has entered the matching pipeline.
-- ---------------------------------------------------------------------
create or replace function trg_offers_count() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.status <> 'WITHDRAWN' then
    update requests set offer_count = offer_count + 1,
      status = case when status = 'MATCHING' then 'RECEIVING_OFFERS'::bidly_request_status else status end,
      matched_at = coalesce(matched_at, now())
      where id = new.request_id;
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    if old.status <> 'WITHDRAWN' and new.status = 'WITHDRAWN' then
      update requests set offer_count = greatest(offer_count - 1, 0) where id = new.request_id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_offers_count on offers;
create trigger trg_offers_count after insert or update of status on offers
  for each row execute function trg_offers_count();


-- Record the migration.
insert into schema_migrations (version, name, checksum)
values ('0002', 'part2_data_models', 'bidly-part2-v1')
on conflict (version) do nothing;

commit;

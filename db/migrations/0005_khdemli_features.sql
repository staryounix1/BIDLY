-- =====================================================================
-- 0005 — Khdemli engagement features
--
-- Adds, in one forward-only migration:
--   * tiered commission schedule + per-job commission ledger
--   * wallet top-up packages and top-up intents
--   * negotiation confirmation (the "تم التفاوض" step that debits commission)
--   * provider specialty (one trade, or up to three general services)
--   * SOS / urgent requests
--   * scheduled bookings with a reminder timestamp
--   * before/after job photos
--   * post-completion complaints (7-day guarantee)
--   * paid Boost placement
--   * Premium subscription flag
--   * referral codes and rewards
--   * two-way ratings and the RATED terminal state
--   * temporary location-sharing links
--   * analytics support (peak times, admin heatmap)
--
-- Everything is additive: no existing column is dropped or retyped, so the
-- running API keeps working against the new schema while it is rolled out.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Commission schedule + negotiation
-- ---------------------------------------------------------------------

-- The schedule lives in `settings` so an admin can retune the bands without a
-- deploy. Shape: { tiers: [{ upToMinor, bps }], sosExtraBps, premiumBps,
-- firstJobFree }.
insert into settings (key, value, value_type, group_name, label, description, is_public, is_editable)
values (
  'commission.tiers',
  '{"tiers":[{"upToMinor":45000,"bps":1500},{"upToMinor":null,"bps":2000}],"sosExtraBps":500,"premiumBps":1000,"firstJobFree":true}'::jsonb,
  'json', 'payments', 'Tiered commission schedule',
  'Bands applied to the agreed price. 0-450 MAD = 15%, 500 MAD and above = 20%. sosExtraBps adds a surcharge for SOS jobs; premiumBps replaces the band rate for Premium subscribers.',
  true, true
)
on conflict (key) do nothing;

-- One row per "تم التفاوض" confirmation. The commission debit is derived from
-- this record, so the money movement is always traceable to a human action.
do $$ begin
  create type bidly_negotiation_status as enum ('OPEN','CONFIRMED','CANCELLED');
exception when duplicate_object then null; end $$;

create table if not exists job_negotiations (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null references jobs(id) on delete cascade,
  request_id        uuid not null references requests(id) on delete cascade,
  provider_id       uuid not null references providers(id) on delete restrict,
  customer_id       uuid not null references users(id) on delete restrict,
  -- The price the two sides settled on. Commission is computed from this.
  agreed_price_minor bigint not null check (agreed_price_minor >= 0),
  currency          char(3) not null default 'MAD' references currencies(code),
  status            bidly_negotiation_status not null default 'OPEN',
  -- Commission actually debited from the provider wallet, with the inputs that
  -- produced it so the figure can be explained months later.
  commission_minor  bigint check (commission_minor is null or commission_minor >= 0),
  commission_bps    int check (commission_bps is null or commission_bps between 0 and 10000),
  commission_snapshot jsonb not null default '{}'::jsonb,
  wallet_txn_id     uuid references wallet_transactions(id) on delete set null,
  confirmed_by      uuid references users(id) on delete set null,
  confirmed_at      timestamptz,
  cancelled_by      uuid references users(id) on delete set null,
  cancelled_at      timestamptz,
  cancel_reason     text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- One negotiation per job: it is a settlement, not a chat thread.
  unique (job_id)
);
create index if not exists idx_job_negotiations_provider on job_negotiations(provider_id, created_at desc);
create index if not exists idx_job_negotiations_status on job_negotiations(status, created_at desc);

-- ---------------------------------------------------------------------
-- 2. Wallet top-up packages
-- ---------------------------------------------------------------------

create table if not exists topup_packages (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique,
  -- What the customer pays...
  pay_minor       bigint not null check (pay_minor > 0),
  -- ...and what lands in the wallet. The difference is the bonus.
  credit_minor    bigint not null check (credit_minor >= pay_minor),
  currency        char(3) not null default 'MAD' references currencies(code),
  label_en        text not null,
  label_fr        text,
  label_ar        text,
  is_active       boolean not null default true,
  sort_order      int not null default 0,
  -- Optional window so a promo can expire on its own.
  effective_from  timestamptz not null default now(),
  effective_to    timestamptz,
  created_by      uuid references admins(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);
create index if not exists idx_topup_packages_active on topup_packages(is_active, sort_order);

-- A top-up is recorded before it is credited, so a failed charge leaves no
-- balance behind and an operator can see what happened.
do $$ begin
  create type bidly_topup_status as enum ('PENDING','COMPLETED','FAILED','CANCELLED');
exception when duplicate_object then null; end $$;

create table if not exists wallet_topups (
  id              uuid primary key default gen_random_uuid(),
  wallet_id       uuid not null references wallets(id) on delete cascade,
  user_id         uuid not null references users(id) on delete restrict,
  package_id      uuid references topup_packages(id) on delete set null,
  pay_minor       bigint not null check (pay_minor >= 0),
  credit_minor    bigint not null check (credit_minor >= 0),
  bonus_minor     bigint not null default 0 check (bonus_minor >= 0),
  currency        char(3) not null default 'MAD' references currencies(code),
  status          bidly_topup_status not null default 'PENDING',
  -- How the money arrived (cash at an agent, bank transfer, manual credit).
  method          text not null default 'MANUAL',
  reference       text,
  note            text,
  wallet_txn_id   uuid references wallet_transactions(id) on delete set null,
  created_by      uuid references admins(id) on delete set null,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_wallet_topups_user on wallet_topups(user_id, created_at desc);
create index if not exists idx_wallet_topups_status on wallet_topups(status, created_at desc);

-- ---------------------------------------------------------------------
-- 3. Provider specialty
-- ---------------------------------------------------------------------

-- A provider picks exactly one trade (سباكة، كهرباء، نجارة …). General,
-- unskilled work (errands, delivery, odd jobs) is the documented exception:
-- up to three of those may be added on top.
alter table providers
  add column if not exists is_generalist boolean not null default false;
alter table providers
  add column if not exists specialty_slug text;
-- Explicit list of general-service slugs an admin considers "unskilled".
insert into settings (key, value, value_type, group_name, label, description, is_public, is_editable)
values (
  'providers.general_service_slugs',
  '["carry-help","courier-collect","document-dropoff","furniture-assembly","general-handyman","odd-jobs","elder-help","deep-cleaning"]'::jsonb,
  'array', 'providers', 'General (non-specialist) services',
  'Services any provider may add in addition to their trade. A provider keeps one trade and up to three services from this list.',
  true, true
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 4. SOS / urgent requests and scheduled bookings
-- ---------------------------------------------------------------------

alter table requests
  add column if not exists is_sos boolean not null default false;
alter table requests
  add column if not exists sos_reason text;
-- When a scheduled booking should notify nearby providers. The dispatcher wakes
-- up at `remind_at`, not at the appointment time.
alter table requests
  add column if not exists remind_at timestamptz;

create index if not exists idx_requests_sos on requests(is_sos, status, created_at desc) where is_sos;
create index if not exists idx_requests_remind on requests(remind_at) where remind_at is not null and status in ('PUBLISHED','MATCHING');

-- ---------------------------------------------------------------------
-- 5. Job photos (before / after)
-- ---------------------------------------------------------------------

do $$ begin
  create type bidly_job_photo_stage as enum ('BEFORE','AFTER','ISSUE');
exception when duplicate_object then null; end $$;

create table if not exists job_photos (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references jobs(id) on delete cascade,
  uploaded_by   uuid not null references users(id) on delete restrict,
  uploader_role bidly_actor_role not null,
  stage         bidly_job_photo_stage not null,
  -- Path inside the Supabase Storage bucket; the API signs URLs on read so the
  -- bucket itself stays private.
  storage_path  text not null,
  mime_type     text,
  size_bytes    bigint check (size_bytes is null or size_bytes >= 0),
  width         int,
  height        int,
  caption       text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_job_photos_job on job_photos(job_id, stage, created_at);
create unique index if not exists uq_job_photos_stage_path on job_photos(job_id, storage_path);

-- ---------------------------------------------------------------------
-- 6. Post-completion complaints (7-day guarantee)
-- ---------------------------------------------------------------------

do $$ begin
  create type bidly_complaint_status as enum ('OPEN','IN_REVIEW','AWAITING_CUSTOMER','RESOLVED','REJECTED','CLOSED');
exception when duplicate_object then null; end $$;

create table if not exists complaints (
  id              uuid primary key default gen_random_uuid(),
  code            text not null unique default random_code('CMP'),
  job_id          uuid not null references jobs(id) on delete restrict,
  request_id      uuid references requests(id) on delete set null,
  raised_by       uuid not null references users(id) on delete restrict,
  against_id      uuid references users(id) on delete set null,
  provider_id     uuid references providers(id) on delete set null,
  category        text not null default 'QUALITY',
  subject         text not null,
  body            text not null,
  status          bidly_complaint_status not null default 'OPEN',
  priority        bidly_priority not null default 'NORMAL',
  -- The guarantee window the complaint was filed under, captured at creation so
  -- a later change to the policy cannot retroactively close an open case.
  guarantee_days  int not null default 7,
  resolution      text,
  resolution_type text,
  refund_minor    bigint check (refund_minor is null or refund_minor >= 0),
  assigned_to     uuid references admins(id) on delete set null,
  resolved_by     uuid references admins(id) on delete set null,
  resolved_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_complaints_job on complaints(job_id, created_at desc);
create index if not exists idx_complaints_status on complaints(status, priority, created_at desc);
-- One open complaint per job; a resolved case may be reopened as a new row.
create unique index if not exists uq_complaints_open_job on complaints(job_id)
  where status in ('OPEN','IN_REVIEW','AWAITING_CUSTOMER');

insert into settings (key, value, value_type, group_name, label, description, is_public, is_editable)
values (
  'complaints.guarantee_days',
  '7'::jsonb,
  'number', 'support', 'Service guarantee window (days)',
  'How long after a job completes a customer may open a complaint against it.',
  true, true
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 7. Boost (paid placement)
-- ---------------------------------------------------------------------

create table if not exists provider_boosts (
  id             uuid primary key default gen_random_uuid(),
  provider_id    uuid not null references providers(id) on delete cascade,
  city_id        uuid references cities(id) on delete set null,
  duration_hours int not null check (duration_hours > 0),
  price_minor    bigint not null check (price_minor >= 0),
  currency       char(3) not null default 'MAD' references currencies(code),
  starts_at      timestamptz not null default now(),
  ends_at        timestamptz not null,
  is_active      boolean not null default true,
  -- Boost is bought out of the provider's own wallet balance, so it is an
  -- internal debit rather than an online payment.
  wallet_txn_id  uuid references wallet_transactions(id) on delete set null,
  created_at     timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists idx_provider_boosts_active on provider_boosts(provider_id, ends_at desc) where is_active;

-- Denormalised "boosted until" on the provider row: ranking reads this column
-- on every search, so it must not require a join.
alter table providers
  add column if not exists boosted_until timestamptz;
create index if not exists idx_providers_boosted on providers(boosted_until desc) where boosted_until is not null;

insert into settings (key, value, value_type, group_name, label, description, is_public, is_editable)
values (
  'providers.boost_prices',
  '{"24":4900,"72":12900}'::jsonb,
  'json', 'providers', 'Boost prices (minor units)',
  'Price in minor units (centimes) keyed by duration in hours. Charged from the provider wallet balance.',
  true, true
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 8. Premium subscription
-- ---------------------------------------------------------------------

alter table users
  add column if not exists is_premium boolean not null default false;
alter table users
  add column if not exists premium_until timestamptz;
alter table users
  add column if not exists premium_since timestamptz;
create index if not exists idx_users_premium on users(premium_until) where is_premium;

insert into settings (key, value, value_type, group_name, label, description, is_public, is_editable)
values (
  'premium.monthly_price_minor',
  '9900'::jsonb,
  'number', 'payments', 'Premium monthly price (minor units)',
  'Charged from the account wallet. Premium lowers the commission rate.',
  true, true
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 9. Referrals
-- ---------------------------------------------------------------------

do $$ begin
  create type bidly_referral_status as enum ('PENDING','REWARDED','EXPIRED','CANCELLED');
exception when duplicate_object then null; end $$;

create table if not exists referral_codes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  code        text not null unique,
  is_active   boolean not null default true,
  uses_count  int not null default 0 check (uses_count >= 0),
  created_at  timestamptz not null default now()
);
create unique index if not exists uq_referral_codes_user on referral_codes(user_id);

create table if not exists referrals (
  id                uuid primary key default gen_random_uuid(),
  referrer_id       uuid not null references users(id) on delete restrict,
  referee_id        uuid not null references users(id) on delete restrict,
  code              text not null,
  status            bidly_referral_status not null default 'PENDING',
  referrer_reward_minor bigint,
  referee_reward_minor  bigint,
  currency          char(3) not null default 'MAD' references currencies(code),
  -- Set once the referee completes their first job, which is what triggers the
  -- reward. Until then the row stays PENDING.
  qualifying_job_id uuid references jobs(id) on delete set null,
  rewarded_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- A user can be referred once.
  unique (referee_id),
  check (referrer_id <> referee_id)
);
create index if not exists idx_referrals_referrer on referrals(referrer_id, status, created_at desc);

insert into settings (key, value, value_type, group_name, label, description, is_public, is_editable)
values
  ('referral.referrer_reward_minor', '2000'::jsonb, 'number', 'payments',
   'Referral reward for the inviter (minor units)',
   'Credited to the inviter wallet once the invited user completes their first service.', true, true),
  ('referral.referee_reward_minor', '1000'::jsonb, 'number', 'payments',
   'Referral reward for the invited user (minor units)',
   'Credited to the new user wallet once they complete their first service.', true, true)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 10. Two-way ratings and the RATED state
-- ---------------------------------------------------------------------

-- The existing `reviews` table already stores a `direction` (author side), so a
-- completed job can hold two rows: one CUSTOMER->PROVIDER (public) and one
-- PROVIDER->CUSTOMER (internal only). This flag marks the latter, so the
-- provider profile never accidentally shows a customer rating.
alter table reviews
  add column if not exists is_internal boolean not null default false;

-- A job is only "closed" for both sides once both ratings exist. The API
-- exposes the state; this table records the mutual completion.
create table if not exists job_rating_completion (
  job_id            uuid primary key references jobs(id) on delete cascade,
  customer_rated_at timestamptz,
  provider_rated_at timestamptz,
  fully_rated_at    timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 11. Temporary location sharing
-- ---------------------------------------------------------------------

create table if not exists tracking_links (
  id           uuid primary key default gen_random_uuid(),
  token        text not null unique,
  job_id       uuid not null references jobs(id) on delete cascade,
  created_by   uuid not null references users(id) on delete cascade,
  -- Optional label so the customer remembers who they sent it to.
  label        text,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  view_count   int not null default 0,
  last_viewed_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_tracking_links_job on tracking_links(job_id, expires_at desc);

-- ---------------------------------------------------------------------
-- 12. Feature flags for every module in this migration
--
-- Each feature ships able to be switched off on its own, so a problem in one
-- workflow never requires rolling back the schema.
-- ---------------------------------------------------------------------

insert into feature_flags (key, enabled, rollout_percent, description)
values
  ('wallet_topup_packages', true, 100, 'Discounted wallet top-up packages'),
  ('provider_negotiation',  true, 100, 'تم التفاوض confirmation and commission debit'),
  ('provider_specialty',    true, 100, 'One trade per provider, plus up to three general services'),
  ('sos_requests',          true, 100, 'Urgent SOS requests with priority dispatch'),
  ('scheduled_bookings',    true, 100, 'Book a future appointment instead of now'),
  ('job_photos',            true, 100, 'Before/after photos on a job'),
  ('service_guarantee',     true, 100, 'Seven-day complaint window after completion'),
  ('provider_boost',        true, 100, 'Paid placement in search results'),
  ('premium_subscription',  true, 100, 'Premium membership with reduced commission'),
  ('referrals',             true, 100, 'Invite codes and wallet rewards'),
  ('first_job_free',        true, 100, 'First completed job is commission-free'),
  ('two_way_ratings',       true, 100, 'Both sides rate each other after a job'),
  ('location_sharing',      true, 100, 'Temporary public tracking link'),
  ('provider_peak_stats',   true, 100, 'Peak demand times in the provider earnings page'),
  ('admin_heatmap',         true, 100, 'Demand versus supply heatmap for admins')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 13. Helper: resolve a commission schedule from settings
-- ---------------------------------------------------------------------

create or replace function khdemli_commission_schedule()
returns jsonb
language sql
stable
as $$
  select coalesce(
    (select value from settings where key = 'commission.tiers'),
    '{"tiers":[{"upToMinor":45000,"bps":1500},{"upToMinor":null,"bps":2000}],"sosExtraBps":500,"premiumBps":1000,"firstJobFree":true}'::jsonb
  );
$$;

-- ---------------------------------------------------------------------
-- 14. Wallet movement helper
--
-- The base schema already owns balance movement: `trg_wallet_txn_validate`
-- checks the row on BEFORE INSERT and `trg_wallet_txn_apply` moves the balance
-- on AFTER INSERT. This helper therefore only validates preconditions and
-- inserts the ledger row — it must NOT touch `wallets` itself, or the money
-- would move twice.
--
-- The wallet row is locked FOR UPDATE first, which serialises concurrent
-- movements on the same wallet and closes the race between the balance check
-- here and the trigger's own check a moment later.
-- ---------------------------------------------------------------------

create or replace function khdemli_wallet_apply(
  p_wallet_id uuid,
  p_direction bidly_ledger_direction,
  p_type      bidly_ledger_type,
  p_amount    bigint,
  p_reference_type text default null,
  p_reference_id   uuid default null,
  p_job_id         uuid default null,
  p_description    text default null
)
returns uuid
language plpgsql
as $$
declare
  v_wallet wallets%rowtype;
  v_after  bigint;
  v_txn_id uuid;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'amount must be positive' using errcode = '22023';
  end if;

  select * into v_wallet from wallets where id = p_wallet_id for update;
  if not found then
    raise exception 'wallet not found' using errcode = 'P0002';
  end if;
  if v_wallet.is_frozen then
    raise exception 'wallet is frozen' using errcode = 'P0001';
  end if;

  if p_direction = 'DEBIT' then
    if v_wallet.available_minor < p_amount then
      raise exception 'insufficient funds' using errcode = 'P0001';
    end if;
    v_after := v_wallet.available_minor - p_amount;
  else
    v_after := v_wallet.available_minor + p_amount;
  end if;

  -- balance_after_minor is the value the validate trigger expects: the balance
  -- before this movement is applied. The apply trigger moves it afterwards.
  insert into wallet_transactions (
    wallet_id, type, direction, amount_minor, currency, balance_after_minor,
    reference_type, reference_id, job_id, description
  ) values (
    p_wallet_id, p_type, p_direction, p_amount, v_wallet.currency, v_after,
    p_reference_type, p_reference_id, p_job_id, p_description
  )
  returning id into v_txn_id;

  return v_txn_id;
end;
$$;

-- ---------------------------------------------------------------------
-- 15. Referral code generator
-- ---------------------------------------------------------------------

create or replace function khdemli_ensure_referral_code(p_user_id uuid)
returns text
language plpgsql
as $$
declare
  v_code text;
begin
  select code into v_code from referral_codes where user_id = p_user_id;
  if v_code is not null then
    return v_code;
  end if;

  -- Readable, unambiguous alphabet (no O/0, I/1) so a code can be dictated
  -- over the phone.
  loop
    v_code := 'KH' || upper(substr(translate(encode(gen_random_bytes(6), 'base64'), '+/=OI01', 'ABCDEFGH'), 1, 6));
    begin
      insert into referral_codes (user_id, code) values (p_user_id, v_code);
      return v_code;
    exception when unique_violation then
      -- Extremely unlikely; try another code.
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------
-- 16. Grant the API roles access to everything added above
-- ---------------------------------------------------------------------

do $$
declare
  t text;
  tables text[] := array[
    'job_negotiations','topup_packages','wallet_topups','job_photos','complaints',
    'provider_boosts','referral_codes','referrals','job_rating_completion','tracking_links'
  ];
  fn text;
  fns text[] := array['khdemli_commission_schedule()','khdemli_wallet_apply(uuid,bidly_ledger_direction,bidly_ledger_type,bigint,text,uuid,uuid,text)','khdemli_ensure_referral_code(uuid)'];
begin
  foreach t in array tables loop
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = t) then
      execute format('grant select, insert, update, delete on table public.%I to authenticated', t);
      execute format('grant all on table public.%I to service_role', t);
      execute format('alter table public.%I enable row level security', t);
    end if;
  end loop;
  foreach fn in array fns loop
    execute format('grant execute on function public.%s to authenticated, service_role', fn);
  end loop;
end $$;

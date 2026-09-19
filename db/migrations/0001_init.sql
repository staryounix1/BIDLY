-- =====================================================================
-- BIDLY — 0001_init.sql
-- Initial schema for the BIDLY reverse marketplace.
-- PostgreSQL 17 (Supabase). Idempotent / re-runnable.
--
-- Conventions
--   * money      : bigint minor units + char(3) currency  (never float)
--   * time       : timestamptz (UTC)
--   * ids        : uuid, gen_random_uuid() default
--   * soft delete: deleted_at on user-visible domain rows
--   * append-only: offer_history, negotiations, job_events,
--                  wallet_transactions, payment_transactions, audit_logs
-- =====================================================================

begin;

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists btree_gin;

-- ---------------------------------------------------------------------
-- 0. Migration ledger
-- ---------------------------------------------------------------------
create table if not exists schema_migrations (
  version     text primary key,
  name        text not null,
  checksum    text,
  applied_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 1. Shared helper functions
-- ---------------------------------------------------------------------
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- Attach the updated_at trigger to a table if not already attached.
create or replace function attach_updated_at(p_table regclass) returns void
language plpgsql as $$
declare
  v_name text := (select relname from pg_class where oid = p_table);
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = p_table and tgname = 'trg_' || v_name || '_updated_at'
  ) then
    execute format(
      'create trigger %I before update on %s
         for each row execute function set_updated_at()',
      'trg_' || v_name || '_updated_at',
      p_table
    );
  end if;
end $$;

-- Guard: refuse UPDATE/DELETE on append-only tables.
create or replace function deny_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'Table % is append-only; % is not permitted',
    tg_table_name, tg_op using errcode = 'check_violation';
end $$;

create or replace function random_code(p_prefix text, p_len int default 6)
returns text language sql volatile as $$
  select p_prefix || '-' || (
    select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789',
           1 + floor(random() * 31)::int, 1), '')
    from generate_series(1, p_len)
  );
$$;

-- ---------------------------------------------------------------------
-- 2. Enum types
-- ---------------------------------------------------------------------
do $$ begin
  create type bidly_user_role        as enum ('CUSTOMER','PROVIDER','ADMIN');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_user_status      as enum ('PENDING','ACTIVE','SUSPENDED','DELETED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_verification_status as enum ('UNVERIFIED','PENDING','VERIFIED','REJECTED','EXPIRED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_provider_status  as enum ('DRAFT','PENDING_REVIEW','ACTIVE','SUSPENDED','DEACTIVATED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_pricing_model    as enum ('FIXED_QUOTE','OFFER','RANGE','HOURLY','INSPECTION');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_request_status   as enum (
    'DRAFT','PUBLISHED','MATCHING','RECEIVING_OFFERS','PROVIDER_SELECTED',
    'CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','EXPIRED','DISPUTED',
    'REFUNDED','FAILED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_offer_status     as enum ('PENDING','ACCEPTED','REJECTED','WITHDRAWN','EXPIRED','COUNTERED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_job_status       as enum (
    'CREATED','CONFIRMED','PROVIDER_EN_ROUTE','PROVIDER_ARRIVED','IN_PROGRESS',
    'COMPLETED','PAYMENT_PENDING','PAID','CANCELLED','DISPUTED','REFUNDED','FAILED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_payment_status   as enum (
    'PENDING','AUTHORIZED','CAPTURED','PARTIALLY_REFUNDED','REFUNDED','FAILED','VOIDED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_payment_method   as enum ('CARD','CASH','PAYPAL','BANK_TRANSFER','WALLET');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_txn_type         as enum (
    'AUTHORIZE','CAPTURE','VOID','REFUND','WEBHOOK','PING');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_wallet_owner     as enum ('USER','PROVIDER','PLATFORM');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_ledger_type      as enum (
    'JOB_EARNING','PLATFORM_COMMISSION','REFUND_DEBIT','PAYOUT_DEBIT',
    'PAYOUT_REVERSAL','ADJUSTMENT','BONUS','PROMOTION','PENALTY','TOPUP');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_ledger_direction as enum ('CREDIT','DEBIT');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_payout_status    as enum ('REQUESTED','APPROVED','PROCESSING','PAID','REJECTED','FAILED','CANCELLED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_refund_status    as enum ('REQUESTED','APPROVED','PROCESSING','COMPLETED','REJECTED','FAILED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_dispute_status   as enum ('OPEN','UNDER_REVIEW','AWAITING_EVIDENCE','RESOLVED','REJECTED','ESCALATED','CLOSED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_doc_status       as enum ('PENDING','APPROVED','REJECTED','EXPIRED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_notification_channel as enum ('IN_APP','PUSH','EMAIL','SMS');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_notification_status  as enum ('QUEUED','SENT','DELIVERED','FAILED','READ');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_support_status   as enum ('OPEN','PENDING','ANSWERED','RESOLVED','CLOSED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_priority         as enum ('LOW','NORMAL','HIGH','URGENT');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_admin_role       as enum ('SUPER_ADMIN','ADMIN','MODERATOR','FINANCE','SUPPORT');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_actor_role       as enum ('CUSTOMER','PROVIDER','ADMIN','SYSTEM');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_actor_side       as enum ('CUSTOMER','PROVIDER');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_negotiation_type as enum ('COUNTER','ACCEPT','REJECT','WITHDRAW','MESSAGE','SYSTEM');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_field_type       as enum (
    'TEXT','TEXTAREA','NUMBER','BOOLEAN','SELECT','MULTISELECT','DATE','DATETIME',
    'PHONE','LOCATION','ADDRESS','PHOTO','VIDEO');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_media_kind       as enum ('IMAGE','VIDEO','AUDIO','DOCUMENT');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_period_type      as enum ('DAY','NIGHT','ANY');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_commission_model as enum ('PERCENT','FIXED','PERCENT_PLUS_FIXED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_scope            as enum ('GLOBAL','CATEGORY','SUBCATEGORY','SERVICE','PROVIDER');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_outbox_status    as enum ('PENDING','PROCESSING','PROCESSED','FAILED','DEAD');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_message_kind     as enum ('TEXT','IMAGE','FILE','LOCATION','SYSTEM','OFFER_REFERENCE');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_conversation_status as enum ('ACTIVE','ARCHIVED','BLOCKED');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_verification_type as enum ('IDENTITY','PHONE','EMAIL','BUSINESS','LICENSE','INSURANCE','BACKGROUND','CERTIFICATION');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_os_platform     as enum ('IOS','ANDROID','WEB');
exception when duplicate_object then null; end $$;

do $$ begin
  create type bidly_promo_type      as enum ('PERCENT','FIXED','FREE_DELIVERY','ZERO_COMMISSION');
exception when duplicate_object then null; end $$;

commit;

-- =====================================================================
-- 0002 part: reference / configuration tables
-- =====================================================================
begin;

create table if not exists currencies (
  code         char(3) primary key,
  name         text not null,
  symbol       text not null,
  minor_units  smallint not null default 2 check (minor_units between 0 and 6),
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists countries (
  code               char(2) primary key,
  name_en            text not null,
  name_fr            text,
  name_ar            text,
  default_currency   char(3) not null references currencies(code),
  default_locale     text not null default 'ar',
  timezone           text not null,
  dial_code          text not null,
  is_launch_market   boolean not null default false,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists cities (
  id           uuid primary key default gen_random_uuid(),
  country_code char(2) not null references countries(code),
  name_en      text not null,
  name_fr      text,
  name_ar      text,
  slug         text not null unique,
  lat          double precision not null,
  lng          double precision not null,
  timezone     text not null,
  is_launch    boolean not null default false,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_cities_country on cities(country_code, is_active);

create table if not exists service_areas (
  id           uuid primary key default gen_random_uuid(),
  city_id      uuid not null references cities(id) on delete cascade,
  name         text not null,
  kind         text not null default 'RADIUS' check (kind in ('RADIUS','POLYGON')),
  center_lat   double precision,
  center_lng   double precision,
  radius_km    numeric(8,2),
  geojson      jsonb,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check (kind <> 'RADIUS' or (center_lat is not null and center_lng is not null and radius_km is not null))
);
create index if not exists idx_service_areas_city on service_areas(city_id, is_active);

-- ---------------------------------------------------------------------
-- Catalog: categories -> subcategories -> services -> fields/options
-- ---------------------------------------------------------------------
create table if not exists categories (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,
  name_en      text not null,
  name_fr      text,
  name_ar      text,
  description_en text,
  description_fr text,
  description_ar text,
  icon         text,
  color        text,
  sort_order   int not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_categories_active on categories(is_active, sort_order);

create table if not exists subcategories (
  id           uuid primary key default gen_random_uuid(),
  category_id  uuid not null references categories(id) on delete cascade,
  slug         text not null unique,
  name_en      text not null,
  name_fr      text,
  name_ar      text,
  icon         text,
  sort_order   int not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_subcategories_category on subcategories(category_id, is_active, sort_order);

create table if not exists services (
  id                 uuid primary key default gen_random_uuid(),
  subcategory_id     uuid not null references subcategories(id) on delete cascade,
  slug               text not null unique,
  name_en            text not null,
  name_fr            text,
  name_ar            text,
  description_en     text,
  description_fr     text,
  description_ar     text,
  icon               text,
  pricing_model      bidly_pricing_model not null default 'OFFER',
  default_currency   char(3) not null default 'MAD' references currencies(code),
  min_price_minor    bigint check (min_price_minor is null or min_price_minor >= 0),
  max_price_minor    bigint check (max_price_minor is null or max_price_minor >= 0),
  commission_bps     int check (commission_bps is null or (commission_bps between 0 and 10000)),
  requires_location  boolean not null default true,
  requires_destination boolean not null default false,
  requires_schedule  boolean not null default false,
  duration_minutes   int,
  sort_order         int not null default 0,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (min_price_minor is null or max_price_minor is null or max_price_minor >= min_price_minor)
);
create index if not exists idx_services_subcategory on services(subcategory_id, is_active, sort_order);

create table if not exists service_fields (
  id              uuid primary key default gen_random_uuid(),
  service_id      uuid not null references services(id) on delete cascade,
  key             text not null,
  label_en        text not null,
  label_fr        text,
  label_ar        text,
  placeholder_en  text,
  placeholder_fr  text,
  placeholder_ar  text,
  help_en         text,
  help_fr         text,
  help_ar         text,
  type            bidly_field_type not null,
  is_required     boolean not null default false,
  is_active       boolean not null default true,
  sort_order      int not null default 0,
  min_value       numeric,
  max_value       numeric,
  min_length      int,
  max_length      int,
  regex           text,
  default_value   text,
  depends_on_key  text,
  depends_on_value text,
  validation      jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (service_id, key)
);
create index if not exists idx_service_fields_service on service_fields(service_id, is_active, sort_order);

create table if not exists service_field_options (
  id          uuid primary key default gen_random_uuid(),
  field_id    uuid not null references service_fields(id) on delete cascade,
  value       text not null,
  label_en    text not null,
  label_fr    text,
  label_ar    text,
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (field_id, value)
);
create index if not exists idx_service_field_options_field on service_field_options(field_id, sort_order);

-- Service coverage: which services are offered in which area
create table if not exists service_areas_services (
  service_area_id uuid not null references service_areas(id) on delete cascade,
  service_id      uuid not null references services(id) on delete cascade,
  created_at      timestamptz not null default now(),
  primary key (service_area_id, service_id)
);

commit;

-- =====================================================================
-- 0003 part: identity, profiles, auth support
-- =====================================================================
begin;

create table if not exists users (
  id                  uuid primary key default gen_random_uuid(),
  email               citext,
  phone               text,
  password_hash       text,
  role                bidly_user_role not null default 'CUSTOMER',
  status              bidly_user_status not null default 'PENDING',
  email_verified_at   timestamptz,
  phone_verified_at   timestamptz,
  last_login_at       timestamptz,
  failed_login_count  int not null default 0,
  locked_until        timestamptz,
  locale              text not null default 'ar',
  country_code        char(2) references countries(code),
  timezone            text not null default 'Africa/Casablanca',
  is_phone_primary    boolean not null default false,
  marketing_opt_in    boolean not null default false,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint users_identifier_present check (email is not null or phone is not null)
);
create unique index if not exists uq_users_email on users(email) where email is not null and deleted_at is null;
create unique index if not exists uq_users_phone on users(phone) where phone is not null and deleted_at is null;
create index if not exists idx_users_role_status on users(role, status);
create index if not exists idx_users_created on users(created_at desc);
create index if not exists idx_users_deleted on users(deleted_at) where deleted_at is not null;

-- Admin staff accounts (created early because refunds/payouts/settings FK to it)
create table if not exists admins (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique references users(id) on delete set null,
  email         citext not null unique,
  full_name     text,
  password_hash text not null,
  role          bidly_admin_role not null default 'SUPPORT',
  permissions   text[] not null default '{}',
  is_active     boolean not null default true,
  mfa_enabled   boolean not null default false,
  mfa_secret_enc text,
  must_change_password boolean not null default true,
  failed_login_count int not null default 0,
  locked_until  timestamptz,
  last_login_at timestamptz,
  last_login_ip inet,
  created_by    uuid,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_admins_role on admins(role, is_active);

create table if not exists user_profiles (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null unique references users(id) on delete cascade,
  full_name           text,
  display_name        text,
  avatar_url          text,
  date_of_birth       date,
  gender              text,
  bio                 text,
  preferred_locale    text not null default 'ar',
  preferred_currency  char(3) not null default 'MAD' references currencies(code),
  default_address_id  uuid,
  notification_prefs  jsonb not null default '{"push":true,"email":true,"sms":false}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_user_profiles_name on user_profiles(full_name);

create table if not exists user_addresses (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  label         text,
  line1         text not null,
  line2         text,
  district      text,
  city_id       uuid references cities(id),
  city_name     text,
  region        text,
  postal_code   text,
  country_code  char(2) references countries(code),
  lat           double precision,
  lng           double precision,
  geohash       text,
  notes         text,
  is_default    boolean not null default false,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_user_addresses_user on user_addresses(user_id) where deleted_at is null;
create unique index if not exists uq_user_default_address on user_addresses(user_id) where is_default and deleted_at is null;

alter table user_profiles
  drop constraint if exists fk_user_profiles_default_address;
alter table user_profiles
  add constraint fk_user_profiles_default_address
  foreign key (default_address_id) references user_addresses(id) on delete set null;

-- Refresh-token sessions (rotation families)
create table if not exists auth_sessions (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  family_id           uuid not null,
  refresh_token_hash  text not null,
  user_agent          text,
  ip                  inet,
  device_label        text,
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  revoked_reason      text,
  replaced_by_id      uuid references auth_sessions(id),
  last_used_at        timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_auth_sessions_user on auth_sessions(user_id, expires_at desc);
create index if not exists idx_auth_sessions_family on auth_sessions(family_id);
create index if not exists idx_auth_sessions_hash on auth_sessions(refresh_token_hash);

-- Email/phone verification + password reset tokens (hashed, single use)
create table if not exists verification_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  purpose       text not null check (purpose in ('EMAIL_VERIFY','PHONE_VERIFY','PASSWORD_RESET','LOGIN_OTP','PHONE_CHANGE','EMAIL_CHANGE')),
  channel       bidly_notification_channel not null default 'EMAIL',
  destination   text,
  token_hash    text not null,
  code_hint     text,
  attempt_count int not null default 0,
  max_attempts  int not null default 5,
  expires_at    timestamptz not null,
  consumed_at   timestamptz,
  ip            inet,
  created_at    timestamptz not null default now()
);
create index if not exists idx_verification_tokens_user on verification_tokens(user_id, purpose, created_at desc);
create index if not exists idx_verification_tokens_lookup on verification_tokens(token_hash) where consumed_at is null;

create table if not exists devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  platform      bidly_os_platform not null default 'WEB',
  push_token    text,
  device_id     text,
  app_version   text,
  locale        text,
  last_seen_at  timestamptz not null default now(),
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, platform, push_token)
);
create index if not exists idx_devices_user on devices(user_id, is_active);

commit;

-- =====================================================================
-- 0004 part: providers (supply side)
-- =====================================================================
begin;

create table if not exists providers (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null unique references users(id) on delete cascade,
  display_name          text not null,
  legal_name            text,
  bio                   text,
  avatar_url            text,
  cover_url             text,
  status                bidly_provider_status not null default 'DRAFT',
  verification_status   bidly_verification_status not null default 'UNVERIFIED',
  verified_at           timestamptz,
  rating_avg            numeric(3,2) not null default 0 check (rating_avg between 0 and 5),
  rating_count          int not null default 0 check (rating_count >= 0),
  reviews_count         int not null default 0,
  completed_jobs        int not null default 0 check (completed_jobs >= 0),
  cancelled_jobs        int not null default 0,
  declined_jobs         int not null default 0,
  total_offers          int not null default 0,
  accepted_offers       int not null default 0,
  response_rate_bps     int not null default 0 check (response_rate_bps between 0 and 10000),
  acceptance_rate_bps   int not null default 0 check (acceptance_rate_bps between 0 and 10000),
  cancellation_rate_bps int not null default 0 check (cancellation_rate_bps between 0 and 10000),
  on_time_rate_bps      int not null default 0 check (on_time_rate_bps between 0 and 10000),
  avg_response_seconds  int,
  languages             text[] not null default '{}',
  is_online             boolean not null default false,
  is_available          boolean not null default true,
  service_radius_km     numeric(6,2) not null default 15,
  country_code          char(2) references countries(code),
  city_id               uuid references cities(id),
  currency              char(3) not null default 'MAD' references currencies(code),
  commission_bps_override int check (commission_bps_override is null or commission_bps_override between 0 and 10000),
  suspended_at          timestamptz,
  suspension_reason     text,
  deleted_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_providers_status on providers(status, verification_status);
create index if not exists idx_providers_city on providers(city_id, is_available, is_online);
create index if not exists idx_providers_rating on providers(rating_avg desc) where status = 'ACTIVE';
create index if not exists idx_providers_online on providers(is_online) where deleted_at is null;

create table if not exists provider_services (
  id                uuid primary key default gen_random_uuid(),
  provider_id       uuid not null references providers(id) on delete cascade,
  service_id        uuid not null references services(id) on delete cascade,
  pricing_model     bidly_pricing_model not null default 'OFFER',
  base_price_minor  bigint check (base_price_minor is null or base_price_minor >= 0),
  min_price_minor   bigint check (min_price_minor is null or min_price_minor >= 0),
  max_price_minor   bigint check (max_price_minor is null or max_price_minor >= 0),
  currency          char(3) not null default 'MAD' references currencies(code),
  hourly_rate_minor bigint,
  eta_minutes       int,
  experience_years  int,
  is_active         boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (provider_id, service_id),
  check (min_price_minor is null or max_price_minor is null or max_price_minor >= min_price_minor)
);
create index if not exists idx_provider_services_service on provider_services(service_id, is_active);
create index if not exists idx_provider_services_provider on provider_services(provider_id, is_active);

create table if not exists provider_locations (
  id            uuid primary key default gen_random_uuid(),
  provider_id   uuid not null references providers(id) on delete cascade,
  lat           double precision not null,
  lng           double precision not null,
  geohash       text,
  accuracy_m    numeric(8,2),
  heading       numeric(5,2),
  speed_kmh     numeric(6,2),
  is_current    boolean not null default true,
  recorded_at   timestamptz not null default now(),
  created_at    timestamptz not null default now()
);
create index if not exists idx_provider_locations_provider on provider_locations(provider_id, recorded_at desc);
create index if not exists idx_provider_locations_current on provider_locations(provider_id) where is_current;
create index if not exists idx_provider_locations_geohash on provider_locations(geohash) where is_current;

create table if not exists provider_service_areas (
  id              uuid primary key default gen_random_uuid(),
  provider_id     uuid not null references providers(id) on delete cascade,
  service_area_id uuid references service_areas(id) on delete cascade,
  city_id         uuid references cities(id),
  center_lat      double precision,
  center_lng      double precision,
  radius_km       numeric(6,2) not null default 15 check (radius_km > 0 and radius_km <= 500),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (provider_id, service_area_id)
);
create index if not exists idx_provider_service_areas_provider on provider_service_areas(provider_id);
create index if not exists idx_provider_service_areas_area on provider_service_areas(service_area_id);

create table if not exists availability (
  id              uuid primary key default gen_random_uuid(),
  provider_id     uuid not null references providers(id) on delete cascade,
  weekday         smallint check (weekday between 0 and 6),
  start_time      time,
  end_time        time,
  period          bidly_period_type not null default 'ANY',
  is_exception    boolean not null default false,
  exception_date  date,
  is_available    boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (is_exception or (weekday is not null and start_time is not null and end_time is not null)),
  check (start_time is null or end_time is null or end_time > start_time),
  unique (provider_id, weekday, start_time, exception_date)
);
create index if not exists idx_availability_provider on availability(provider_id, weekday);

create table if not exists provider_documents (
  id                uuid primary key default gen_random_uuid(),
  provider_id       uuid not null references providers(id) on delete cascade,
  type              bidly_verification_type not null,
  document_number   text,
  file_url          text not null,
  file_mime         text,
  status            bidly_doc_status not null default 'PENDING',
  reviewed_by       uuid,
  reviewed_at       timestamptz,
  rejection_reason  text,
  expires_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_provider_documents_provider on provider_documents(provider_id, status);
create index if not exists idx_provider_documents_pending on provider_documents(status) where status = 'PENDING';

create table if not exists verification_records (
  id            uuid primary key default gen_random_uuid(),
  provider_id   uuid not null references providers(id) on delete cascade,
  user_id       uuid references users(id) on delete cascade,
  type          bidly_verification_type not null,
  subject       text,
  destination   text,
  document_id   uuid references provider_documents(id) on delete set null,
  status        bidly_verification_status not null default 'PENDING',
  method        text,
  reference     text,
  submitted_at  timestamptz not null default now(),
  reviewed_at   timestamptz,
  reviewed_by   uuid,
  notes         text,
  payload       jsonb not null default '{}'::jsonb,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_verification_records_provider on verification_records(provider_id, type, status);
create index if not exists idx_verification_records_status on verification_records(status);

commit;

-- =====================================================================
-- 0005 part: requests (demand)
-- =====================================================================
begin;

create table if not exists requests (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique default random_code('REQ'),
  customer_id         uuid not null references users(id) on delete restrict,
  category_id         uuid not null references categories(id),
  subcategory_id      uuid references subcategories(id),
  service_id          uuid not null references services(id),
  title               text,
  description         text,
  answers             jsonb not null default '{}'::jsonb,
  status              bidly_request_status not null default 'DRAFT',

  pricing_model       bidly_pricing_model not null default 'OFFER',
  budget_min_minor    bigint check (budget_min_minor is null or budget_min_minor >= 0),
  budget_max_minor    bigint check (budget_max_minor is null or budget_max_minor >= 0),
  currency            char(3) not null default 'MAD' references currencies(code),
  final_currency      char(3) references currencies(code),

  pickup_line1        text,
  pickup_line2        text,
  pickup_district     text,
  pickup_city_id      uuid references cities(id),
  pickup_city_name    text,
  pickup_lat          double precision,
  pickup_lng          double precision,
  pickup_geohash      text,
  pickup_notes        text,

  destination_line1   text,
  destination_city_id uuid references cities(id),
  destination_city_name text,
  destination_lat     double precision,
  destination_lng     double precision,
  destination_geohash text,
  destination_notes   text,

  distance_km         numeric(8,2) check (distance_km is null or distance_km >= 0),
  scheduled_at        timestamptz,
  scheduled_flexible  boolean not null default true,
  urgency             text not null default 'NORMAL' check (urgency in ('LOW','NORMAL','HIGH','URGENT')),
  item_count          int,
  requires_helper     boolean not null default false,

  city_id             uuid references cities(id),
  service_area_id     uuid references service_areas(id),

  offer_count         int not null default 0 check (offer_count >= 0),
  view_count          int not null default 0,
  selected_offer_id   uuid,
  job_id              uuid,

  published_at        timestamptz,
  expires_at          timestamptz,
  matched_at          timestamptz,
  cancelled_at        timestamptz,
  cancelled_by        uuid references users(id),
  cancellation_reason text,
  completed_at        timestamptz,
  metadata            jsonb not null default '{}'::jsonb,
  deleted_at          timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint requests_budget_order check (
    budget_min_minor is null or budget_max_minor is null or budget_max_minor >= budget_min_minor
  )
);
create index if not exists idx_requests_customer on requests(customer_id, created_at desc) where deleted_at is null;
create index if not exists idx_requests_feed on requests(status, service_id, city_id, published_at desc) where deleted_at is null;
create index if not exists idx_requests_status_expiry on requests(status, expires_at) where status in ('PUBLISHED','MATCHING','RECEIVING_OFFERS');
create index if not exists idx_requests_city_status on requests(city_id, status, created_at desc) where deleted_at is null;
create index if not exists idx_requests_service_status on requests(service_id, status, published_at desc);
create index if not exists idx_requests_geohash on requests(pickup_geohash) where deleted_at is null;
create index if not exists idx_requests_job on requests(job_id);
create index if not exists idx_requests_answers on requests using gin (answers jsonb_path_ops);
create index if not exists idx_requests_scheduled on requests(scheduled_at) where status in ('CONFIRMED','IN_PROGRESS');

create table if not exists request_answers (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references requests(id) on delete cascade,
  field_id      uuid references service_fields(id) on delete set null,
  field_key     text not null,
  field_type    bidly_field_type,
  value_text    text,
  value_number  numeric,
  value_boolean boolean,
  value_date    timestamptz,
  value_json    jsonb,
  value_option_ids uuid[],
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (request_id, field_key)
);
create index if not exists idx_request_answers_request on request_answers(request_id);
create index if not exists idx_request_answers_field on request_answers(field_id);

create table if not exists request_media (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references requests(id) on delete cascade,
  uploader_id   uuid not null references users(id) on delete cascade,
  kind          bidly_media_kind not null default 'IMAGE',
  url           text not null,
  storage_key   text,
  mime_type     text,
  size_bytes    bigint check (size_bytes is null or size_bytes >= 0),
  width         int,
  height        int,
  duration_sec  int,
  checksum      text,
  sort_order    int not null default 0,
  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_request_media_request on request_media(request_id) where deleted_at is null;

-- Matching runs (which providers were considered and why)
create table if not exists match_runs (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references requests(id) on delete cascade,
  algorithm       text not null default 'v1_geo_score',
  radius_km       numeric(6,2) not null default 15,
  candidate_count int not null default 0,
  notified_count  int not null default 0,
  status          text not null default 'COMPLETED',
  duration_ms     int,
  created_at      timestamptz not null default now()
);
create index if not exists idx_match_runs_request on match_runs(request_id, created_at desc);

create table if not exists match_candidates (
  id              uuid primary key default gen_random_uuid(),
  match_run_id    uuid not null references match_runs(id) on delete cascade,
  request_id      uuid not null references requests(id) on delete cascade,
  provider_id     uuid not null references providers(id) on delete cascade,
  score           numeric(6,3) not null default 0,
  distance_km     numeric(8,2),
  is_eligible     boolean not null default true,
  exclusion_code  text,
  reasons         jsonb not null default '[]'::jsonb,
  notified_at     timestamptz,
  created_at      timestamptz not null default now(),
  unique (match_run_id, provider_id)
);
create index if not exists idx_match_candidates_request on match_candidates(request_id);
create index if not exists idx_match_candidates_provider on match_candidates(provider_id, created_at desc);

commit;

-- =====================================================================
-- 0006 part: offers, history, negotiations
-- =====================================================================
begin;

create table if not exists offers (
  id                    uuid primary key default gen_random_uuid(),
  request_id            uuid not null references requests(id) on delete cascade,
  provider_id           uuid not null references providers(id) on delete cascade,
  parent_offer_id       uuid references offers(id) on delete set null,
  root_offer_id         uuid references offers(id) on delete set null,
  version               int not null default 1 check (version >= 1),
  side                  bidly_actor_side not null default 'PROVIDER',

  price_minor           bigint not null check (price_minor >= 0),
  currency              char(3) not null default 'MAD' references currencies(code),
  price_includes_materials boolean not null default false,
  message               text,
  internal_note         text,

  eta_minutes           int check (eta_minutes is null or eta_minutes >= 0),
  availability_starts_at timestamptz,
  estimated_duration_minutes int,
  is_auto_generated     boolean not null default false,
  is_counter            boolean not null default false,

  status                bidly_offer_status not null default 'PENDING',
  rejection_reason      text,
  expires_at            timestamptz,
  viewed_at             timestamptz,
  accepted_at           timestamptz,
  rejected_at           timestamptz,
  withdrawn_at          timestamptz,
  countered_at          timestamptz,
  metadata              jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index if not exists idx_offers_request on offers(request_id, status, price_minor);
create index if not exists idx_offers_provider on offers(provider_id, status, created_at desc);
create index if not exists idx_offers_pending on offers(request_id, created_at desc) where status = 'PENDING';
create index if not exists idx_offers_root on offers(root_offer_id);
-- at most one accepted offer per request
create unique index if not exists uq_offers_one_accepted_per_request
  on offers(request_id) where status = 'ACCEPTED';
-- at most one live offer per provider per request
create unique index if not exists uq_offers_one_pending_per_provider_request
  on offers(request_id, provider_id) where status = 'PENDING';
create index if not exists idx_offers_expiry on offers(expires_at) where status = 'PENDING';

create table if not exists offer_history (
  id            uuid primary key default gen_random_uuid(),
  offer_id      uuid not null references offers(id) on delete cascade,
  request_id    uuid not null references requests(id) on delete cascade,
  provider_id   uuid not null references providers(id) on delete cascade,
  version       int not null,
  change_type   text not null,
  price_minor   bigint,
  currency      char(3),
  message       text,
  eta_minutes   int,
  status        bidly_offer_status,
  actor_id      uuid references users(id),
  actor_role    bidly_actor_role,
  snapshot      jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  unique (offer_id, version, change_type)
);
create index if not exists idx_offer_history_offer on offer_history(offer_id, created_at desc);
create index if not exists idx_offer_history_request on offer_history(request_id, created_at desc);

create table if not exists negotiations (
  id            uuid primary key default gen_random_uuid(),
  request_id    uuid not null references requests(id) on delete cascade,
  offer_id      uuid references offers(id) on delete cascade,
  root_offer_id uuid references offers(id) on delete set null,
  actor_id      uuid references users(id),
  actor_role    bidly_actor_role not null,
  side          bidly_actor_side not null,
  type          bidly_negotiation_type not null,
  price_minor   bigint check (price_minor is null or price_minor >= 0),
  currency      char(3) references currencies(code),
  previous_price_minor bigint,
  message       text,
  resulting_offer_id uuid references offers(id) on delete set null,
  round_number  int not null default 1,
  payload       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists idx_negotiations_offer on negotiations(offer_id, created_at);
create index if not exists idx_negotiations_request on negotiations(request_id, created_at);

-- Market intelligence: anonymised price stats per service (filled by worker later)
create table if not exists price_stats (
  id              uuid primary key default gen_random_uuid(),
  service_id      uuid not null references services(id) on delete cascade,
  city_id         uuid references cities(id) on delete cascade,
  currency        char(3) not null default 'MAD' references currencies(code),
  window_start    timestamptz not null,
  window_end      timestamptz not null,
  offers_count    int not null default 0,
  accepted_count  int not null default 0,
  min_minor       bigint,
  max_minor       bigint,
  avg_minor       bigint,
  median_minor    bigint,
  p25_minor       bigint,
  p75_minor       bigint,
  created_at      timestamptz not null default now(),
  unique (service_id, city_id, window_start)
);
create index if not exists idx_price_stats_service on price_stats(service_id, city_id, window_start desc);

commit;

-- =====================================================================
-- 0007 part: jobs, events, conversations, messages, reviews
-- =====================================================================
begin;

create table if not exists jobs (
  id                    uuid primary key default gen_random_uuid(),
  code                  text not null unique default random_code('JOB'),
  request_id            uuid not null unique references requests(id) on delete restrict,
  customer_id           uuid not null references users(id) on delete restrict,
  provider_id           uuid not null references providers(id) on delete restrict,
  accepted_offer_id     uuid not null references offers(id),
  service_id            uuid not null references services(id),

  final_price_minor     bigint not null check (final_price_minor >= 0),
  currency              char(3) not null default 'MAD' references currencies(code),
  commission_minor      bigint not null default 0 check (commission_minor >= 0),
  commission_bps        int check (commission_bps is null or commission_bps between 0 and 10000),
  provider_net_minor    bigint not null default 0,
  commission_snapshot   jsonb not null default '{}'::jsonb,
  pricing_snapshot      jsonb not null default '{}'::jsonb,

  status                bidly_job_status not null default 'CREATED',
  payment_status        bidly_payment_status not null default 'PENDING',

  pickup_line1          text,
  pickup_city_name      text,
  pickup_lat            double precision,
  pickup_lng            double precision,
  destination_line1     text,
  destination_city_name text,
  destination_lat       double precision,
  destination_lng       double precision,
  distance_km           numeric(8,2),

  scheduled_at          timestamptz,
  duration_minutes      int,
  start_otp_hash        text,
  start_otp_expires_at  timestamptz,
  provider_en_route_at  timestamptz,
  arrived_at            timestamptz,
  started_at            timestamptz,
  completed_at          timestamptz,
  confirmed_at          timestamptz,
  auto_confirm_at       timestamptz,

  cancelled_at          timestamptz,
  cancelled_by          uuid references users(id),
  cancelled_by_role     bidly_actor_role,
  cancellation_reason   text,
  cancellation_fee_minor bigint not null default 0,
  dispute_id            uuid,
  completion_photos     jsonb not null default '[]'::jsonb,
  completion_note       text,
  metadata              jsonb not null default '{}'::jsonb,
  deleted_at            timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint jobs_net_le_price check (commission_minor <= final_price_minor)
);
create index if not exists idx_jobs_customer on jobs(customer_id, status, created_at desc) where deleted_at is null;
create index if not exists idx_jobs_provider on jobs(provider_id, status, created_at desc) where deleted_at is null;
create index if not exists idx_jobs_status_schedule on jobs(status, scheduled_at);
create index if not exists idx_jobs_payment_status on jobs(payment_status, status);
create index if not exists idx_jobs_auto_confirm on jobs(auto_confirm_at) where status = 'COMPLETED';
create index if not exists idx_jobs_completed on jobs(provider_id, completed_at desc) where status = 'PAID';

create table if not exists job_events (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references jobs(id) on delete cascade,
  request_id    uuid references requests(id) on delete set null,
  type          text not null,
  from_status   bidly_job_status,
  to_status     bidly_job_status,
  actor_id      uuid references users(id),
  actor_role    bidly_actor_role not null default 'SYSTEM',
  payload       jsonb not null default '{}'::jsonb,
  lat           double precision,
  lng           double precision,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_job_events_job on job_events(job_id, created_at);
create index if not exists idx_job_events_type on job_events(type, created_at desc);

create table if not exists conversations (
  id                     uuid primary key default gen_random_uuid(),
  request_id             uuid references requests(id) on delete set null,
  job_id                 uuid references jobs(id) on delete cascade,
  participant_a          uuid not null references users(id) on delete cascade,
  participant_b          uuid not null references users(id) on delete cascade,
  last_message_at        timestamptz,
  last_message_preview   text,
  last_message_sender_id uuid references users(id) on delete set null,
  a_unread_count         int not null default 0,
  b_unread_count         int not null default 0,
  status                 bidly_conversation_status not null default 'ACTIVE',
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (participant_a <> participant_b)
);
create unique index if not exists uq_conversations_job on conversations(job_id) where job_id is not null;
create index if not exists idx_conversations_a on conversations(participant_a, last_message_at desc);
create index if not exists idx_conversations_b on conversations(participant_b, last_message_at desc);

create table if not exists messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id       uuid references users(id) on delete set null,
  kind            bidly_message_kind not null default 'TEXT',
  body            text,
  attachment_url  text,
  attachment_meta jsonb,
  offer_id        uuid references offers(id) on delete set null,
  lat             double precision,
  lng             double precision,
  read_at         timestamptz,
  delivered_at    timestamptz,
  client_id       text,
  meta            jsonb not null default '{}'::jsonb,
  deleted_at      timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_messages_conversation on messages(conversation_id, created_at desc) where deleted_at is null;
create unique index if not exists uq_messages_client_id on messages(conversation_id, client_id) where client_id is not null;

create table if not exists reviews (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references jobs(id) on delete cascade,
  request_id    uuid references requests(id) on delete set null,
  author_id     uuid not null references users(id) on delete cascade,
  subject_id    uuid not null references users(id) on delete cascade,
  provider_id   uuid references providers(id) on delete set null,
  direction     bidly_actor_side not null,
  rating        smallint not null check (rating between 1 and 5),
  comment       text,
  tags          text[] not null default '{}',
  would_recommend boolean,
  is_visible    boolean not null default true,
  is_flagged    boolean not null default false,
  flag_reason   text,
  moderated_by  uuid,
  moderated_at  timestamptz,
  provider_reply text,
  provider_replied_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (author_id <> subject_id)
);
create unique index if not exists uq_reviews_one_per_direction on reviews(job_id, direction);
create index if not exists idx_reviews_provider on reviews(provider_id, created_at desc) where is_visible;
create index if not exists idx_reviews_subject on reviews(subject_id, created_at desc);
create index if not exists idx_reviews_flagged on reviews(is_flagged) where is_flagged;

commit;

-- =====================================================================
-- 0008 part: payments, ledger, refunds, payouts
-- =====================================================================
begin;

create table if not exists payments (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null unique references jobs(id) on delete restrict,
  request_id          uuid references requests(id) on delete set null,
  customer_id         uuid not null references users(id) on delete restrict,
  provider_id         uuid references providers(id) on delete set null,
  provider_name       text not null default 'internal',
  provider_ref        text,
  provider_intent_ref text,
  method              bidly_payment_method not null default 'CARD',
  status              bidly_payment_status not null default 'PENDING',
  amount_minor        bigint not null check (amount_minor >= 0),
  currency            char(3) not null default 'MAD' references currencies(code),
  captured_minor      bigint not null default 0 check (captured_minor >= 0),
  refunded_minor      bigint not null default 0 check (refunded_minor >= 0),
  commission_minor    bigint not null default 0,
  provider_net_minor  bigint not null default 0,
  commission_snapshot jsonb not null default '{}'::jsonb,
  authorized_at       timestamptz,
  captured_at         timestamptz,
  failed_at           timestamptz,
  voided_at           timestamptz,
  failure_code        text,
  failure_message     text,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint payments_refund_le_captured check (refunded_minor <= amount_minor)
);
create index if not exists idx_payments_customer on payments(customer_id, created_at desc);
create index if not exists idx_payments_provider on payments(provider_id, created_at desc);
create index if not exists idx_payments_status on payments(status, created_at desc);
create index if not exists idx_payments_provider_ref on payments(provider_name, provider_ref);

create table if not exists payment_transactions (
  id              uuid primary key default gen_random_uuid(),
  payment_id      uuid not null references payments(id) on delete cascade,
  job_id          uuid references jobs(id) on delete set null,
  type            bidly_txn_type not null,
  provider_name   text not null default 'internal',
  provider_ref    text,
  amount_minor    bigint not null default 0,
  currency        char(3) not null default 'MAD' references currencies(code),
  status          text not null default 'PENDING' check (status in ('PENDING','SUCCESS','FAILED','IGNORED')),
  idempotency_key text,
  error_code      text,
  error_message   text,
  raw_payload     jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists idx_payment_txns_payment on payment_transactions(payment_id, created_at);
create index if not exists idx_payment_txns_type on payment_transactions(type, created_at desc);
create unique index if not exists uq_payment_txns_idempotency on payment_transactions(idempotency_key) where idempotency_key is not null;
create unique index if not exists uq_payment_txns_provider_ref on payment_transactions(provider_name, provider_ref, type) where provider_ref is not null;

create table if not exists wallets (
  id                  uuid primary key default gen_random_uuid(),
  owner_type          bidly_wallet_owner not null,
  owner_id            uuid not null,
  currency            char(3) not null default 'MAD' references currencies(code),
  available_minor     bigint not null default 0 check (available_minor >= 0),
  pending_minor       bigint not null default 0 check (pending_minor >= 0),
  reserved_minor      bigint not null default 0 check (reserved_minor >= 0),
  lifetime_in_minor   bigint not null default 0 check (lifetime_in_minor >= 0),
  lifetime_out_minor  bigint not null default 0 check (lifetime_out_minor >= 0),
  lifetime_fees_minor bigint not null default 0,
  version             int not null default 0,
  is_frozen           boolean not null default false,
  freeze_reason       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (owner_type, owner_id, currency)
);
create index if not exists idx_wallets_owner on wallets(owner_type, owner_id);

create table if not exists wallet_transactions (
  id                  uuid primary key default gen_random_uuid(),
  wallet_id           uuid not null references wallets(id) on delete restrict,
  type                bidly_ledger_type not null,
  direction           bidly_ledger_direction not null,
  amount_minor        bigint not null check (amount_minor > 0),
  currency            char(3) not null default 'MAD' references currencies(code),
  balance_after_minor bigint not null check (balance_after_minor >= 0),
  pending_after_minor bigint,
  reference_type      text,
  reference_id        uuid,
  group_id            uuid,
  job_id              uuid references jobs(id) on delete set null,
  payment_id          uuid references payments(id) on delete set null,
  description         text,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);
create index if not exists idx_wallet_txns_wallet on wallet_transactions(wallet_id, created_at desc);
create index if not exists idx_wallet_txns_reference on wallet_transactions(reference_type, reference_id);
create index if not exists idx_wallet_txns_job on wallet_transactions(job_id);
create index if not exists idx_wallet_txns_group on wallet_transactions(group_id);
create unique index if not exists uq_wallet_txn_job_credit
  on wallet_transactions(job_id, type) where type = 'JOB_EARNING' and job_id is not null;

create table if not exists platform_earnings (
  id              uuid primary key default gen_random_uuid(),
  payment_id      uuid references payments(id) on delete set null,
  job_id          uuid references jobs(id) on delete set null,
  currency        char(3) not null default 'MAD' references currencies(code),
  gross_minor     bigint not null default 0,
  commission_minor bigint not null default 0,
  country_code    char(2),
  city_id         uuid references cities(id),
  service_id      uuid references services(id),
  recorded_at     timestamptz not null default now()
);
create index if not exists idx_platform_earnings_date on platform_earnings(recorded_at desc);

create table if not exists refunds (
  id              uuid primary key default gen_random_uuid(),
  payment_id      uuid not null references payments(id) on delete restrict,
  job_id          uuid references jobs(id) on delete set null,
  request_id      uuid references requests(id) on delete set null,
  amount_minor    bigint not null check (amount_minor > 0),
  currency        char(3) not null default 'MAD' references currencies(code),
  reason          text,
  reason_code     text,
  is_partial      boolean not null default false,
  status          bidly_refund_status not null default 'REQUESTED',
  requested_by    uuid references users(id),
  requested_by_role bidly_actor_role,
  approved_by     uuid references admins(id),
  provider_name   text,
  provider_ref    text,
  failure_reason  text,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  processed_at    timestamptz,
  updated_at      timestamptz not null default now()
);
create index if not exists idx_refunds_payment on refunds(payment_id, created_at desc);
create index if not exists idx_refunds_status on refunds(status, created_at desc);

create table if not exists payouts (
  id                  uuid primary key default gen_random_uuid(),
  provider_id         uuid not null references providers(id) on delete restrict,
  user_id             uuid not null references users(id) on delete restrict,
  wallet_id           uuid not null references wallets(id) on delete restrict,
  amount_minor        bigint not null check (amount_minor > 0),
  currency            char(3) not null default 'MAD' references currencies(code),
  fee_minor           bigint not null default 0,
  net_minor           bigint not null default 0,
  method              text not null default 'BANK_TRANSFER',
  destination_masked  text,
  destination_ref     text,
  status              bidly_payout_status not null default 'REQUESTED',
  provider_name       text,
  provider_ref        text,
  failure_reason      text,
  requested_at        timestamptz not null default now(),
  approved_by         uuid references admins(id),
  approved_at         timestamptz,
  processed_at        timestamptz,
  paid_at             timestamptz,
  notes               text,
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_payouts_provider on payouts(provider_id, created_at desc);
create index if not exists idx_payouts_status on payouts(status, created_at desc);

commit;

-- =====================================================================
-- 0009 part: disputes, notifications, support, admin, audit
-- =====================================================================
begin;

create table if not exists disputes (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null references jobs(id) on delete cascade,
  request_id          uuid references requests(id) on delete set null,
  opened_by           uuid not null references users(id) on delete restrict,
  opened_by_role      bidly_actor_role not null,
  against_id          uuid references users(id) on delete set null,
  against_provider_id uuid references providers(id) on delete set null,
  reason_code         text not null,
  reason              text,
  description         text,
  status              bidly_dispute_status not null default 'OPEN',
  priority            bidly_priority not null default 'NORMAL',
  assigned_admin_id   uuid,
  resolution          text,
  resolution_type     text,
  resolution_amount_minor bigint,
  currency            char(3) not null default 'MAD' references currencies(code),
  refund_id           uuid references refunds(id) on delete set null,
  internal_notes      text,
  opened_at           timestamptz not null default now(),
  first_response_at   timestamptz,
  resolved_at         timestamptz,
  closed_at           timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create unique index if not exists uq_disputes_one_open_per_job
  on disputes(job_id) where status in ('OPEN','UNDER_REVIEW','AWAITING_EVIDENCE','ESCALATED');
create index if not exists idx_disputes_status on disputes(status, priority, created_at desc);
create index if not exists idx_disputes_opened_by on disputes(opened_by, created_at desc);

create table if not exists dispute_evidence (
  id            uuid primary key default gen_random_uuid(),
  dispute_id    uuid not null references disputes(id) on delete cascade,
  uploader_id   uuid not null references users(id) on delete cascade,
  uploader_role bidly_actor_role not null default 'CUSTOMER',
  kind          bidly_media_kind not null default 'IMAGE',
  url           text not null,
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_dispute_evidence_dispute on dispute_evidence(dispute_id, created_at);

create table if not exists notifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  type          text not null,
  title_en      text,
  title_fr      text,
  title_ar      text,
  body_en       text,
  body_fr       text,
  body_ar       text,
  data          jsonb not null default '{}'::jsonb,
  channel       bidly_notification_channel not null default 'IN_APP',
  status        bidly_notification_status not null default 'QUEUED',
  priority      bidly_priority not null default 'NORMAL',
  reference_type text,
  reference_id  uuid,
  is_read       boolean not null default false,
  read_at       timestamptz,
  sent_at       timestamptz,
  delivered_at  timestamptz,
  failed_reason text,
  attempts      int not null default 0,
  dedupe_key    text,
  expires_at    timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_notifications_user on notifications(user_id, created_at desc);
create index if not exists idx_notifications_unread on notifications(user_id, created_at desc) where is_read = false;
create unique index if not exists uq_notifications_dedupe on notifications(user_id, dedupe_key) where dedupe_key is not null;

create table if not exists notification_preferences (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  event_type    text not null,
  in_app        boolean not null default true,
  push          boolean not null default true,
  email         boolean not null default true,
  sms           boolean not null default false,
  quiet_hours_start time,
  quiet_hours_end   time,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, event_type)
);

create table if not exists support_tickets (
  id                  uuid primary key default gen_random_uuid(),
  code                text not null unique default random_code('SUP'),
  user_id             uuid not null references users(id) on delete cascade,
  requester_role      bidly_user_role not null default 'CUSTOMER',
  job_id              uuid references jobs(id) on delete set null,
  request_id          uuid references requests(id) on delete set null,
  payment_id          uuid references payments(id) on delete set null,
  subject             text not null,
  category            text not null default 'GENERAL',
  description         text,
  status              bidly_support_status not null default 'OPEN',
  priority            bidly_priority not null default 'NORMAL',
  assigned_admin_id   uuid,
  first_response_at   timestamptz,
  resolved_at         timestamptz,
  closed_at           timestamptz,
  satisfaction_rating smallint check (satisfaction_rating is null or satisfaction_rating between 1 and 5),
  metadata            jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_support_tickets_user on support_tickets(user_id, created_at desc);
create index if not exists idx_support_tickets_status on support_tickets(status, priority, created_at desc);

create table if not exists support_messages (
  id            uuid primary key default gen_random_uuid(),
  ticket_id     uuid not null references support_tickets(id) on delete cascade,
  sender_id     uuid references users(id) on delete set null,
  sender_role   bidly_actor_role not null default 'CUSTOMER',
  body          text not null,
  attachment_url text,
  is_internal   boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists idx_support_messages_ticket on support_messages(ticket_id, created_at);

-- (admins table is created earlier, in the identity section)

create table if not exists admin_sessions (
  id            uuid primary key default gen_random_uuid(),
  admin_id      uuid not null references admins(id) on delete cascade,
  token_hash    text not null,
  ip            inet,
  user_agent    text,
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_admin_sessions_admin on admin_sessions(admin_id, expires_at desc);

create table if not exists admin_actions (
  id            uuid primary key default gen_random_uuid(),
  admin_id      uuid references admins(id) on delete set null,
  admin_email   text,
  action        text not null,
  target_type   text,
  target_id     uuid,
  before_state  jsonb,
  after_state   jsonb,
  reason        text,
  ip            inet,
  user_agent    text,
  severity      text not null default 'INFO',
  created_at    timestamptz not null default now()
);
create index if not exists idx_admin_actions_admin on admin_actions(admin_id, created_at desc);
create index if not exists idx_admin_actions_target on admin_actions(target_type, target_id, created_at desc);
create index if not exists idx_admin_actions_action on admin_actions(action, created_at desc);

create table if not exists audit_logs (
  id            uuid primary key default gen_random_uuid(),
  actor_id      uuid,
  actor_type    text not null default 'USER' check (actor_type in ('USER','ADMIN','SYSTEM','PROVIDER')),
  actor_role    text,
  action        text not null,
  entity_type   text,
  entity_id     uuid,
  changes       jsonb not null default '{}'::jsonb,
  before_state  jsonb,
  after_state   jsonb,
  ip            inet,
  user_agent    text,
  request_id    text,
  ip_country    char(2),
  severity      text not null default 'INFO' check (severity in ('DEBUG','INFO','NOTICE','WARNING','ERROR','CRITICAL')),
  created_at    timestamptz not null default now()
);
create index if not exists idx_audit_logs_entity on audit_logs(entity_type, entity_id, created_at desc);
create index if not exists idx_audit_logs_actor on audit_logs(actor_id, created_at desc);
create index if not exists idx_audit_logs_action on audit_logs(action, created_at desc);
create index if not exists idx_audit_logs_severity on audit_logs(severity, created_at desc) where severity in ('WARNING','ERROR','CRITICAL');

commit;

-- =====================================================================
-- 0010 part: settings, commission rules, cancellation policies,
--             promotions, coupons, outbox, idempotency, rate limits
-- =====================================================================
begin;

create table if not exists settings (
  key           text primary key,
  value         jsonb not null,
  value_type    text not null default 'json' check (value_type in ('string','number','boolean','json','array')),
  group_name    text not null default 'general',
  label         text,
  description   text,
  is_public     boolean not null default false,
  is_editable   boolean not null default true,
  updated_by    uuid references admins(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_settings_group on settings(group_name);
create index if not exists idx_settings_public on settings(is_public) where is_public;

create table if not exists feature_flags (
  key           text primary key,
  enabled       boolean not null default false,
  rollout_percent smallint not null default 0 check (rollout_percent between 0 and 100),
  description   text,
  targeting     jsonb not null default '{}'::jsonb,
  updated_by    uuid references admins(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists commission_rules (
  id            uuid primary key default gen_random_uuid(),
  scope         bidly_scope not null default 'GLOBAL',
  category_id   uuid references categories(id) on delete cascade,
  subcategory_id uuid references subcategories(id) on delete cascade,
  service_id    uuid references services(id) on delete cascade,
  provider_id   uuid references providers(id) on delete cascade,
  country_code  char(2) references countries(code),
  model         bidly_commission_model not null default 'PERCENT',
  percent_bps   int check (percent_bps is null or percent_bps between 0 and 10000),
  fixed_minor   bigint check (fixed_minor is null or fixed_minor >= 0),
  min_fee_minor bigint,
  max_fee_minor bigint,
  currency      char(3) not null default 'MAD' references currencies(code),
  priority      int not null default 0,
  effective_from timestamptz not null default now(),
  effective_to  timestamptz,
  is_active     boolean not null default true,
  created_by    uuid references admins(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);
create index if not exists idx_commission_rules_scope on commission_rules(scope, is_active, priority desc);
create index if not exists idx_commission_rules_service on commission_rules(service_id) where service_id is not null;
create index if not exists idx_commission_rules_category on commission_rules(category_id) where category_id is not null;

create table if not exists cancellation_policies (
  id                  uuid primary key default gen_random_uuid(),
  scope               bidly_scope not null default 'GLOBAL',
  category_id         uuid references categories(id) on delete cascade,
  service_id          uuid references services(id) on delete cascade,
  stage               text not null,
  cancelled_by        bidly_actor_side,
  fee_model           text not null default 'NONE' check (fee_model in ('NONE','FIXED','PERCENT','SLIDING')),
  fee_percent_bps     int check (fee_percent_bps is null or fee_percent_bps between 0 and 10000),
  fee_fixed_minor     bigint,
  cap_minor           bigint,
  reliability_penalty boolean not null default false,
  currency            char(3) not null default 'MAD' references currencies(code),
  description         text,
  is_active           boolean not null default true,
  created_by          uuid references admins(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists idx_cancellation_policies_stage on cancellation_policies(stage, cancelled_by, is_active);

create table if not exists promotions (
  id              uuid primary key default gen_random_uuid(),
  code            text unique,
  name            text not null,
  description     text,
  type            bidly_promo_type not null default 'FIXED',
  value_minor     bigint,
  value_bps       int check (value_bps is null or value_bps between 0 and 10000),
  currency        char(3) not null default 'MAD' references currencies(code),
  max_discount_minor bigint,
  min_order_minor bigint not null default 0,
  category_id     uuid references categories(id) on delete set null,
  service_id      uuid references services(id) on delete set null,
  city_id         uuid references cities(id) on delete set null,
  first_order_only boolean not null default false,
  max_redemptions int,
  redeemed_count  int not null default 0,
  per_user_limit  int not null default 1,
  starts_at       timestamptz not null default now(),
  ends_at         timestamptz,
  is_active       boolean not null default true,
  created_by      uuid references admins(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
create index if not exists idx_promotions_active on promotions(is_active, starts_at, ends_at);
create index if not exists idx_promotions_code on promotions(lower(code));

create table if not exists coupons (
  id              uuid primary key default gen_random_uuid(),
  promotion_id    uuid not null references promotions(id) on delete cascade,
  code            text not null,
  user_id         uuid references users(id) on delete cascade,
  request_id      uuid references requests(id) on delete set null,
  job_id          uuid references jobs(id) on delete set null,
  discount_minor  bigint not null default 0,
  currency        char(3) not null default 'MAD' references currencies(code),
  status          text not null default 'ISSUED' check (status in ('ISSUED','RESERVED','REDEEMED','EXPIRED','CANCELLED')),
  redeemed_at     timestamptz,
  expires_at      timestamptz,
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_coupons_user on coupons(user_id, status, created_at desc);
create index if not exists idx_coupons_code on coupons(code);
create unique index if not exists uq_coupons_user_promotion on coupons(user_id, promotion_id) where status <> 'CANCELLED';

-- Transactional outbox for reliable async side effects
create table if not exists outbox_events (
  id            uuid primary key default gen_random_uuid(),
  topic         text not null,
  aggregate_type text,
  aggregate_id  uuid,
  payload       jsonb not null,
  status        bidly_outbox_status not null default 'PENDING',
  attempts      int not null default 0,
  max_attempts  int not null default 10,
  available_at  timestamptz not null default now(),
  locked_at     timestamptz,
  locked_by     text,
  processed_at  timestamptz,
  error         text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_outbox_pending on outbox_events(status, available_at) where status = 'PENDING';
create index if not exists idx_outbox_aggregate on outbox_events(aggregate_type, aggregate_id);

create table if not exists idempotency_keys (
  key             text not null,
  user_id         uuid,
  method          text not null,
  path            text not null,
  request_hash    text not null,
  status          text not null default 'IN_PROGRESS' check (status in ('IN_PROGRESS','COMPLETED','FAILED')),
  status_code     int,
  response_body   jsonb,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  expires_at      timestamptz not null default now() + interval '24 hours',
  primary key (key, method, path)
);
create index if not exists idx_idempotency_expiry on idempotency_keys(expires_at);

create table if not exists rate_limit_counters (
  bucket        text not null,
  window_start  timestamptz not null,
  count         int not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (bucket, window_start)
);

create table if not exists webhook_events (
  id              uuid primary key default gen_random_uuid(),
  provider_name   text not null,
  event_id        text,
  event_type      text,
  signature_valid boolean not null default false,
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'RECEIVED' check (status in ('RECEIVED','PROCESSED','IGNORED','FAILED')),
  processed_at    timestamptz,
  error           text,
  created_at      timestamptz not null default now()
);
create unique index if not exists uq_webhook_events_provider_event on webhook_events(provider_name, event_id) where event_id is not null;
create index if not exists idx_webhook_events_status on webhook_events(status, created_at);

create table if not exists app_logs (
  id            bigserial primary key,
  level         text not null default 'info',
  event         text not null,
  user_id       uuid,
  request_id    text,
  entity_type   text,
  entity_id     uuid,
  context       jsonb not null default '{}'::jsonb,
  duration_ms   int,
  created_at    timestamptz not null default now()
);
create index if not exists idx_app_logs_event on app_logs(event, created_at desc);
create index if not exists idx_app_logs_user on app_logs(user_id, created_at desc);
create index if not exists idx_app_logs_level on app_logs(level, created_at desc);

commit;

-- =====================================================================
-- 0011 part: state-machine guards, ledger integrity, triggers
-- =====================================================================
begin;

-- ---- Request transitions -------------------------------------------
create or replace function bidly_request_transition_allowed(p_from bidly_request_status, p_to bidly_request_status)
returns boolean language sql immutable as $$
  select case
    when p_from = p_to then true
    when p_from = 'DRAFT' then p_to in ('PUBLISHED','CANCELLED','EXPIRED')
    when p_from = 'PUBLISHED' then p_to in ('MATCHING','CANCELLED','EXPIRED','FAILED')
    when p_from = 'MATCHING' then p_to in ('RECEIVING_OFFERS','CANCELLED','EXPIRED','FAILED','PUBLISHED')
    when p_from = 'RECEIVING_OFFERS' then p_to in ('PROVIDER_SELECTED','MATCHING','CANCELLED','EXPIRED','FAILED')
    when p_from = 'PROVIDER_SELECTED' then p_to in ('CONFIRMED','RECEIVING_OFFERS','CANCELLED','FAILED')
    when p_from = 'CONFIRMED' then p_to in ('IN_PROGRESS','CANCELLED','DISPUTED','FAILED')
    when p_from = 'IN_PROGRESS' then p_to in ('COMPLETED','CANCELLED','DISPUTED','FAILED')
    when p_from = 'COMPLETED' then p_to in ('DISPUTED','REFUNDED')
    when p_from = 'DISPUTED' then p_to in ('COMPLETED','REFUNDED','CANCELLED')
    else false
  end;
$$;

create or replace function trg_requests_validate_transition() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if not bidly_request_transition_allowed(old.status, new.status) then
      raise exception 'Illegal request transition % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
    if new.status = 'PUBLISHED' and new.published_at is null then
      new.published_at := now();
    end if;
    if new.status in ('CANCELLED') and new.cancelled_at is null then
      new.cancelled_at := now();
    end if;
    if new.status = 'COMPLETED' and new.completed_at is null then
      new.completed_at := now();
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_requests_transition on requests;
create trigger trg_requests_transition before update on requests
  for each row execute function trg_requests_validate_transition();

-- ---- Offer transitions ---------------------------------------------
create or replace function bidly_offer_transition_allowed(p_from bidly_offer_status, p_to bidly_offer_status)
returns boolean language sql immutable as $$
  select case
    when p_from = p_to then true
    when p_from = 'PENDING'  then p_to in ('ACCEPTED','REJECTED','WITHDRAWN','EXPIRED','COUNTERED')
    when p_from = 'COUNTERED' then p_to in ('REJECTED','WITHDRAWN','EXPIRED','ACCEPTED')
    else false
  end;
$$;

create or replace function trg_offers_validate_transition() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if not bidly_offer_transition_allowed(old.status, new.status) then
      raise exception 'Illegal offer transition % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
    if new.status = 'ACCEPTED' then new.accepted_at := coalesce(new.accepted_at, now()); end if;
    if new.status = 'REJECTED' then new.rejected_at := coalesce(new.rejected_at, now()); end if;
    if new.status = 'WITHDRAWN' then new.withdrawn_at := coalesce(new.withdrawn_at, now()); end if;
    if new.status = 'COUNTERED' then new.countered_at := coalesce(new.countered_at, now()); end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_offers_transition on offers;
create trigger trg_offers_transition before update on offers
  for each row execute function trg_offers_validate_transition();

-- Snapshot every offer version into offer_history
create or replace function trg_offers_history() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into offer_history (offer_id, request_id, provider_id, version, change_type,
      price_minor, currency, message, eta_minutes, status, actor_id, actor_role, snapshot)
    values (new.id, new.request_id, new.provider_id, new.version, 'CREATED',
      new.price_minor, new.currency, new.message, new.eta_minutes, new.status,
      null, 'PROVIDER', to_jsonb(new));
  else
    if new.price_minor is distinct from old.price_minor
       or new.message is distinct from old.message
       or new.eta_minutes is distinct from old.eta_minutes
       or new.status is distinct from old.status
       or new.version is distinct from old.version then
      insert into offer_history (offer_id, request_id, provider_id, version, change_type,
        price_minor, currency, message, eta_minutes, status, actor_id, actor_role, snapshot)
      values (new.id, new.request_id, new.provider_id, new.version,
        case when new.status is distinct from old.status then 'STATUS_CHANGE' else 'UPDATED' end,
        new.price_minor, new.currency, new.message, new.eta_minutes, new.status,
        null, 'SYSTEM', to_jsonb(new));
    end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_offers_history on offers;
create trigger trg_offers_history after insert or update on offers
  for each row execute function trg_offers_history();

-- ---- Job transitions -------------------------------------------------
create or replace function bidly_job_transition_allowed(p_from bidly_job_status, p_to bidly_job_status)
returns boolean language sql immutable as $$
  select case
    when p_from = p_to then true
    when p_from = 'CREATED' then p_to in ('CONFIRMED','CANCELLED','FAILED')
    when p_from = 'CONFIRMED' then p_to in ('PROVIDER_EN_ROUTE','IN_PROGRESS','CANCELLED','DISPUTED','FAILED')
    when p_from = 'PROVIDER_EN_ROUTE' then p_to in ('PROVIDER_ARRIVED','CANCELLED','DISPUTED','FAILED')
    when p_from = 'PROVIDER_ARRIVED' then p_to in ('IN_PROGRESS','CANCELLED','DISPUTED','FAILED')
    when p_from = 'IN_PROGRESS' then p_to in ('COMPLETED','CANCELLED','DISPUTED','FAILED')
    when p_from = 'COMPLETED' then p_to in ('PAYMENT_PENDING','DISPUTED','PAID')
    when p_from = 'PAYMENT_PENDING' then p_to in ('PAID','FAILED','DISPUTED')
    when p_from = 'PAID' then p_to in ('DISPUTED','REFUNDED')
    when p_from = 'DISPUTED' then p_to in ('PAID','REFUNDED','COMPLETED','CANCELLED')
    else false
  end;
$$;

create or replace function trg_jobs_validate_transition() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if not bidly_job_transition_allowed(old.status, new.status) then
      raise exception 'Illegal job transition % -> %', old.status, new.status
        using errcode = 'check_violation';
    end if;
    if new.status = 'IN_PROGRESS' and new.started_at is null then new.started_at := now(); end if;
    if new.status = 'PROVIDER_ARRIVED' and new.arrived_at is null then new.arrived_at := now(); end if;
    if new.status = 'COMPLETED' and new.completed_at is null then new.completed_at := now(); end if;
    if new.status = 'CANCELLED' and new.cancelled_at is null then new.cancelled_at := now(); end if;
  end if;
  return new;
end $$;

drop trigger if exists trg_jobs_transition on jobs;
create trigger trg_jobs_transition before update on jobs
  for each row execute function trg_jobs_validate_transition();

-- Log job status changes into job_events
create or replace function trg_jobs_event() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    insert into job_events (job_id, request_id, type, to_status, actor_role, payload)
    values (new.id, new.request_id, 'JOB_CREATED', new.status, 'SYSTEM',
      jsonb_build_object('final_price_minor', new.final_price_minor, 'currency', new.currency));
  elsif new.status is distinct from old.status then
    insert into job_events (job_id, request_id, type, from_status, to_status, actor_role)
    values (new.id, new.request_id, 'STATUS_CHANGE', old.status, new.status, 'SYSTEM');
  end if;
  return new;
end $$;

drop trigger if exists trg_jobs_event on jobs;
create trigger trg_jobs_event after insert or update on jobs
  for each row execute function trg_jobs_event();

-- ---- Ledger integrity ------------------------------------------------
-- balance_after_minor must equal the wallet balance *after* applying the
-- movement referenced by this row (checked against the pre-movement value).
create or replace function trg_wallet_txn_validate() returns trigger
language plpgsql as $$
declare
  v_available bigint;
  v_pending   bigint;
  v_expected  bigint;
begin
  select available_minor, pending_minor into v_available, v_pending
    from wallets where id = new.wallet_id for update;
  if v_available is null then
    raise exception 'Wallet % not found', new.wallet_id;
  end if;

  if new.direction = 'CREDIT' then
    v_expected := v_available + new.amount_minor;
  else
    v_expected := v_available - new.amount_minor;
  end if;

  if v_expected < 0 then
    raise exception 'Ledger integrity: wallet % would go negative (% - %)',
      new.wallet_id, v_available, new.amount_minor using errcode = 'check_violation';
  end if;

  if new.balance_after_minor <> v_expected then
    raise exception 'Ledger integrity: balance_after_minor (%) does not equal expected (%)',
      new.balance_after_minor, v_expected using errcode = 'check_violation';
  end if;

  if new.pending_after_minor is null then
    new.pending_after_minor := v_pending;
  end if;
  return new;
end $$;

-- The API must move money through wallet_transactions only. To keep the
-- invariant checkable, this trigger fires before insert and freezes the
-- wallet row is handled by the application transaction.
drop trigger if exists trg_wallet_txn_validate on wallet_transactions;
create trigger trg_wallet_txn_validate before insert on wallet_transactions
  for each row execute function trg_wallet_txn_validate();

create or replace function trg_wallet_txn_append_only() returns trigger
language plpgsql as $$ begin
  raise exception 'wallet_transactions is append-only' using errcode = 'check_violation';
end $$;

drop trigger if exists trg_wallet_txn_append_only on wallet_transactions;
create trigger trg_wallet_txn_append_only before update or delete on wallet_transactions
  for each row execute function trg_wallet_txn_append_only();

-- Keep wallet counters in sync with the ledger
create or replace function trg_wallet_txn_apply() returns trigger
language plpgsql as $$
begin
  if new.direction = 'CREDIT' then
    update wallets
      set available_minor = available_minor + new.amount_minor,
          lifetime_in_minor = lifetime_in_minor + new.amount_minor,
          version = version + 1,
          updated_at = now()
      where id = new.wallet_id;
  else
    update wallets
      set available_minor = available_minor - new.amount_minor,
          lifetime_out_minor = lifetime_out_minor + new.amount_minor,
          version = version + 1,
          updated_at = now()
      where id = new.wallet_id;
  end if;
  return new;
end $$;

drop trigger if exists trg_wallet_txn_apply on wallet_transactions;
create trigger trg_wallet_txn_apply after insert on wallet_transactions
  for each row execute function trg_wallet_txn_apply();

-- ---- Refund cap -----------------------------------------------------
create or replace function trg_refund_cap() returns trigger
language plpgsql as $$
declare
  v_captured bigint;
  v_refunded bigint;
begin
  select captured_minor into v_captured from payments where id = new.payment_id;
  if v_captured is null then
    raise exception 'Payment % not found', new.payment_id;
  end if;
  select coalesce(sum(amount_minor), 0) into v_refunded
    from refunds
    where payment_id = new.payment_id
      and status in ('APPROVED','PROCESSING','COMPLETED')
      and id <> new.id;
  if v_refunded + new.amount_minor > v_captured then
    raise exception 'Refund cap exceeded: % + % > captured %',
      v_refunded, new.amount_minor, v_captured using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists trg_refund_cap on refunds;
create trigger trg_refund_cap before insert or update of amount_minor, status on refunds
  for each row execute function trg_refund_cap();

create or replace function trg_refund_is_partial() returns trigger
language plpgsql as $$
begin
  new.is_partial := new.amount_minor < (select amount_minor from payments where id = new.payment_id);
  return new;
end $$;

drop trigger if exists trg_refund_is_partial on refunds;
create trigger trg_refund_is_partial before insert or update of amount_minor on refunds
  for each row execute function trg_refund_is_partial();

-- ---- Append-only guards ---------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['offer_history','negotiations','job_events','payment_transactions','audit_logs','admin_actions','app_logs'] loop
    execute format('drop trigger if exists trg_%s_append_only on %I', t, t);
    execute format(
      'create trigger trg_%s_append_only before update or delete on %I
         for each row execute function deny_mutation()', t, t);
  end loop;
end $$;

commit;

-- =====================================================================
-- 0012 part: updated_at triggers, offer-count maintenance, RLS
-- =====================================================================
begin;

-- Attach updated_at trigger to every table that has the column
do $$
declare r record;
begin
  for r in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'updated_at' and not a.attisdropped
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname <> 'schema_migrations'
  loop
    perform attach_updated_at(r.oid::regclass);
  end loop;
end $$;

-- Keep requests.offer_count accurate
create or replace function trg_offers_count() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' and new.status <> 'WITHDRAWN' then
    update requests set offer_count = offer_count + 1,
      status = case when status in ('PUBLISHED','MATCHING') then 'RECEIVING_OFFERS'::bidly_request_status else status end,
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

-- Provider review aggregates
create or replace function trg_reviews_aggregate() returns trigger
language plpgsql as $$
declare v_provider uuid; v_avg numeric; v_cnt int;
begin
  v_provider := coalesce(new.provider_id, old.provider_id);
  if v_provider is null then return coalesce(new, old); end if;
  select round(avg(rating)::numeric, 2), count(*) into v_avg, v_cnt
    from reviews where provider_id = v_provider and is_visible;
  update providers
    set rating_avg = coalesce(v_avg, 0),
        rating_count = coalesce(v_cnt, 0),
        reviews_count = coalesce(v_cnt, 0),
        updated_at = now()
    where id = v_provider;
  return coalesce(new, old);
end $$;

drop trigger if exists trg_reviews_aggregate on reviews;
create trigger trg_reviews_aggregate after insert or update or delete on reviews
  for each row execute function trg_reviews_aggregate();

-- Conversation last-message bookkeeping
create or replace function trg_messages_touch_conversation() returns trigger
language plpgsql as $$
begin
  update conversations
    set last_message_at = new.created_at,
        last_message_preview = left(coalesce(new.body, '[' || new.kind || ']'), 160),
        last_message_sender_id = new.sender_id,
        a_unread_count = case when participant_a <> coalesce(new.sender_id, participant_a) then a_unread_count + 1 else a_unread_count end,
        b_unread_count = case when participant_b <> coalesce(new.sender_id, participant_b) then b_unread_count + 1 else b_unread_count end,
        updated_at = now()
    where id = new.conversation_id;
  return new;
end $$;

drop trigger if exists trg_messages_touch_conversation on messages;
create trigger trg_messages_touch_conversation after insert on messages
  for each row execute function trg_messages_touch_conversation();

commit;

-- =====================================================================
-- 0013 part: Row Level Security
-- The API uses the service role and bypasses RLS by design; these
-- policies are the defence-in-depth layer for anon/authenticated keys.
-- =====================================================================
begin;

alter table users                    enable row level security;
alter table user_profiles            enable row level security;
alter table user_addresses           enable row level security;
alter table auth_sessions            enable row level security;
alter table verification_tokens      enable row level security;
alter table devices                  enable row level security;
alter table providers                enable row level security;
alter table provider_services        enable row level security;
alter table provider_documents       enable row level security;
alter table provider_locations       enable row level security;
alter table provider_service_areas   enable row level security;
alter table availability             enable row level security;
alter table verification_records     enable row level security;
alter table requests                 enable row level security;
alter table request_answers          enable row level security;
alter table request_media            enable row level security;
alter table match_runs               enable row level security;
alter table match_candidates         enable row level security;
alter table offers                   enable row level security;
alter table offer_history            enable row level security;
alter table negotiations             enable row level security;
alter table jobs                     enable row level security;
alter table job_events               enable row level security;
alter table conversations            enable row level security;
alter table messages                 enable row level security;
alter table reviews                  enable row level security;
alter table payments                 enable row level security;
alter table payment_transactions     enable row level security;
alter table refunds                  enable row level security;
alter table wallets                  enable row level security;
alter table wallet_transactions      enable row level security;
alter table payouts                  enable row level security;
alter table disputes                 enable row level security;
alter table dispute_evidence         enable row level security;
alter table notifications            enable row level security;
alter table notification_preferences enable row level security;
alter table support_tickets          enable row level security;
alter table support_messages         enable row level security;
alter table admins                   enable row level security;
alter table admin_sessions           enable row level security;
alter table admin_actions            enable row level security;
alter table audit_logs               enable row level security;
alter table settings                 enable row level security;
alter table feature_flags            enable row level security;
alter table commission_rules         enable row level security;
alter table cancellation_policies    enable row level security;
alter table promotions               enable row level security;
alter table coupons                  enable row level security;
alter table outbox_events            enable row level security;
alter table idempotency_keys         enable row level security;
alter table rate_limit_counters      enable row level security;
alter table webhook_events           enable row level security;
alter table app_logs                 enable row level security;
alter table platform_earnings        enable row level security;
alter table price_stats              enable row level security;

-- Helper: the current authenticated user id
create or replace function auth_uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;

-- --- own-row tables ---------------------------------------------------
drop policy if exists users_select_own on users;
create policy users_select_own on users for select using (id = auth_uid());
drop policy if exists users_update_own on users;
create policy users_update_own on users for update using (id = auth_uid()) with check (id = auth_uid());

drop policy if exists profiles_select_own on user_profiles;
create policy profiles_select_own on user_profiles for select using (user_id = auth_uid());
drop policy if exists profiles_write_own on user_profiles;
create policy profiles_write_own on user_profiles for all using (user_id = auth_uid()) with check (user_id = auth_uid());

drop policy if exists addresses_own on user_addresses;
create policy addresses_own on user_addresses for all using (user_id = auth_uid()) with check (user_id = auth_uid());

drop policy if exists sessions_own on auth_sessions;
create policy sessions_own on auth_sessions for select using (user_id = auth_uid());
drop policy if exists vtok_own on verification_tokens;
create policy vtok_own on verification_tokens for select using (user_id = auth_uid());
drop policy if exists devices_own on devices;
create policy devices_own on devices for all using (user_id = auth_uid()) with check (user_id = auth_uid());

-- --- providers --------------------------------------------------------
drop policy if exists providers_public_read on providers;
create policy providers_public_read on providers for select
  using (status = 'ACTIVE' and deleted_at is null);
drop policy if exists providers_owner_write on providers;
create policy providers_owner_write on providers for all
  using (user_id = auth_uid()) with check (user_id = auth_uid());

do $$
declare t text;
begin
  foreach t in array array['provider_services','provider_documents','provider_locations',
                            'provider_service_areas','availability','verification_records'] loop
    execute format('drop policy if exists %s_owner on %I', t, t);
    execute format(
      'create policy %s_owner on %I for all using (
         exists (select 1 from providers p where p.id = provider_id and p.user_id = auth_uid())
       ) with check (
         exists (select 1 from providers p where p.id = provider_id and p.user_id = auth_uid())
       )', t, t);
  end loop;
end $$;

drop policy if exists provider_services_public on provider_services;
create policy provider_services_public on provider_services for select
  using (exists (select 1 from providers p where p.id = provider_id and p.status = 'ACTIVE'));

-- --- requests ---------------------------------------------------------
drop policy if exists requests_customer_own on requests;
create policy requests_customer_own on requests for all
  using (customer_id = auth_uid()) with check (customer_id = auth_uid());

drop policy if exists request_answers_owner on request_answers;
create policy request_answers_owner on request_answers for all using (
  exists (select 1 from requests r where r.id = request_id and r.customer_id = auth_uid())
) with check (
  exists (select 1 from requests r where r.id = request_id and r.customer_id = auth_uid())
);

drop policy if exists request_media_owner on request_media;
create policy request_media_owner on request_media for all using (uploader_id = auth_uid())
  with check (uploader_id = auth_uid());

drop policy if exists match_runs_owner on match_runs;
create policy match_runs_owner on match_runs for select using (
  exists (select 1 from requests r where r.id = request_id and r.customer_id = auth_uid())
);
drop policy if exists match_candidates_party on match_candidates;
create policy match_candidates_party on match_candidates for select using (
  exists (select 1 from requests r where r.id = request_id and r.customer_id = auth_uid())
  or exists (select 1 from providers p where p.id = provider_id and p.user_id = auth_uid())
);

-- --- offers / negotiation --------------------------------------------
drop policy if exists offers_party_read on offers;
create policy offers_party_read on offers for select using (
  exists (select 1 from requests r where r.id = request_id and r.customer_id = auth_uid())
  or exists (select 1 from providers p where p.id = provider_id and p.user_id = auth_uid())
);
drop policy if exists offers_provider_write on offers;
create policy offers_provider_write on offers for insert with check (
  exists (select 1 from providers p where p.id = provider_id and p.user_id = auth_uid())
);
drop policy if exists offers_provider_update on offers;
create policy offers_provider_update on offers for update using (
  exists (select 1 from providers p where p.id = provider_id and p.user_id = auth_uid())
);

drop policy if exists offer_history_party on offer_history;
create policy offer_history_party on offer_history for select using (
  exists (select 1 from requests r where r.id = request_id and r.customer_id = auth_uid())
  or exists (select 1 from providers p where p.id = provider_id and p.user_id = auth_uid())
);

drop policy if exists negotiations_party on negotiations;
create policy negotiations_party on negotiations for select using (
  exists (select 1 from requests r where r.id = request_id and r.customer_id = auth_uid())
  or exists (select 1 from offers o join providers p on p.id = o.provider_id
             where o.id = offer_id and p.user_id = auth_uid())
);

-- --- jobs / chat / reviews -------------------------------------------
drop policy if exists jobs_party on jobs;
create policy jobs_party on jobs for select using (
  customer_id = auth_uid()
  or exists (select 1 from providers p where p.id = provider_id and p.user_id = auth_uid())
);

drop policy if exists job_events_party on job_events;
create policy job_events_party on job_events for select using (
  exists (select 1 from jobs j where j.id = job_id and (
    j.customer_id = auth_uid()
    or exists (select 1 from providers p where p.id = j.provider_id and p.user_id = auth_uid())
  ))
);

drop policy if exists conversations_party on conversations;
create policy conversations_party on conversations for select using (
  participant_a = auth_uid() or participant_b = auth_uid()
);

drop policy if exists messages_party on messages;
create policy messages_party on messages for select using (
  exists (select 1 from conversations c where c.id = conversation_id
          and (c.participant_a = auth_uid() or c.participant_b = auth_uid()))
);
drop policy if exists messages_send on messages;
create policy messages_send on messages for insert with check (
  sender_id = auth_uid()
  and exists (select 1 from conversations c where c.id = conversation_id
              and (c.participant_a = auth_uid() or c.participant_b = auth_uid()))
);

drop policy if exists reviews_public_read on reviews;
create policy reviews_public_read on reviews for select using (is_visible);
drop policy if exists reviews_author_write on reviews;
create policy reviews_author_write on reviews for insert with check (author_id = auth_uid());
drop policy if exists reviews_author_update on reviews;
create policy reviews_author_update on reviews for update using (author_id = auth_uid());

-- --- money ------------------------------------------------------------
drop policy if exists payments_party on payments;
create policy payments_party on payments for select using (
  customer_id = auth_uid()
  or exists (select 1 from providers p where p.id = provider_id and p.user_id = auth_uid())
);
drop policy if exists payment_txns_party on payment_transactions;
create policy payment_txns_party on payment_transactions for select using (
  exists (select 1 from payments pm where pm.id = payment_id and (
    pm.customer_id = auth_uid()
    or exists (select 1 from providers p where p.id = pm.provider_id and p.user_id = auth_uid())
  ))
);
drop policy if exists refunds_party on refunds;
create policy refunds_party on refunds for select using (
  exists (select 1 from payments pm where pm.id = payment_id and (
    pm.customer_id = auth_uid()
    or exists (select 1 from providers p where p.id = pm.provider_id and p.user_id = auth_uid())
  ))
);
drop policy if exists wallets_owner on wallets;
create policy wallets_owner on wallets for select using (owner_id = auth_uid());
drop policy if exists wallet_txns_owner on wallet_transactions;
create policy wallet_txns_owner on wallet_transactions for select using (
  exists (select 1 from wallets w where w.id = wallet_id and w.owner_id = auth_uid())
);
drop policy if exists payouts_owner on payouts;
create policy payouts_owner on payouts for select using (user_id = auth_uid());

-- --- disputes / support / notifications ------------------------------
drop policy if exists disputes_party on disputes;
create policy disputes_party on disputes for select using (
  opened_by = auth_uid() or against_id = auth_uid()
);
drop policy if exists dispute_evidence_party on dispute_evidence;
create policy dispute_evidence_party on dispute_evidence for select using (
  exists (select 1 from disputes d where d.id = dispute_id and (d.opened_by = auth_uid() or d.against_id = auth_uid()))
);
drop policy if exists notifications_own on notifications;
create policy notifications_own on notifications for all using (user_id = auth_uid()) with check (user_id = auth_uid());
drop policy if exists notif_prefs_own on notification_preferences;
create policy notif_prefs_own on notification_preferences for all using (user_id = auth_uid()) with check (user_id = auth_uid());
drop policy if exists tickets_own on support_tickets;
create policy tickets_own on support_tickets for all using (user_id = auth_uid()) with check (user_id = auth_uid());
drop policy if exists ticket_msgs_party on support_messages;
create policy ticket_msgs_party on support_messages for select using (
  exists (select 1 from support_tickets t where t.id = ticket_id and t.user_id = auth_uid())
);

-- --- public config read ----------------------------------------------
drop policy if exists categories_public on categories;
create policy categories_public on categories for select using (is_active);
drop policy if exists subcategories_public on subcategories;
create policy subcategories_public on subcategories for select using (is_active);
drop policy if exists services_public on services;
create policy services_public on services for select using (is_active);
drop policy if exists service_fields_public on service_fields;
create policy service_fields_public on service_fields for select using (is_active);
drop policy if exists service_field_options_public on service_field_options;
create policy service_field_options_public on service_field_options for select using (is_active);
drop policy if exists currencies_public on currencies;
create policy currencies_public on currencies for select using (is_active);
drop policy if exists countries_public on countries;
create policy countries_public on countries for select using (is_active);
drop policy if exists cities_public on cities;
create policy cities_public on cities for select using (is_active);
drop policy if exists service_areas_public on service_areas;
create policy service_areas_public on service_areas for select using (is_active);
drop policy if exists settings_public on settings;
create policy settings_public on settings for select using (is_public);
drop policy if exists promotions_public on promotions;
create policy promotions_public on promotions for select using (is_active);
drop policy if exists feature_flags_public on feature_flags;
create policy feature_flags_public on feature_flags for select using (true);

-- Everything not covered above (admins, audit_logs, outbox, idempotency,
-- webhook_events, app_logs, commission_rules, cancellation_policies,
-- platform_earnings, price_stats, rate_limit_counters, admin_*): RLS is
-- enabled with NO policy, which denies all anon/authenticated access.
-- Only the service role (the BIDLY API) can touch them.

-- Record the migration
insert into schema_migrations (version, name, checksum)
values ('0001', 'init', 'bidly-init-v1')
on conflict (version) do nothing;

commit;

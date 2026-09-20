-- =====================================================================
-- 0006 — verification_records can belong to a user, not only a provider
--
-- The table was modelled for provider onboarding, so `provider_id` is NOT
-- NULL. But the same table is the natural home for the email/WhatsApp/identity
-- checks an operator flips per *account*, and a plain CUSTOMER has no
-- `providers` row at all. Admin verification of such an account failed with
-- 23502 (null value in column "provider_id").
--
-- `user_id` already exists and is nullable; making `provider_id` nullable lets
-- a record be anchored to either side:
--   * provider onboarding  → provider_id set
--   * account verification → user_id set
-- The existing composite index (provider_id, type, status) still serves the
-- provider lookups; a new index covers the user-side lookups the admin console
-- now does on every accounts page load.
-- =====================================================================

begin;

alter table verification_records alter column provider_id drop not null;

create index if not exists idx_verification_records_user
  on verification_records(user_id, type, status);

-- One live (PENDING/VERIFIED) record per user+type+channel. Partial so
-- historical EXPIRED/REJECTED rows never block a fresh check.
create unique index if not exists uq_verification_records_live
  on verification_records (user_id, type, coalesce(payload->>'channel', ''))
  where user_id is not null and status in ('PENDING', 'VERIFIED');

commit;

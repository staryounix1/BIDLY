# BIDLY — 04. Database ERD & Invariants

PostgreSQL 17. All tables live in the `public` schema, use `uuid` primary keys (UUIDv7 where the
runtime generates them, `gen_random_uuid()` as a fallback default), `timestamptz` for time, and
`bigint` minor units for money.

## 4.1 Domain map

```
IDENTITY & ACCESS
  users ──1:1── user_profiles
    │                 │
    │                 └──1:N── user_addresses
    ├──1:1── providers ──1:N── provider_services ──N:1── services
    │           ├──1:N── provider_documents
    │           ├──1:N── provider_locations
    │           ├──1:N── provider_service_areas
    │           ├──1:N── availability
    │           └──1:N── verification_records
    ├──1:1── wallets ──1:N── wallet_transactions
    └──1:N── notifications / devices / sessions

CATALOG (all database-driven, never hard-coded in the UI)
  countries ──1:N── currencies
  categories ──1:N── subcategories ──1:N── services
  services ──1:N── service_fields ──1:N── service_field_options
  services ──1:N── service_areas (geo coverage)
  settings (key/value, typed), commission_rules, cancellation_policies

DEMAND
  requests ──1:N── request_answers / request_media
  requests ──1:N── offers ──1:N── offer_history
  offers   ──1:N── negotiations (append-only)

SUPPLY / EXECUTION
  jobs ──1:N── job_events (append-only)
  jobs ──1:N── conversations ──1:N── messages
  jobs ──1:N── reviews (one per direction)
  jobs ──1:1── payments ──1:N── payment_transactions / refunds

MONEY (double-entry-ish ledger, append-only)
  wallets ──1:N── wallet_transactions
  providers ──1:N── payouts
  payments ──1:N── refunds

TRUST & OPS
  disputes, support_tickets, audit_logs, admin_users, admin_actions,
  promotions, coupons, outbox_events, idempotency_keys
```

## 4.2 Table catalogue (39 domain tables + 5 platform tables)

| # | Table | Purpose | Key columns |
|---|---|---|---|
| 1 | `users` | identity root | `id`, `email`, `phone`, `password_hash`, `role`, `status`, `email_verified_at`, `phone_verified_at`, `deleted_at` |
| 2 | `user_profiles` | display data | `user_id` (PK), `full_name`, `avatar_url`, `locale`, `preferred_currency`, `timezone` |
| 3 | `user_addresses` | saved places | `user_id`, `label`, `line1`, `city`, `region`, `country_code`, `lat`, `lng`, `is_default` |
| 4 | `sessions` | refresh-token families | `user_id`, `refresh_token_hash`, `family_id`, `expires_at`, `revoked_at`, `ip`, `user_agent` |
| 5 | `verification_tokens` | email/phone/reset OTPs | `user_id`, `purpose`, `token_hash`, `channel`, `expires_at`, `consumed_at`, `attempt_count` |
| 6 | `devices` | push registrations | `user_id`, `platform`, `push_token`, `last_seen_at` |
| 7 | `providers` | provider entity | `user_id` (unique), `display_name`, `bio`, `status`, `verification_status`, `rating_avg`, `rating_count`, `completed_jobs`, `response_rate_bps`, `cancellation_rate_bps`, `wallet_id` |
| 8 | `provider_services` | offerable services | `provider_id`, `service_id`, `pricing_model`, `base_price_minor`, `min_price_minor`, `max_price_minor`, `base_currency`, `is_active` |
| 9 | `provider_documents` | KYC / licences | `provider_id`, `type`, `file_url`, `status`, `reviewed_by`, `reviewed_at`, `rejection_reason`, `expires_at` |
| 10 | `provider_locations` | live/base position | `provider_id`, `lat`, `lng`, `geohash`, `accuracy_m`, `is_online`, `recorded_at` |
| 11 | `provider_service_areas` | coverage | `provider_id`, `city_id`/`service_area_id`, `radius_km`, `center_lat`, `center_lng` |
| 12 | `availability` | weekly slots + exceptions | `provider_id`, `weekday`, `start_time`, `end_time`, `is_exception`, `exception_date` |
| 13 | `countries` | market config | `code` (PK), `name`, `default_currency`, `default_locale`, `timezone`, `dial_code`, `is_active` |
| 14 | `currencies` | currency config | `code` (PK), `name`, `symbol`, `minor_units`, `is_active` |
| 15 | `cities` | launch market | `id`, `country_code`, `name`, `slug`, `lat`, `lng`, `timezone`, `is_active` |
| 16 | `service_areas` | geo polygon / radius | `id`, `city_id`, `name`, `kind` (`radius`/`polygon`), `center_lat`, `center_lng`, `radius_km`, `geojson` |
| 17 | `categories` | top level | `id`, `slug`, `name_en`, `name_fr`, `name_ar`, `icon`, `sort_order`, `is_active` |
| 18 | `subcategories` | second level | `id`, `category_id`, `slug`, `name_*`, `sort_order`, `is_active` |
| 19 | `services` | offerable unit | `id`, `subcategory_id`, `slug`, `name_*`, `description_*`, `pricing_model`, `default_currency`, `min_price_minor`, `max_price_minor`, `requires_location`, `requires_destination`, `duration_minutes`, `is_active` |
| 20 | `service_fields` | dynamic form schema | `id`, `service_id`, `key`, `label_*`, `type`, `is_required`, `sort_order`, `min_value`, `max_value`, `regex`, `default_value`, `depends_on_key`, `depends_on_value`, `validation` (jsonb) |
| 21 | `service_field_options` | enum choices | `id`, `field_id`, `value`, `label_*`, `sort_order`, `is_active` |
| 22 | `requests` | demand unit | `id`, `code`, `customer_id`, `category_id`, `subcategory_id`, `service_id`, `title`, `description`, `answers` (jsonb), `status`, `pricing_model`, `budget_min_minor`, `budget_max_minor`, `currency`, `pickup_*`, `destination_*`, `scheduled_at`, `expires_at`, `published_at`, `city_id`, `service_area_id`, `offer_count`, `selected_offer_id`, `job_id`, `cancellation_reason`, `cancelled_at`, `deleted_at` |
| 23 | `request_answers` | normalised dynamic answers | `request_id`, `field_id`, `field_key`, `value_text`, `value_number`, `value_boolean`, `value_date`, `value_json`, `value_option_ids` |
| 24 | `request_media` | attachments | `request_id`, `uploader_id`, `kind`, `url`, `mime_type`, `size_bytes`, `width`, `height`, `checksum` |
| 25 | `offers` | provider bid | `id`, `request_id`, `provider_id`, `price_minor`, `currency`, `message`, `eta_minutes`, `availability_starts_at`, `status`, `expires_at`, `is_auto`, `parent_offer_id`, `version`, `accepted_at`, `withdrawn_at` |
| 26 | `offer_history` | immutable offer snapshots | `offer_id`, `version`, `price_minor`, `currency`, `message`, `eta_minutes`, `status`, `actor_id`, `change_type`, `snapshot` (jsonb) |
| 27 | `negotiations` | append-only counter-offer thread | `offer_id`, `request_id`, `actor_id`, `actor_role`, `direction` (`customer`/`provider`), `type` (`counter`/`accept`/`reject`/`withdraw`/`message`), `price_minor`, `currency`, `message`, `created_at` |
| 28 | `jobs` | accepted engagement | `id`, `code`, `request_id` (unique), `customer_id`, `provider_id`, `accepted_offer_id`, `final_price_minor`, `currency`, `commission_minor`, `commission_snapshot` (jsonb), `status`, `payment_status`, `pickup_*`, `destination_*`, `scheduled_at`, `start_otp_hash`, `started_at`, `completed_at`, `confirmed_at`, `cancelled_by`, `cancellation_reason`, `cancellation_fee_minor`, `dispute_id`, `deleted_at` |
| 29 | `job_events` | append-only lifecycle log | `job_id`, `type`, `actor_id`, `actor_role`, `from_status`, `to_status`, `payload` (jsonb), `lat`, `lng`, `created_at` |
| 30 | `conversations` | per-job/request thread | `id`, `request_id`, `job_id`, `participant_a`, `participant_b`, `last_message_at`, `last_message_preview`, `a_unread`, `b_unread`, `status` |
| 31 | `messages` | chat | `id`, `conversation_id`, `sender_id`, `body`, `kind`, `attachment_url`, `meta` (jsonb), `read_at`, `deleted_at` |
| 32 | `reviews` | mutual ratings | `id`, `job_id`, `author_id`, `subject_id`, `direction`, `rating`, `comment`, `tags` (text[]), `is_visible`, `moderated_by`, `moderated_at` |
| 33 | `payments` | intent per job | `id`, `job_id` (unique), `request_id`, `customer_id`, `provider_id`, `provider_name`, `provider_ref`, `method`, `status`, `amount_minor`, `currency`, `commission_minor`, `provider_net_minor`, `authorized_at`, `captured_at`, `failed_at`, `failure_code`, `metadata` (jsonb) |
| 34 | `payment_transactions` | PSP calls | `id`, `payment_id`, `type` (`authorize`/`capture`/`void`/`refund`/`webhook`), `provider_ref`, `amount_minor`, `currency`, `status`, `raw_payload` (jsonb, redacted), `idempotency_key`, `created_at` |
| 35 | `wallets` | one per provider/user | `id`, `owner_id` (unique), `owner_type`, `currency`, `available_minor`, `pending_minor`, `lifetime_in_minor`, `lifetime_out_minor`, `version`, timestamps |
| 36 | `wallet_transactions` | append-only ledger | `id`, `wallet_id`, `type`, `direction` (`credit`/`debit`), `amount_minor`, `currency`, `balance_after_minor`, `reference_type`, `reference_id`, `group_id`, `description`, `created_at` |
| 37 | `payouts` | withdrawals | `id`, `provider_id`, `wallet_id`, `amount_minor`, `currency`, `method`, `destination_masked`, `status`, `requested_at`, `processed_at`, `provider_ref`, `failure_reason`, `approved_by` |
| 38 | `refunds` | refund records | `id`, `payment_id`, `job_id`, `amount_minor`, `currency`, `reason`, `status`, `requested_by`, `approved_by`, `provider_ref`, `is_partial`, `created_at`, `processed_at` |
| 39 | `disputes` | job conflicts | `id`, `job_id`, `opened_by`, `against_id`, `reason`, `description`, `status`, `resolution`, `resolution_amount_minor`, `assigned_admin_id`, `opened_at`, `resolved_at` |
| 40 | `dispute_evidence` | attachments | `dispute_id`, `uploader_id`, `kind`, `url`, `note` |
| 41 | `notifications` | in-app feed | `id`, `user_id`, `type`, `title_*`, `body_*`, `data` (jsonb), `channel`, `read_at`, `sent_at`, `status` |
| 42 | `support_tickets` | help desk | `id`, `user_id`, `subject`, `category`, `status`, `priority`, `assigned_admin_id`, `job_id`, `closed_at` |
| 43 | `support_messages` | ticket thread | `ticket_id`, `sender_id`, `sender_role`, `body`, `attachment_url` |
| 44 | `admin_users` | staff identity | `id`, `user_id` (unique), `email`, `role` (`SUPER_ADMIN`/`ADMIN`/`MODERATOR`/`FINANCE`/`SUPPORT`), `permissions` (text[]), `mfa_enabled`, `last_login_at`, `is_active` |
| 45 | `admin_actions` | privileged operations | `id`, `admin_id`, `action`, `target_type`, `target_id`, `before` (jsonb), `after` (jsonb), `reason`, `ip`, `created_at` |
| 46 | `audit_logs` | security trail | `id`, `actor_id`, `actor_role`, `action`, `entity_type`, `entity_id`, `changes` (jsonb), `ip`, `user_agent`, `severity`, `created_at` |
| 47 | `settings` | typed config | `key` (PK), `value` (jsonb), `value_type`, `group`, `description`, `is_public`, `updated_by`, timestamps |
| 48 | `commission_rules` | commission config | `id`, `scope` (`global`/`category`/`service`/`provider`), `category_id`, `service_id`, `provider_id`, `model` (`percent`/`fixed`/`percent_plus_fixed`), `percent_bps`, `fixed_minor`, `min_fee_minor`, `max_fee_minor`, `currency`, `priority`, `effective_from`, `effective_to`, `is_active` |
| 49 | `cancellation_policies` | cancellation rules | `id`, `scope`, `category_id`, `service_id`, `stage`, `cancelled_by`, `fee_model`, `fee_percent_bps`, `fee_fixed_minor`, `cap_minor`, `reliability_penalty`, `currency`, `is_active` |
| 50 | `promotions` | campaigns | `id`, `code`, `name`, `type`, `value`, `currency`, `starts_at`, `ends_at`, `max_redemptions`, `per_user_limit`, `min_order_minor`, `is_active` |
| 51 | `coupons` | user redemptions | `id`, `promotion_id`, `code`, `user_id`, `redeemed_at`, `discount_minor`, `currency`, `request_id` |
| 52 | `verification_records` | KYC workflow | `id`, `provider_id`, `type`, `document_id`, `status`, `submitted_at`, `reviewed_at`, `reviewed_by`, `notes`, `expires_at` |
| 53 | `outbox_events` | transactional outbox | `id`, `topic`, `payload` (jsonb), `status`, `attempts`, `available_at`, `processed_at`, `error` |
| 54 | `idempotency_keys` | request dedupe | `key`, `user_id`, `method`, `path`, `request_hash`, `status_code`, `response_body` (jsonb), `expires_at` |
| 55 | `rate_limit_counters` | distributed limits fallback | `bucket`, `window_start`, `count` |
| 56 | `schema_migrations` | migration ledger | `version`, `name`, `applied_at`, `checksum` |

## 4.3 Invariants enforced in the database

1. Money columns are `bigint` and **never** `numeric`/`float`. Every money-bearing row carries
   `currency char(3)`.
2. `amount_minor >= 0` and `amount_minor > 0` where a movement must be non-zero.
3. `requests.budget_max_minor >= requests.budget_min_minor` when both present.
4. `offers.price_minor` must fall inside the service's `[min_price_minor, max_price_minor]` when the
   service defines bounds (enforced in the API + a CHECK for the non-null case).
5. At most **one** `ACCEPTED` offer per request and at most **one** non-cancelled job per request
   (partial unique indexes).
6. One `transactional review` per `(job_id, author_id)` and one per direction (unique index).
7. One `CONVERSATION` per `(request_id, participant pair)`.
8. `wallet_transactions` and `job_events` and `negotiations` and `offer_history` are **append-only**
   (no `UPDATE`/`DELETE` granted; enforced by trigger + revoked grants).
9. Wallet balance changes only through a `wallet_transactions` row; `balance_after_minor` must equal
   the running balance inside the same transaction (trigger check).
10. `wallets.available_minor >= 0` — a wallet can never go negative.
11. Refund total per payment ≤ captured amount (checked in a trigger against the sum of refunds).
12. `users` has at least one of `email`/`phone`; both unique when present, case-insensitive on email.
13. `providers.rating_avg` in `[0, 5]`; rates in `[0, 10000]` bps.
14. Every table with an `updated_at` has a trigger that sets it.
15. Soft delete (`deleted_at`) on `users`, `providers`, `requests`, `jobs`, `messages`, `requests`;
    financial and audit tables are never hard-deleted.

## 4.4 Enum strategy

Enums live in the database as PostgreSQL `ENUM` types for closed sets (statuses, roles, channels) so
illegal values cannot be inserted, and are mirrored in TypeScript as const unions in
`packages/types`. Open sets (categories, services, fields, settings, currencies) are **tables**, never
enums — this is what keeps the platform configurable (spec §7, §11).

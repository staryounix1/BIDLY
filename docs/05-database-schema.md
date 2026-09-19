# BIDLY — 05. Database Schema (DDL reference)

Companion to `04-database-erd.md`. The authoritative DDL is `db/migrations/0001_init.sql`; this file
explains the shapes and the reasoning, table group by table group.

## 5.1 Conventions

- `id uuid primary key default gen_random_uuid()` everywhere; application code may supply a
  time-ordered UUIDv7 for hot tables (`requests`, `offers`, `jobs`, `messages`, `wallet_transactions`)
  so index locality stays sequential.
- `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`
  with a shared `set_updated_at()` trigger.
- Human-facing codes: `requests.code`, `jobs.code` are short, unambiguous, uppercase
  (`BID-7K3Q9Z`) generated from a sequence-free random alphabet with a unique index.
- Soft delete via `deleted_at timestamptz` only where the spec calls for it; financial rows are
  append-only and never deleted.
- All enum types are prefixed `bidly_` to avoid collisions when co-located with other schemas.

## 5.2 Identity & access

- `users`: the only place credentials live. `password_hash` is Argon2id (`$argon2id$...`), nullable so
  phone-only accounts are possible; `email` and `phone` are nullable but `CHECK (email IS NOT NULL OR
  phone IS NOT NULL)`. A partial unique index on `lower(email)` and one on `phone` make them unique
  when present. `status` covers `PENDING`/`ACTIVE`/`SUSPENDED`/`DELETED` so admin suspension is not a
  soft-delete. `role` is the coarse `CUSTOMER`/`PROVIDER`/`ADMIN`; fine-grained staff permissions live
  in `admin_users.permissions`, and provider capability is expressed by the existence of a `providers`
  row, not by a second role.
- `session` rows store only `refresh_token_hash` plus a `family_id` so refresh-token reuse can revoke
  the whole family (rotation + reuse detection, doc 07).
- `verification_token`s are hashed, single-use, short-lived, and carry an `attempt_count` for OTP
  brute-force throttling.

## 5.3 Catalog (config-driven core)

`countries` → `cities`, `currencies`; `categories` → `subcategories` → `services` →
`service_fields` → `service_field_options`. Every name is stored once per locale as
`name_en/name_fr/name_ar` (adding a locale is an additive migration, not a schema redesign). A
`services.pricing_model` enum (`FIXED_QUOTE`, `OFFER`, `RANGE`, `HOURLY`, `INSPECTION`) drives which
price fields the client renders. `service_fields.type` is `TEXT`, `TEXTAREA`, `NUMBER`, `BOOLEAN`,
`SELECT`, `MULTISELECT`, `DATE`, `DATETIME`, `PHONE`, `LOCATION`, `PHOTO`, `VIDEO`, `ADDRESS`. Fields
can be conditionally shown with `depends_on_key`/`depends_on_value`, and arbitrary constraints ride in
`validation jsonb` (`{min,max,minLength,maxLength,regex,step}`).

**Nothing about categories or questions is hard-coded in the frontend.** The client fetches the tree
and renders it.

## 5.4 Requests

`requests` is the demand root. It carries both normalised columns for the fields the matching engine
needs (service, location, budget, schedule, city) and an `answers jsonb` mirror for fast display;
`request_answers` holds the same data in a queryable, per-field shape so analytics and filtering do
not have to parse JSON. Media lives in `request_media`. Counters (`offer_count`) are denormalised for
feed performance and maintained by trigger; `selected_offer_id`, `job_id` are nullable FKs written in
the accept transaction.

State machine (doc 12 §12.3) is enforced by a `validate_request_transition()` trigger over the enum
`bidly_request_status`: `DRAFT → PUBLISHED → MATCHING → RECEIVING_OFFERS → PROVIDER_SELECTED →
CONFIRMED → IN_PROGRESS → COMPLETED`, with terminal `CANCELLED`, `EXPIRED`, `DISPUTED`, `REFUNDED`,
`FAILED`.

## 5.5 Offers & negotiation

`offers` holds the **current** offer state; every mutation writes an immutable snapshot into
`offer_history` and a thread entry into `negotiations`. A counter-offer never edits the original
price — it inserts a new offer row with `parent_offer_id` set and moves the parent to `COUNTERED`.
Partial unique indexes guarantee at most one `ACCEPTED` offer per request, and at most one active
(`PENDING`) offer per `(request_id, provider_id)` so a provider cannot spam revisions.

## 5.6 Jobs

`jobs` has a unique `request_id` (one request, one job) and stores an immutable
`commission_snapshot jsonb` capturing exactly which commission rule produced `commission_minor`, so a
later config change cannot rewrite history. The start-of-work OTP is stored as a hash
(`start_otp_hash`). `job_events` is the append-only lifecycle log — the authoritative timeline used
by support, disputes, and the realtime feed.

## 5.7 Money

`payments` is one intent per job, keyed unique on `job_id`, referencing the PSP by
`provider_name` + `provider_ref` (never card data). `payment_transactions` logs every PSP
interaction, including redacted webhook payloads, so a reconciliation job can prove what happened.
`wallets` + `wallet_transactions` form the ledger: `wallet_transactions` is append-only with
`balance_after_minor`, and a trigger asserts the running balance, making silent corruption
impossible. `payouts` and `refunds` each carry their own status machines and approval fields.
Provider earnings flow: payment capture → platform commission debit → provider wallet credit →
payout request → approval → payout paid + wallet debit.

## 5.8 Trust, ops & platform

`disputes` + `dispute_evidence` model conflicts; `notifications`, `support_tickets`,
`support_messages` cover engagement; `admin_users` + `admin_actions` + `audit_logs` cover privileged
operations — `admin_actions` is the business trail (what changed, before/after, why), `audit_logs`
is the security trail (who did what from where). `settings` is the typed key/value config store
(`value_type` in `string|number|boolean|json|array`, `is_public` controls exposure to the client).
`commission_rules` and `cancellation_policies` are resolved by specificity (service > category >
global) with an effective-date window, and snapshotted onto the job at accept time.
`outbox_events` provides the transactional-outbox pattern for notifications and webhooks;
`idempotency_keys` makes money and state endpoints safe to retry.

## 5.9 Indexes (the ones that matter)

- `requests (status, service_id, city_id, published_at desc)` — feed scan.
- `requests (customer_id, created_at desc)` and partial `where deleted_at is null`.
- GiST/GIN on `provider_locations.geohash` and `service_areas.geojson`for geo queries (falling back
  to haversine on lat/lng for simple radius matching in v1).
- `offers (request_id, status)`, `(provider_id, status)`, `(provider_id, created_at desc)`.
- `jobs (provider_id, status)`, `(customer_id, status)`, `(status, scheduled_at)`.
- `messages (conversation_id, created_at desc)` and `conversations (participant_a, last_message_at
  desc)` / `(participant_b, last_message_at desc)`.
- `wallet_transactions (wallet_id, created_at desc)`, `payment_transactions (payment_id, created_at)`.
- `notifications (user_id, read_at, created_at desc)` partial unread index.
- `audit_logs (entity_type, entity_id, created_at desc)`, `(actor_id, created_at desc)`.
- `outbox_events (status, available_at)` partial `where status = 'PENDING'` — worker poll index.

## 5.10 Row Level Security

RLS is enabled on every user-owned table. Service-role API traffic bypasses RLS by design (the API
enforces authorization in the service layer and is the only writer); RLS is the **defence in depth**
layer that protects against a leaked anon key or a direct Supabase client connection. Policy shapes:

- `users`: select/update own row only.
- `providers`, `provider_services`, `provider_documents`, `provider_locations`, `availability`:
  owner-only writes, public (active providers) read.
- `requests`, `request_answers`, `request_media`: customer owns; matched providers may read while
  active.
- `offers`, `negotiations`: the offering provider and the request's customer may read; only the
  offering provider writes.
- `jobs`, `job_events`, `conversations`, `messages`, `reviews`, `payments`, `refunds`: participants
  only.
- `wallets`, `wallet_transactions`, `payouts`: owner read, service-role write only.
- `admin_*`, `audit_logs`, `settings`, `commission_rules`, `cancellation_policies`: no anon/authenticated
  access at all; service role only.

## 5.11 Seed strategy

The seed is **idempotent and config-first**: countries (MA), currencies (MAD + USD/EUR for
architecture proof), cities (Rabat, Salé, Témara), service areas, the full category tree from the
spec, the dynamic field definitions, commission defaults, cancellation defaults, settings, and
development users (customer/provider/admin) with **fake** identities and known dev-only passwords.
Running the seed twice changes nothing. Reference data is treated as configuration, not fixtures.

## 5.12 Part 2 — Data model refinements (migration `0002`)

Additive, idempotent migration `db/migrations/0002_part2_data_models.sql`. Nothing from `0001`
is dropped; every change is `add if not exists` / `create or replace`.

### Reviews — per-category sub-ratings
`reviews` gains `rating_punctuality`, `rating_quality`, `rating_communication`, `rating_value`
(each `smallint`, nullable, `check between 1 and 5`). The overall `rating` remains the single
required score used for provider aggregates; sub-ratings are optional dimensions a customer may
give. Existing aggregate trigger (`trg_reviews_aggregate`) is unchanged.

### Review eligibility guard
`enforce_review_eligibility()` — a `before insert` trigger on `reviews` — rejects a review unless
the referenced job is in `COMPLETED`, `PAYMENT_PENDING`, `PAID`, `DISPUTED`, or `REFUNDED`. This
makes "no review before the job is done" a database invariant, not just a service rule.

### Attachments (generic object metadata store)
New enum `bidly_attachment_owner` and table `attachments`: one polymorphic metadata table for all
uploaded files (`owner_type`, `owner_id`) — request media, job evidence, dispute evidence,
provider documents, message attachments, avatars. **No binary is stored**; only the object-storage
key, mime type, byte size, checksum, dimensions, and uploader. Checks reject empty storage keys,
negative sizes, and implausible byte sizes; indexes cover owner lookup, uploader, and storage key;
`attach_updated_at` maintains `updated_at`.

### Request location privacy
`requests` gains `approx_lat`, `approx_lng`, `approx_geohash`, and `location_precision`
(enum `bidly_location_precision`: `APPROXIMATE` default, `EXACT`). Constraint
`requests_exact_location_present` requires `pickup_lat`/`pickup_lng` to be non-null whenever
precision is `EXACT`. Until a provider is selected, only the coarsened point is published, so the
open feed never leaks a customer's exact address. The rounding granularity is configurable via the
`geo.approx_decimals` setting (seeded to `2`, ≈1.1 km); it is not hard-coded.

### Request auto-advance fix
`trg_offers_count` previously promoted a request straight from `PUBLISHED` to `RECEIVING_OFFERS`
when the first offer arrived, which raised `Illegal request transition PUBLISHED -> RECEIVING_OFFERS`
against `trg_requests_transition`. The trigger now advances **only** a request already in
`MATCHING`, matching the documented state machine (`PUBLISHED → MATCHING → RECEIVING_OFFERS`) and
`packages/state-machines`.

### Tests
`db/tests/part2_models.sql` runs 9 behavioural assertions inside a rolled-back transaction and is
executed by `pnpm db:test` alongside `db/tests/invariants.sql`.

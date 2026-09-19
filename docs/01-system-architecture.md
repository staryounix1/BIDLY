# BIDLY — 01. Complete System Architecture

> "InDrive for Everything" — a multi-service reverse marketplace.
> Customer posts what they need → eligible providers compete with offers → customer compares and
> chooses → job runs its lifecycle → payment → review.

---

## 1.1 Architectural principles

1. **Config-driven, not code-driven.** Categories, services, dynamic form questions, pricing models,
   commission rules, cancellation rules, and verification requirements all live in the database and
   are editable by admins. Adding "Plumbing in Morocco" must never require a deploy.
2. **Marketplace truth lives server-side.** Prices, roles, statuses, commission, payment state and
   verification state are computed and enforced on the server. The client is a renderer, never an
   authority.
3. **Money is integer arithmetic.** All monetary values are stored as `BIGINT` minor units plus an
   ISO-4217 currency code. Never `float`/`double`. Never a free-floating "balance" column without a
   ledger behind it.
4. **State machines, not boolean soup.** Requests, offers, jobs, payments, disputes and payouts each
   have an explicit state machine with server-validated transitions.
5. **Idempotency for everything consequential.** Payments, accept-offer, job completion and payouts
   accept an idempotency key and are replay-safe.
6. **Privacy by default.** Exact addresses, phone numbers, emails and identity documents are revealed
   only to the counterparty that needs them, and only at the stage at which they need them.
7. **Provider-agnostic edges.** Payments, storage, notifications, maps, verification and AI are all
   behind interfaces so a country can swap in a local vendor without core changes.
8. **Multi-country from day one.** Country → currency, timezone, language, tax, payment providers,
   commission, legal documents, phone/address formats.

---

## 1.2 Context diagram (C4 level 1)

```
                              ┌──────────────────────────┐
                              │        BIDLY APP         │
                              │  Customer · Provider ·   │
                              │        Admin             │
                              └────────────┬─────────────┘
                                           │ HTTPS / WSS
        ┌──────────────────────────────────┼──────────────────────────────────┐
        │                                  │                                  │
        ▼                                  ▼                                  ▼
 ┌─────────────┐                   ┌───────────────┐                  ┌──────────────┐
 │ CUSTOMER    │                   │  API GATEWAY  │                  │  ADMIN WEB   │
 │  PWA (web)  │                   │  (REST + WS)  │                  │  (desktop)   │
 └─────────────┘                   └───────┬───────┘                  └──────────────┘
                                           │
        ┌──────────────┬──────────────┬────┴─────────┬──────────────┬──────────────┐
        ▼              ▼              ▼              ▼              ▼              ▼
  ┌──────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌──────────┐  ┌───────────┐
  │ Identity │  │ Requests  │  │ Matching  │  │  Offers   │  │  Jobs    │  │ Payments  │
  │ & Access │  │ & Catalog │  │  Engine   │  │ & Negot.  │  │ Lifecycle│  │  Ledger   │
  └────┬─────┘  └─────┬─────┘  └─────┬─────┘  └─────┬─────┘  └────┬─────┘  └─────┬─────┘
       │              │              │              │             │              │
       └──────────────┴──────────────┴──────┬───────┴─────────────┴──────────────┘
                                            │
                    ┌───────────────────────┼────────────────────────┐
                    ▼                       ▼                        ▼
             ┌────────────┐          ┌────────────┐          ┌────────────┐
             │ PostgreSQL │          │   Redis    │          │  Object    │
             │  (truth)   │          │ cache/q/rt │          │  Storage   │
             └────────────┘          └────────────┘          └────────────┘

  External adapters (all behind interfaces):
  PaymentProvider · PayoutProvider · StorageProvider · PushProvider
  EmailProvider · SmsProvider · MapProvider · VerifyProvider · AiProvider
```

---

## 1.3 Service decomposition (logical modules)

These are **modular boundaries inside the API application** for Round 1/2 (modular monolith), with a
clean seam to split into services later when a specific module becomes a scaling bottleneck. This is
deliberate: microservices on day one is the single most common way an early marketplace dies.

| Module | Responsibility | Owns tables |
|---|---|---|
| **identity** | auth, sessions, tokens, roles, RBAC, account deletion | `users`, `user_profiles`, `sessions`, `refresh_tokens`, `login_attempts`, `otp_codes`, `user_devices` |
| **providers** | provider onboarding, services, docs, service areas, availability, online mode | `providers`, `provider_members`, `provider_services`, `provider_documents`, `provider_locations`, `provider_service_areas`, `provider_availability`, `verification_records` |
| **catalog** | categories, subcategories, services, dynamic form fields, options | `categories`, `subcategories`, `services`, `service_fields`, `service_field_options`, `service_required_documents`, `service_pricing_models` |
| **requests** | request drafting, publishing, expiry, media, dynamic answers | `requests`, `request_answers`, `request_media`, `request_events` |
| **matching** | eligibility, distance/geofence, ranking candidates, dispatch fan-out | `match_runs`, `match_candidates`, `service_areas` |
| **offers** | offers, counter-offers, negotiation thread, expiry | `offers`, `offer_history`, `negotiations`, `negotiation_events` |
| **jobs** | job creation, lifecycle, evidence, OTP, tracking | `jobs`, `job_events`, `job_media`, `job_tracking_pings`, `job_completion_evidence` |
| **messaging** | conversations, messages, read receipts, attachments | `conversations`, `conversation_participants`, `messages`, `message_attachments` |
| **payments** | payment intents, charges, ledger, refunds, commission | `payments`, `payment_transactions`, `payment_methods`, `refunds`, `commission_rules`, `commission_ledger` |
| **wallet** | provider wallet, transactions, payouts | `wallets`, `wallet_transactions`, `payouts`, `payout_items` |
| **reviews** | two-sided reviews, rating aggregates, abuse reports | `reviews`, `review_reports`, `user_rating_stats` |
| **disputes** | dispute cases, evidence, admin decisions | `disputes`, `dispute_events`, `dispute_evidence` |
| **support** | tickets and agent replies | `support_tickets`, `support_messages`, `support_categories` |
| **notifications** | templates, per-user preferences, delivery records | `notification_templates`, `notifications`, `notification_preferences`, `notification_deliveries` |
| **promotions** | coupons, promotions, referrals | `promotions`, `coupons`, `coupon_redemptions`, `referrals`, `referral_rewards` |
| **trust** | risk signals, trust/risk score, review workflow | `risk_signals`, `risk_scores`, `risk_reviews`, `trust_score_history` |
| **analytics** | event log, daily aggregates, funnels | `analytics_events`, `daily_metrics`, `category_metrics`, `geo_metrics` |
| **admin** | admin users, permissions, audit trail, settings | `admin_users`, `admin_roles`, `admin_permissions`, `admin_role_permissions`, `admin_actions`, `audit_logs`, `platform_settings`, `feature_flags` |
| **i18n/locale** | countries, currencies, locales, translations, legal docs | `countries`, `currencies`, `exchange_rates`, `locales`, `translations`, `legal_documents`, `tax_rules`, `payment_provider_countries` |

---

## 1.4 The request → job lifecycle (system view)

```
CUSTOMER                     MATCHING ENGINE                 PROVIDERS                 SYSTEM
   │                                                                                        │
   │  1. create request (DRAFT)                                                             │
   │───────────────────────────────────────────────────────────────────────────────────────▶│
   │  2. publish (DRAFT → PUBLISHED)                                                        │
   │──────────────────────────────▶│  3. run match (PUBLISHED → MATCHING)                   │
   │                               │  eligible providers computed                          │
   │                               │──────────────────────────────▶ 4. notify eligible      │
   │                               │      (MATCHING → RECEIVING_OFFERS)                     │
   │                               │                               5. accept price / counter│
   │                               │◀────────────────────────────────────────────────────── │
   │  6. offers stream in (WS)                                                                 │
   │◀────────────────────────────────────────────────────────────────────────────────────── │
   │  7. compare & select offer                                                                │
   │──────────────────────────────▶│  8. tx: accept offer → create JOB → payment AUTHORIZED  │
   │                               │      (RECEIVING_OFFERS → PROVIDER_SELECTED → CONFIRMED) │
   │  9. provider heading / arrived / start (OTP) → IN_PROGRESS                                │
   │ 10. provider completes + evidence → customer confirms → COMPLETED                         │
   │ 11. payment CAPTURED → commission → provider wallet credit → PAYOUT                       │
   │ 12. mutual reviews                                                                        │
   │                                                                                        │
   └── any stage can branch to CANCELLED / EXPIRED / DISPUTED / REFUNDED / FAILED ──────────┘
```

---

## 1.5 Data flow & consistency model

- **PostgreSQL is the single source of truth.** Redis is a cache, a rate-limit store, a queue and a
  pub/sub fan-out — never authoritative for money or state.
- **Writes that touch money or state use transactions** with `SELECT ... FOR UPDATE` row locks on the
  request/offer/job rows involved, plus unique constraints as the last line of defence.
- **Outbox pattern for side effects.** Domain events are written into an `outbox_events` table inside
  the same transaction, then a worker publishes them (notifications, realtime, analytics). This
  prevents "job completed but no notification" split-brain.
- **Read models for scale.** Analytics and dashboards read from `daily_metrics` / `category_metrics`
  rolled up by workers, not by scanning transactional tables.

---

## 1.6 Non-functional targets

| Concern | Target |
|---|---|
| p95 read API latency | < 250 ms |
| p95 write API latency | < 500 ms |
| Request → first offer (median) | < 4 min in covered areas |
| WebSocket fan-out | 50k concurrent connections per cluster (Redis pub/sub adapter) |
| Availability | 99.9% monthly for API; graceful degradation for realtime |
| RPO / RTO | RPO ≤ 5 min (PITR) / RTO ≤ 1 h |
| Tenant isolation | Row-level security on all user-owned rows; admin access audited |

---

## 1.7 Deployment topology

```
        ┌─────────────────────────────────────────────────────────┐
        │ CDN + Edge (static PWA, image resizing)                │
        └────────────────────────┬────────────────────────────────┘
                                 │
        ┌────────────────────────▼────────────────────────────────┐
        │  Load Balancer / Reverse Proxy (TLS termination)        │
        └───────┬─────────────────────────────────┬──────────────┘
                │                                 │
     ┌──────────▼───────────┐          ┌──────────▼───────────┐
     │  API replicas (N)    │          │ Realtime gateway (N) │
     │  stateless, autoscale│          │ sticky WS, Redis hub │
     └──────────┬───────────┘          └──────────┬───────────┘
                │                                 │
     ┌──────────▼─────────────────────────────────▼───────────┐
     │            PostgreSQL (primary + read replicas)        │
     │            Redis (cache / rate limit / queue / pubsub) │
     │            Object storage (private buckets + CDN)      │
     └─────────────────────────────────────────────────────────┘

     ┌─────────────────────────────────────────────────────────┐
     │  Worker pool: notifications, expiry, payouts, fraud,    │
     │  analytics rollups, reconciliation, cleanup             │
     └─────────────────────────────────────────────────────────┘
```

Environments: **development → staging → production**, each with its own Supabase project, secrets,
payment sandbox/live keys and storage buckets. Destructive migrations never run automatically in
production (see `20-deployment-strategy.md`).

---

## 1.8 Why this shape survives growth

| Growth pressure | Pre-planned response |
|---|---|
| Read volume on request browsing | Read replicas + Redis cache + denormalised counters |
| Match fan-out cost | Candidate pre-filter in SQL (geohash + service index), then score in app; async match runs |
| Chat volume | Messages partitionable by `conversation_id` hash; WS gateway scales horizontally via Redis |
| Payment volume | Payment module extractable first (already isolated, own tables, own adapter interface) |
| New country | Insert `countries`/`currencies`/`tax_rules`/`legal_documents`/`commission_rules` rows; no code change |
| New category | Admin category builder writes `categories`/`services`/`service_fields`; frontend renders dynamically |
| Fraud | Risk score pipeline + admin review queue, isolated in `trust` module |

See `02-technology-stack.md` for the concrete choices.

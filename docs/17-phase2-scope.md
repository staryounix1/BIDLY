# BIDLY — 17. Phase 2 Scope

Phase 2 turns a working marketplace into a **trusted, liquid, self-operating** one. Priority is what
increases completed-job volume and reduces support load — not feature count.

## 17.1 Live tracking & logistics
- Continuous provider tracking on `job:{id}` with adaptive cadence and battery-aware sampling
- Route ETA via the configured `MapProvider`; "arriving in 4 min" notifications
- Turn-by-turn handoff to the device's native map app
- Geofenced arrival detection (auto-suggest "Arrived" when within radius)
- Delivery proof: photo + signature capture, optional barcode/QR scan for packages

## 17.2 Advanced matching
- PostGIS `ST_DWithin` + GiST indexes; true polygon service areas
- Multi-stop/time-window routing awareness
- Supply forecasting: pre-emptive provider recruitment by category × area
- Fairness controls and cold-start boost tuning
- Category-specific scoring weight presets, editable by admin
- "Why am I not seeing requests?" provider self-service diagnostic using `match_candidates` reasons

## 17.3 Verification & trust
- External identity verification adapter (document + liveness/selfie)
- Business verification with registry lookups in supported countries
- Insurance and licence expiry monitoring with automatic suspension on expiry
- Background checks where legally permitted and required by category
- Trust score v2: explainable factor breakdown surfaced to the provider

## 17.4 Wallet, payouts & earnings
- Automated payout scheduling (daily/weekly) with thresholds and hold periods
- Multi-currency provider wallets with FX handling for cross-border providers
- Payout rails: bank transfer, PayPal, local providers; instant payout where available
- Instant payout fee model
- Provider statements (monthly, tax-ready) and CSV/PDF exports
- Negative-balance handling for chargebacks (recovery ledger)

## 17.5 Payments expansion
- Second and third PSP adapters (PayPal, Adyen, plus a regional provider)
- Per-country PSP routing via `payment_provider_countries`
- Split payments / multi-provider jobs
- Deposit and milestone payments for large jobs
- Subscriptions billing plumbing (ties into §17.7)
- Tax engine integration (VAT/GST/sales tax) with invoice numbering per country
- Dunning/retry orchestration for failed authorizations

## 17.6 Notifications & communication
- SMS channel with per-country vendors and cost controls
- Native push (FCM/APNs) when a native shell is introduced
- Rich in-app inbox with threads, attachments and search
- Message translation (customer ↔ provider language gap)
- Canned responses and smart replies for providers
- Digest scheduling and quiet hours refinement

## 17.7 Promotions, coupons & growth
- Coupon engine: percentage, fixed, first-job, category-scoped, area-scoped
- Budget caps, per-user limits, stacking rules, automatic expiry
- Provider-funded promotions (a provider boosts their own offer clearly labelled as promoted)
- Referral programs for customers and providers with qualification rules and delayed rewards
- Launch campaigns per city with geo-targeting

## 17.8 Business accounts (foundation)
- Business customer profiles: multiple requesters, multiple locations, cost centres
- Team roles with spending limits and approval flows
- Consolidated invoicing, monthly statements, PO numbers
- Business provider accounts with employee sub-accounts and job assignment

## 17.9 Subscriptions (spec §74)
- Provider plans: FREE / PRO / BUSINESS, configurable in admin
- PRO: lower commission, priority matching weight (clearly labelled), advanced analytics, more photos
- BUSINESS: team seats, invoicing, API access
- Proration, trials, plan change with an auditable billing ledger

## 17.10 Advanced disputes & support
- Evidence workflows with structured deadlines and automatic escalation
- Partial-refund policies by category
- Resolution templates and policy citations
- SLA tracking, CSAT surveys, agent performance dashboards
- Automated support triage (rule-based first, AI-assisted later)

## 17.11 Analytics & experimentation
- Cohort retention (customer and provider, by category and city)
- Liquidity metrics: fill rate, time-to-first-offer, time-to-award per geo × category
- Supply/demand heatmaps with provider recruitment targeting
- Pricing insights: accepted-price distributions, suggestion of competitive budget ranges
- A/B testing framework for request flow and offer UI
- Admin custom dashboard builder

## 17.12 Operational maturity
- Read replicas for analytics and heavy admin queries
- Table partitioning for messages and tracking pings
- Autoscaling policies with load tests
- Chaos/failure drills on payments and realtime
- Disaster-recovery restore test on a schedule
- Data retention automation per country requirements

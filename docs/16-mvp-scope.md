# BIDLY — 16. MVP Scope (Phase 1)

Goal: a real, end-to-end, usable marketplace in a single launch market — **post a request → receive
offers → compare → choose → job completes → pay → review** — with an admin console that can run it.
No mock backend (spec §108), no hardcoded business data (spec §109).

## 16.1 In scope

### Customer
- Email/password signup, login, password reset, email + phone verification
- Profile, saved addresses, locale (en/fr/ar), notification preferences
- Category & service browsing from the DB catalog
- Dynamic request creation from `service_fields` (all field types)
- Location picker, scheduling, urgency, budget per the service's pricing model
- Media upload (photos/videos) with validation
- Matching status screen and live offer feed
- Offer comparison, provider public profile, accept offer
- Chat with the awarded provider (and pre-award negotiation chat)
- Job status timeline, start OTP display, completion confirmation
- Payment authorization at accept, capture on completion; receipts
- Review the provider after completion
- Request history, active job screen, support ticket creation
- Honest "no providers" recovery flow (spec §101)

### Provider
- Signup + provider onboarding wizard
- Service selection, service area & radius, availability, online/offline
- Document upload and verification submission
- Nearby eligible request feed (privacy-redacted pre-award)
- Make offer / counter-offer / ask a question / decline / accept customer price
- Offer expiry handling
- Chat with the customer
- Arrived → start (OTP) → complete (evidence) job flow
- Earnings view, wallet balances, payout request, transaction history
- Reviews received, two-sided review of the customer

### Admin
- Admin login with MFA
- Dashboard KPIs and core charts
- Users: search, view, suspend, reactivate, verify
- Providers: 360 view, document review, verification approve/reject, suspend
- Catalog builder: categories, subcategories, services, **dynamic form fields**, field options,
  pricing model, required documents, required verification level
- Commission rules (percent / fixed / fixed+percent, scoped)
- Cancellation rules (scoped, configurable)
- Requests, offers, jobs monitoring
- Payments, refunds, payout approval
- Disputes workflow with evidence and decisions
- Reviews moderation and abuse reports
- Support tickets
- Platform settings, offer/request expiry, feature flags
- Audit log viewer

### Platform
- Multi-country, multi-currency, multi-language foundations (data + API, UI fully localised for en/fr/ar)
- Configurable commission and cancellation rules, evaluated server-side
- Payment provider abstraction with **one live adapter** (Stripe) plus a sandbox/mock adapter that is
  explicitly labelled and disabled in production
- Notification system: in-app + Web Push + email, with preferences and idempotent delivery
- Realtime: offer feed, chat, job status
- Object storage with private buckets and signed URLs
- Observability: structured logs, error tracking, uptime + queue monitoring
- Automated tests for the critical paths (doc 19)
- CI/CD with preview deployments and safe migrations
- PWA: installable, offline shell, push

## 16.2 Explicitly out of scope for Phase 1

Live GPS tracking (basic status only), automated payouts (manual batch), advanced fraud ML, promotions
& coupons UI, business accounts, subscriptions, AI structuring (optional flag, off by default),
native apps, PostGIS precision matching, multi-market launch (one country live, others seeded).

## 16.3 Definition of done for Phase 1

1. A new customer can go from signup to a completed, paid, reviewed job without any staff help.
2. A new provider can onboard, verify, receive a request, win it, complete it and see earnings.
3. An admin can add a brand-new category + service + dynamic questions and that service works
   end-to-end **without a deploy**.
4. Concurrent accept-offer attempts produce exactly one job (proven by an automated test).
5. Double-clicking pay and retrying a failed payment produce exactly one charge (proven by a test).
6. Every illegal state transition is rejected server-side (proven by state machine tests).
7. No critical/high security findings in the pre-launch review.
8. All data is multi-country-ready: creating a second country requires data entry only.

## 16.4 Phasing inside Phase 1 (build order, spec §105)

| Sprint | Deliverable |
|---|---|
| 0 | Repo, CI, env validation, DB schema + migrations applied, seed reference data |
| 1 | Identity module (auth, sessions, RBAC), admin bootstrap |
| 2 | Catalog + dynamic form engine + admin catalog builder |
| 3 | Requests module (create/publish/media/expiry) + customer request UI |
| 4 | Matching engine + provider feed + notifications plumbing |
| 5 | Offers, negotiation, comparison UI, transactional accept |
| 6 | Jobs lifecycle, OTP start, evidence, completion, realtime status |
| 7 | Messaging + realtime gateway |
| 8 | Payments (authorize/capture/refund), commission, wallet ledger |
| 9 | Reviews, disputes, support |
| 10 | Admin console completion, analytics rollups, audit logs |
| 11 | Hardening: tests, security review, performance, PWA polish |
| 12 | Staging soak + production launch checklist |

## 16.5 Demo mode (spec §94)

`DEMO_MODE=true` (never in production — enforced by an env guard that refuses to boot with demo mode
when `NODE_ENV=production`):

- Seeds demo customer, provider and admin accounts with known non-sensitive credentials.
- Uses the **mock payment adapter**, which is structurally incapable of reaching a live PSP.
- Adds a persistent UI banner: "Demo data — payments are simulated."
- Resets demo data on demand via a script.

Demo paths are separated at the module boundary (`integrations/payments/mock/`), not sprinkled through
the code, so production code cannot accidentally execute demo logic.

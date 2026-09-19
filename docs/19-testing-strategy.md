# BIDLY — 19. Testing Strategy

Testing follows the money and the state machines. A bug in a rating colour is a cosmetic issue; a bug in
accept-offer or payment capture is a real financial loss and a trust failure.

## 19.1 Test pyramid

```
        ▲  E2E (Playwright)            ~25 scenarios, critical journeys only, run on every PR to main
       ███  Integration (API + DB)     ~150 tests, real Postgres, real migrations, fake PSP
     █████  Unit (Vitest)              ~600+ tests, pure logic: state machines, money, matching, rules
   ███████  Static (tsc strict, eslint, zod)     every commit, blocking
```
Target coverage: **> 85%** on `packages/state-machines`, `packages/money`, `modules/payments`,
`modules/offers`, `modules/jobs`, `modules/matching`; no coverage target on UI components (behaviour is
covered by E2E instead).

## 19.2 Unit tests (must-have)

| Area | Cases |
|---|---|
| Money | minor-unit add/sub/multiply, currency mismatch rejection, rounding rules, percentage commission with bps, fixed+percent, min/max fee caps |
| State machines | every legal transition; every illegal transition rejected with the right error code |
| Commission rules | specificity resolution, effective windows, promo precedence, snapshot immutability |
| Cancellation rules | each stage × each actor × each model, caps, reliability impact |
| Matching | proximity/rating/reliability scoring, ring expansion, exclusion reasons, cold-start boost |
| Pricing models | FIXED / OFFER / RANGE / HOURLY / QUOTE validation bounds |
| Dynamic forms | field validation, required logic, conditional display, option integrity |
| Geo | haversine accuracy, bounding box, service-area containment |
| Idempotency | same key + same body → same response; same key + different body → conflict |
| i18n | no missing keys for en/fr/ar on any user-facing string used by tests |

## 19.3 Integration / API tests (real database)

| Scenario | Assertions |
|---|---|
| Registration → login | token issued, session row created, password hashed with Argon2id, duplicate email rejected |
| Email/phone verification | OTP single-use, expiry enforced, rate limit enforced |
| Refresh rotation | new token issued, old token rejected, reuse revokes family |
| Request creation | dynamic answers persisted and type-checked; invalid field rejected |
| Publish → matching | match_run + candidates created; only eligible providers; match reasons recorded |
| Offer creation | eligibility re-checked server-side; price bounds enforced; duplicate active offer blocked |
| Counter-offer | append-only negotiation events; previous offers untouched |
| Offer acceptance | job created, other offers handled per rules, payment intent created, all in one transaction |
| **Concurrent accept** | two simultaneous accepts → exactly one job, one winner, deterministic loser error |
| Job lifecycle | arrived → start (OTP valid/invalid/expired) → complete → confirm |
| Job completion retry | second completion attempt does not double-complete |
| Payment authorize/capture | correct ledger rows, commission snapshot, wallet credit |
| Payment idempotency | double-click pay → one charge; retry after timeout → one charge |
| Refund | full/partial, cap enforcement, PSP webhook replay cannot double-refund |
| Payout | eligibility, approval, unique ledger guard, retry safety |
| Reviews | blocked before completion, one per direction, duplicate blocked |
| Cancellation | fee computed from policy at the correct stage |
| Dispute | one open dispute per job, evidence attach, admin decision writes audit |
| Notifications | event → outbox → dispatch; duplicate suppression on retry |
| Authorization | every endpoint: role matrix, ownership, non-participant gets 404 |
| Admin actions | RBAC enforced; audit row written with before/after; break-glass requires case ref |
| Rate limits | auth, OTP, offers, messages, uploads return 429 with Retry-After |

## 19.4 E2E journeys (Playwright)

1. Customer signup → create moving request → receive (simulated) offers → compare → accept → chat →
   provider arrives → OTP start → complete → pay → review.
2. Provider onboarding → verification submit → go online → offer on a request → counter-offer →
   win → complete → earnings visible → payout request.
3. Admin adds a **new category + service + dynamic questions**, then a customer completes a request in
   that brand-new service (proves the config-driven promise).
4. No-provider recovery: request in an uncovered area → honest empty state → expand radius / raise
   budget → offer arrives.
5. Dispute: customer disputes → admin requests evidence → partial refund → both parties notified.
6. Offline resilience: request list loads from cache, pay button disabled offline, reconnect resyncs.
7. PWA install + push subscription flow.
8. RTL/Arabic rendering smoke test for the main customer flow.

## 19.5 Contract & schema tests

- OpenAPI schema validated in CI; SDK regenerated and diffed (a breaking API change fails the build).
- Prisma migration diff check: no destructive migration may merge without an explicit
  `--allow-destructive` label and a reviewed backfill plan.
- DB constraint tests: the invariants in doc 04 §4.3 each have a test that attempts to violate them.
- Seed data test: seed runs cleanly on an empty DB and is idempotent.

## 19.6 Non-functional testing

| Type | Approach |
|---|---|
| Performance | k6: request feed, offer create at 500 RPS; p95 budget from doc 01 §1.6 |
| Load | match fan-out with 10k providers in a service area |
| Realtime | 5k concurrent sockets, room broadcast latency, reconnect storm |
| Security | OWASP ZAP baseline, IDOR fuzzing across endpoints, auth bypass attempts, upload abuse |
| Payment abuse | card-testing patterns, webhook signature forgery, replay attacks |
| Chaos | kill worker mid-job, drop Redis, fail the PSP → verify recovery paths and no lost money |
| Accessibility | axe-core on critical screens (WCAG 2.1 AA), keyboard-only run through booking |
| Localisation | pseudo-locale build to catch hardcoded strings; full pass on fr/ar |

## 19.7 Test infrastructure

- `docker compose` brings up Postgres + Redis + MinIO + MailHog; tests run against a **real** database
  with migrations applied, not SQLite.
- Each test file gets a transaction-scoped or template-cloned database for isolation and speed.
- The **fake PSP adapter** is the default in tests; a separate suite runs against the PSP sandbox
  nightly to catch real-world drift.
- Deterministic time via an injectable clock (offer expiry, cancellation stages, quiet hours).
- Seeded random data via a fixed seed so failures are reproducible.

## 19.8 Gates (spec §95)

Every PR: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit`, `pnpm test:integration`, `pnpm build`,
`pnpm test:security:zap` (on main). Merge to `main` adds E2E against a preview deployment.
Production deploy requires a green pipeline plus a manual approval, and runs a post-deploy smoke test
(signup, request create, offer create, payment authorize in sandbox mode, then rollback on failure).

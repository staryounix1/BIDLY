# BIDLY — 20. Deployment Strategy

## 20.1 Environments

| Env | Purpose | Database | Payments | Notes |
|---|---|---|---|---|
| **local** | developer machines | dockerised Postgres 17 | fake adapter | seeded demo data; demo mode banner |
| **preview** | per-PR | ephemeral Supabase branch / shadow DB | fake adapter | Vercel preview URL per PR |
| **staging** | pre-production soak | separate Supabase project | PSP **sandbox** keys | production-like data volumes, synthetic load |
| **production** | live | Supabase project `irtxdculyyiwxovurstp` (region us-east-1) | PSP **live** keys | strict access, MFA on admin, backups + PITR |

Environments never share secrets, buckets, or payment credentials. Production keys are physically
absent from lower environments (validated at boot).

## 20.2 Build & release pipeline

```
 push / PR
    │
    ├─► static:   tsc --noEmit, eslint, prettier check, secret scan
    ├─► unit:     vitest (packages + modules)
    ├─► contract: openapi diff, prisma migration diff (destructive check)
    ├─► build:    turbo build (api, worker, web, admin)
    │
    ▼ (on main)
    ├─► integration: real Postgres + migrations + API tests
    ├─► E2E:        Playwright against the preview deployment
    ├─► security:   dependency audit (block on high), ZAP baseline, SAST
    ├─► deploy preview → Vercel (web, admin); containers → registry (api, worker)
    │
    ▼ (manual approval + release tag)
    ├─► migrate production (expanding-only, see 20.4)
    ├─► deploy api/worker (rolling, one at a time, health-gated)
    ├─► deploy web/admin (Vercel atomic)
    ├─► post-deploy smoke tests
    └─► release notes + monitoring watch window (30 min)
```

Rollback: Vercel supports instant rollback to the previous deployment; API/worker roll back by
re-pinning the previous image tag. **Migrations are written to be backward compatible for one release**
(expand → migrate → contract), so a code rollback never requires a schema rollback.

## 20.3 Hosting choices

| Component | Host | Why |
|---|---|---|
| `apps/web`, `apps/admin` | **Vercel** | Native Next.js, preview deployments, edge CDN |
| `apps/api`, `apps/worker` | Containers (Fly.io / Render / AWS ECS) | Long-lived WebSocket connections and background workers need persistent, autoscalable compute — not serverless functions |
| PostgreSQL + Storage | **Supabase** | Managed Postgres 17, private buckets, PITR backups, region us-east-1 |
| Redis | Managed Redis (Upstash / ElastiCache) | Cache, rate limits, BullMQ queues, Socket.IO adapter |
| CDN | Vercel Edge / Cloudflare | Static assets, image optimisation, WAF |
| DNS | Cloudflare | DNSSEC, proxying, origin protection |

`apps/api` is containerised because it holds WebSocket state and runs long jobs; a serverless-only
deployment would break the realtime design in doc 14.

## 20.4 Migration policy (spec §96)

Migrations live in `db/migrations/` as ordered, reviewable SQL, applied by CI with a migration ledger
table. Rules:

1. **Never destructive automatically.** `DROP`, `ALTER ... TYPE` narrowing, and `NOT NULL` without a
   default require an explicit `--destructive` annotation and a second reviewer.
2. **Expand → backfill → contract.** Add columns/tables first, backfill in a batched worker, switch the
   app, then drop the old shape in a later release — never in the same deploy.
3. **Lock-aware.** `CREATE INDEX CONCURRENTLY` for large tables; no long `ALTER TABLE` locks during
   business hours; statement timeouts set for migration sessions.
4. **Idempotent & re-runnable.** Every migration can be re-applied safely (`IF NOT EXISTS`, guarded
   DO blocks).
5. **Dry run first.** Staging applies the exact migration set against a production-shaped snapshot;
   measured duration is logged; anything over 60 s triggers a maintenance-window review.
6. **Reversible where possible.** A `-- down` script accompanies each migration; irreversible ones are
   flagged and require explicit sign-off.
7. **RLS travels with schema.** Enabling RLS and adding policies is part of the table's own migration,
   so a table can never ship unprotected.

## 20.5 Configuration & environment variables

- `packages/config` validates every env var at boot with Zod; the process **exits** on a missing or
  placeholder value (fail fast, never half-configured).
- `.env.example` lists variable **names with placeholder values only** — no real secrets (spec §89).
- Variable groups: app (`NODE_ENV`, `APP_URL`, `API_URL`), database (`DATABASE_URL`), redis
  (`REDIS_URL`), auth (`JWT_SECRET`, `REFRESH_SECRET`, `ARGON2_*`), storage (`S3_*`), payments
  (`PAYMENT_PROVIDER`, `STRIPE_*`, `PAYPAL_*`), email/sms/push, maps (`MAP_PROVIDER`, `MAP_API_KEY`),
  verification, AI, observability (`SENTRY_DSN`, `OTEL_*`), features (`DEMO_MODE`, `FEATURE_*`).
- Secrets are stored in the hosting platform's secret manager and injected at runtime; rotation is a
  documented procedure with dual-key windows for JWT and webhook secrets.

## 20.6 Observability & alerting (spec §97)

| Layer | Tooling | Signals |
|---|---|---|
| Errors | Sentry | exception rate, regression on release, affected users |
| Logs | structured JSON → log aggregator | request id correlation, error codes, slow queries |
| Traces | OpenTelemetry | API latency, DB spans, external adapter latency |
| Metrics | Prometheus + Grafana | RPS, p95/p99, error rate, queue depth, socket count |
| Database | Supabase + pg_stat_statements | slow queries, connection saturation, replication lag, bloat |
| Queue | BullMQ dashboard | failed jobs, retry rate, backlog age |
| Payments | custom dashboard | auth/capture failure rate, webhook lag, reconciliation deltas |
| Uptime | synthetic checks | API health, critical user path (signup→request→offer) every 5 min |

**Alert thresholds (examples):** p95 API > 500 ms for 5 min; error rate > 1% for 5 min; payment capture
failure > 3%; webhook processing lag > 2 min; queue backlog > 1000; DB connections > 80%; zero offers
on a published request older than 15 min (marketplace health alert, not just infrastructure).

## 20.7 Backup & recovery (spec §98)

| Asset | Backup | Retention | Restore drill |
|---|---|---|---|
| PostgreSQL | automated daily snapshot + PITR (WAL) | 30 days PITR, 12 months monthly | quarterly restore to an isolated instance, timed |
| Object storage | versioning + cross-region replication | 90 days | quarterly spot restore |
| Secrets | platform secret store + encrypted offline escrow | rotation schedule | semiannual |
| Infra config | git (Terraform in phase 3) | permanent | — |

Targets: **RPO ≤ 5 min**, **RTO ≤ 1 h**. The runbook covers: detecting the incident, freezing deploys,
restoring the DB to a point in time, verifying ledger integrity (`wallets` vs `wallet_transactions`),
replaying missed outbox/payment webhooks idempotently, and communicating with users.

## 20.8 Launch checklist (production)

- [ ] All CI gates green on the release commit
- [ ] Migrations applied to staging and dry-run on a production snapshot
- [ ] Env vars validated; no placeholders; demo mode OFF
- [ ] PSP live keys verified with a real low-value charge + refund
- [ ] Webhook endpoints reachable with correct signature secrets
- [ ] Object storage buckets private; signed URL TTL verified
- [ ] RLS enabled on every user-owned table (automated check)
- [ ] Admin accounts created with MFA enforced; default creds removed
- [ ] Rate limits and WAF rules active
- [ ] Backups + PITR confirmed; restore drill within the last quarter
- [ ] Monitoring, alerting and on-call routing live
- [ ] Legal documents published per launch country (ToS, privacy, cancellation, refund)
- [ ] Smoke tests pass against production; rollback path verified
- [ ] Support inbox and escalation contacts staffed

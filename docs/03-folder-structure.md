# BIDLY — 03. Folder Structure

pnpm workspaces + Turborepo. Apps are deployables; packages are shared libraries. A module in the API
maps 1:1 to a module in doc 01, so a future service extraction is a folder move, not a rewrite.

```
bidly/
├── apps/
│   ├── api/                      # NestJS + Fastify API and realtime gateway
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── app.module.ts
│   │   │   ├── common/           # cross-cutting, no business logic
│   │   │   │   ├── decorators/       @CurrentUser, @Roles, @IdempotencyKey
│   │   │   │   ├── guards/           JwtAuthGuard, RolesGuard, OwnershipGuard
│   │   │   │   ├── interceptors/     logging, transform, timeout, idempotency
│   │   │   │   ├── filters/          AllExceptionsFilter → friendly errors
│   │   │   │   ├── pipes/            ZodValidationPipe
│   │   │   │   └── middleware/       requestId, rateLimit, securityHeaders
│   │   │   ├── config/           # typed env schema, fail-fast validation
│   │   │   ├── modules/
│   │   │   │   ├── identity/         # auth, users, sessions, otp, rbac
│   │   │   │   ├── providers/
│   │   │   │   ├── catalog/          # categories, services, dynamic fields
│   │   │   │   ├── requests/
│   │   │   │   ├── matching/
│   │   │   │   ├── offers/
│   │   │   │   ├── jobs/
│   │   │   │   ├── messaging/
│   │   │   │   ├── payments/
│   │   │   │   ├── wallet/
│   │   │   │   ├── reviews/
│   │   │   │   ├── disputes/
│   │   │   │   ├── support/
│   │   │   │   ├── notifications/
│   │   │   │   ├── promotions/
│   │   │   │   ├── trust/
│   │   │   │   ├── analytics/
│   │   │   │   ├── admin/
│   │   │   │   └── realtime/         # socket.io gateway + event bus bridge
│   │   │   ├── integrations/         # external adapters, one folder per vendor
│   │   │   │   ├── payments/         stripe/, paypal/, adyen/
│   │   │   │   ├── storage/          s3/, supabase/
│   │   │   │   ├── email/  sms/  push/  maps/  verify/  ai/
│   │   │   └── workers/              # BullMQ processors
│   │   │       ├── notifications.processor.ts
│   │   │       ├── expiry.processor.ts
│   │   │       ├── payouts.processor.ts
│   │   │       ├── reconciliation.processor.ts
│   │   │       ├── analytics.processor.ts
│   │   │       ├── fraud.processor.ts
│   │   │       └── outbox.processor.ts
│   │   └── test/                 # unit, integration, api, e2e
│   │
│   ├── web/                      # Next.js — customer + provider PWA (mobile-first)
│   │   ├── app/
│   │   │   ├── (auth)/           login, signup, forgot-password, otp
│   │   │   ├── (customer)/       home, categories, request/new, requests, offers,
│   │   │   │                     compare, jobs, chat, profile, settings, support
│   │   │   ├── (provider)/       dashboard, requests, offers, jobs, earnings,
│   │   │   │                     wallet, payouts, profile, settings
│   │   │   └── api/              BFF route handlers (no business logic)
│   │   ├── components/           BIDLY design system in use
│   │   ├── features/             feature-scoped hooks + client state per domain
│   │   ├── lib/                  api client, ws client, i18n, money, geo
│   │   └── public/               icons, manifest, service worker
│   │
│   ├── admin/                    # Next.js — desktop-first admin console
│   │   ├── app/                  dashboard, users, providers, verification, catalog,
│   │   │                         requests, offers, jobs, payments, payouts, disputes,
│   │   │                         reviews, support, promotions, analytics, settings, audit
│   │   └── ...
│   │
│   └── worker/                   # standalone container running BullMQ processors
│
├── packages/
│   ├── database/                 # Prisma schema, migrations, seed, RLS policies
│   │   ├── prisma/schema.prisma
│   │   ├── prisma/migrations/
│   │   ├── seed/
│   │   └── src/                  client factory, soft-delete extension
│   ├── types/                    # shared domain types + state machine enums
│   │   └── src/{user,request,offer,job,payment,dispute,...}.ts
│   ├── validation/               # Zod schemas shared by API + clients
│   ├── ui/                       # BIDLY design system (tokens + components)
│   ├── config/                   # eslint, tsconfig, tailwind, prettier presets
│   ├── money/                    # minor-unit arithmetic, currency, formatting
│   ├── state-machines/           # pure transition validators + guards
│   ├── events/                   # domain event contracts + outbox types
│   ├── i18n/                     # translation keys + en, fr, ar bundles
│   └── sdk/                      # generated typed API client from OpenAPI
│
├── db/
│   ├── migrations/               # ordered SQL migrations (source of truth for Supabase)
│   ├── policies/                 # RLS policy SQL
│   ├── functions/                # SQL functions + triggers
│   └── seeds/                    # reference data SQL (categories, services, countries)
│
├── infra/
│   ├── docker/                   # Dockerfiles for api, worker, web
│   ├── compose/                  # docker-compose for local dev
│   ├── ci/                       # GitHub Actions workflows
│   └── terraform/                # (phase 3) infra as code
│
├── docs/                         # this architecture set (01..20)
├── scripts/                      # ops + maintenance scripts
├── .env.example
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

## 3.1 Dependency rules (enforced by lint + CI)

1. `packages/*` never import from `apps/*`.
2. `apps/*` never import each other's internals — only via `packages/sdk` or `packages/types`.
3. Inside `apps/api/src/modules/*`, a module may only read another module's tables through that
   module's exported service. Cross-module table writes are forbidden — they use domain events.
4. `integrations/*` may be imported only by the owning module's service (e.g. only `payments` imports
   the Stripe adapter).
5. No business logic in `apps/web` or `apps/admin` — they render and call the API.
6. `common/` has no domain imports.

## 3.2 Where the "config-driven" magic lives

| Capability | Lives in |
|---|---|
| Category / service / dynamic questions | `packages/database` + `modules/catalog` + `apps/admin/app/catalog` |
| Dynamic form rendering | `apps/web/features/requests/DynamicForm` driven by `services` + `service_fields` |
| Commission rules | `modules/payments` reading `commission_rules` |
| Cancellation rules | `modules/jobs` reading `cancellation_rules` |
| Country/currency/tax/legal | `packages/i18n` + `modules/*` reading `countries`, `currencies`, `tax_rules`, `legal_documents` |
| Notification templates | `modules/notifications` reading `notification_templates` |
| Feature flags | `modules/admin` reading `feature_flags` |

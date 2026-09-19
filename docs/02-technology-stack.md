# BIDLY — 02. Technology Stack

Selection criteria: production-proven, TypeScript end-to-end for shared types, cheap to run at
zero users, horizontally scalable at millions, no vendor lock-in on the money path.

## 2.1 Chosen stack

| Layer | Choice | Why this, not the alternative |
|---|---|---|
| **Language** | TypeScript 5.x, `strict: true` | Shared types across API, web, admin and workers; catches money/state bugs at compile time |
| **Runtime** | Node.js 22 LTS | Matches team familiarity, excellent Postgres and WS libraries |
| **Monorepo** | pnpm workspaces + Turborepo | One repo, shared packages, cached builds, no cross-repo version drift |
| **Customer + Provider app** | Next.js 15 (App Router) + React 19 | SSR for first paint and SEO on service landing pages, RSC for fast mobile pages, one codebase → web + PWA + (later) native shell |
| **Admin dashboard** | Next.js 15 (separate app) | Desktop-first, same component library, separately deployable and separately access-controlled |
| **Styling** | Tailwind CSS v4 + own design tokens | Fast to build a premium mobile-first UI; tokens keep branding original and consistent |
| **Components** | Radix UI primitives + own BIDLY component layer | Accessible behaviour for free, fully original visual design on top |
| **API** | NestJS (modular monolith) on Fastify | First-class DI and module boundaries that map 1:1 to the modules in doc 01; Fastify for throughput; clean seam to extract services |
| **API contract** | REST + OpenAPI 3.1 generated from the code | Typed client generation, contract tests, easy partner integrations later |
| **Realtime** | Socket.IO (Redis adapter) | Rooms per conversation/request/job exactly match our permission model; reconnect + ack semantics out of the box |
| **Database** | PostgreSQL 17 (Supabase managed) | Relational truth, JSONB for dynamic answers, PostGIS-ready for geospatial |
| **ORM** | Prisma | Type-safe queries, migrations, good DX; raw SQL escape hatch for hot geospatial queries |
| **Cache / queue** | Redis 7 | Cache, rate limiting, BullMQ queues, Socket.IO pub/sub — one dependency, four jobs |
| **Background jobs** | BullMQ | Reliable retries, delayed jobs (offer/request expiry), repeatable jobs (rollups), per-queue concurrency |
| **Object storage** | S3-compatible private buckets (Supabase Storage in Round 1) | Signed URLs, no CDN leakage of private media, swappable for R2/S3/MinIO via `StorageProvider` |
| **Auth** | Own identity module: Argon2id passwords + short-lived JWT access tokens + rotating refresh tokens (hashed at rest) | Full control of sessions, revocation, device list, and provider/customer role switching — third-party auth would fight our RBAC |
| **Payments** | `PaymentProvider` interface; Stripe adapter first, PayPal/Adyen/CMI/Payzone adapters later | Lets a country use a local PSP; core never imports a PSP SDK outside its adapter |
| **Maps** | `MapProvider` interface; MapLibre GL + OSM tiles default, Google/Mapbox adapters optional | No forced Google billing; provider is configurable per country |
| **Push** | Web Push (VAPID) for PWA, FCM/APNs adapters later | Works with the PWA install story from day one |
| **Email / SMS** | `EmailProvider` / `SmsProvider` interfaces; SMTP+Resend and Twilio adapters | Regional SMS vendors are the norm; keep them swappable |
| **Identity verification** | `VerifyProvider` interface; manual review in MVP, external KYC later | Compliance differs per country; never hard-wire one vendor |
| **AI** | `AiProvider` interface (OpenAI-compatible), feature-flagged | Optional and modular as required by spec §72 |
| **Testing** | Vitest (unit/integration), Supertest (API), Playwright (E2E) | Fast, TS-native, one config style |
| **Observability** | OpenTelemetry traces, pino structured logs, Sentry, Prometheus/Grafana | Vendor-neutral traces; structured JSON logs feed log search |
| **CI/CD** | GitHub Actions → Vercel (web/admin) + container registry (API/workers) | Uses the GitHub + Vercel accounts already connected |
| **Containers** | Docker (multi-stage) + docker-compose for local dev | Reproducible API/worker images; prod is cloud-agnostic |
| **IaC** | Terraform (Round 3) | Infra as code once the shape stabilises |

## 2.2 Deliberately rejected (and why)

| Rejected | Reason |
|---|---|
| Microservices from day one | Coordination cost kills early marketplaces; modular monolith with hard module seams first |
| Firebase / Firestore as primary store | Financial ledgers, constraints and multi-table transactions are far safer in Postgres |
| Storing money as `float` | Float rounding on commission/refunds is a real-money bug class; minor units only |
| MongoDB for the core | Our domain is highly relational (request→offer→job→payment); JSONB covers the dynamic-form part |
| Client-side price/commission logic | Spec §104: never trust frontend for price, role, status, commission, payment state |
| A single global payment provider | Blocks launching in markets that mandate a local PSP |
| Raw card storage | PCI scope; tokenised methods only, handled by the PSP adapter |
| Long-lived non-revocable JWT sessions | Provider/customer roles and bans need instant revocation → short access token + rotating refresh |

## 2.3 Version pinning policy

- All dependencies pinned to exact versions in lockfiles; Renovate opens weekly PRs.
- Node version pinned via `.nvmrc` + `engines` field.
- Postgres major version pinned; upgrades are planned migrations, never automatic.
- No CDN-loaded runtime libraries in the app (only in throwaway demos); everything is bundled and
  version-locked.

## 2.4 Local development

```
docker compose up -d        # postgres 17, redis 7, minio, mailhog
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev                    # turbo: api + web + admin + workers
```

Local dev never touches production Supabase or live payment keys. Demo mode (`DEMO_MODE=true`) seeds
fake accounts and fake payments that are structurally prevented from reaching a live PSP (see
`docs/16-mvp-scope.md`).

# BIDLY — 06. API Architecture

## 6.1 Style

- REST over HTTPS, JSON bodies, OpenAPI 3.1 generated from NestJS decorators.
- Realtime updates over Socket.IO (doc 14); REST is the source of truth, sockets are notifications.
- API is versioned by URL prefix: `/v1/...`. Breaking changes ship as `/v2`.
- Typed client generated into `packages/sdk` so web/admin never hand-write request shapes.

## 6.2 Conventions

**Success envelope**
```json
{ "data": { }, "meta": { "requestId": "req_01H...", "ts": "2026-09-19T02:00:00Z" } }
```

**List envelope**
```json
{
  "data": [ ],
  "meta": {
    "page": 1, "pageSize": 20, "total": 143,
    "hasNext": true,
    "cursor": "eyJpZCI6..."          // cursor pagination for high-volume feeds
  }
}
```

**Error envelope** (single shape everywhere)
```json
{
  "error": {
    "code": "REQUEST_NOT_AVAILABLE",
    "message": "This request is no longer accepting offers.",
    "userMessage": "طلبك لم يعد متاحاً لاستقبال عروض جديدة.",
    "details": [{ "field": "price", "issue": "must be >= 5.00" }],
    "requestId": "req_01H..."
  }
}
```
`code` is a stable machine string; `message` is for developers; `userMessage` is the localised,
user-facing string. Raw SQL/driver errors never reach the client — they are logged with the request id
and replaced by a generic code (spec §56).

**Status codes**

| Code | Use |
|---|---|
| 200 / 201 / 204 | success / created / deleted-with-no-body |
| 400 | validation failure (`VALIDATION_ERROR`) |
| 401 | missing/invalid/expired access token |
| 403 | authenticated but not allowed (role/ownership/verification) |
| 404 | not found **or** exists-but-not-visible (prevents existence leaks) |
| 409 | state machine conflict (`INVALID_STATE_TRANSITION`, `ALREADY_ACCEPTED`, `OFFER_EXPIRED`) |
| 422 | semantically invalid but well-formed (`PRICE_OUT_OF_RANGE`) |
| 429 | rate limited, with `Retry-After` |
| 500 | unexpected; generic user message + logged trace |

**Cross-cutting headers**

| Header | Direction | Purpose |
|---|---|---|
| `Authorization: Bearer <access>` | in | auth |
| `X-Request-Id` | in/out | correlation (generated if absent) |
| `Idempotency-Key` | in | required on all money/state-mutating POSTs |
| `X-Client-Version`, `X-Device-Id` | in | force-upgrade + fraud signals |
| `X-RateLimit-*`, `Retry-After` | out | rate limit feedback |
| `Accept-Language` | in | i18n response language (en, fr, ar) |

## 6.3 Endpoint map

### `/v1/auth`
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | customer or provider signup; rate-limited, captcha-gated |
| POST | `/auth/login` | email+password → access + refresh |
| POST | `/auth/refresh` | rotating refresh token; reuse detection revokes family |
| POST | `/auth/logout` | revokes current session |
| POST | `/auth/logout-all` | revokes every session |
| POST | `/auth/otp/request` | phone or email OTP |
| POST | `/auth/otp/verify` | verifies, marks channel verified |
| POST | `/auth/password/forgot` / `/reset` | always 200 (no account enumeration) |
| GET | `/auth/sessions` | device/session list |
| DELETE | `/auth/sessions/:id` | revoke one |
| POST | `/auth/account/delete` | soft delete + grace period |

### `/v1/users`
`GET /users/me`, `PATCH /users/me`, `GET /users/me/roles`, `POST /users/me/roles/provider`
(switch to provider mode), `GET/PATCH /users/me/notification-preferences`, `GET/PATCH /users/me/locale`,
`GET /users/me/consents`.

### `/v1/providers`
`GET /providers` (public discovery + filters), `GET /providers/:id` (public profile),
`GET /providers/me`, `PATCH /providers/me`, `POST /providers/me/online` `POST /providers/me/offline`,
`GET/POST/DELETE /providers/me/services`, `GET/POST /providers/me/documents`,
`GET/POST/PATCH/DELETE /providers/me/service-areas`, `GET/PUT /providers/me/availability`,
`GET /providers/me/stats`, `POST /providers/me/verification/request`.

### `/v1/catalog`
`GET /catalog/categories` (tree, active), `GET /catalog/categories/:slug`,
`GET /catalog/services?category=`, `GET /catalog/services/:slug` (**returns the dynamic form schema**),
`GET /catalog/search?q=`, `GET /catalog/countries`, `GET /catalog/currencies`.

### `/v1/requests`
| Method | Path | Notes |
|---|---|---|
| POST | `/requests` | create DRAFT; free-text → optional AI structuring |
| POST | `/requests/parse` | AI parses natural language into a draft (user must confirm) |
| PATCH | `/requests/:id` | edit while DRAFT |
| POST | `/requests/:id/publish` | DRAFT→PUBLISHED, triggers matching |
| GET | `/requests` | mine, filter by status/category |
| GET | `/requests/:id` | owner or matched provider view (field-level redaction) |
| POST | `/requests/:id/cancel` | CUSTOMER cancellation rules applied |
| POST | `/requests/:id/repost` | clone an expired/cancelled request |
| GET | `/requests/:id/matches` | owner only: who was notified |
| POST | `/requests/:id/media` | presigned upload → attach |
| GET | `/requests/feed` | provider feed of eligible nearby requests |

### `/v1/offers`
| Method | Path | Notes |
|---|---|---|
| POST | `/requests/:id/offers` | create offer; `Idempotency-Key`; matching eligibility re-checked |
| GET | `/requests/:id/offers` | owner sees all; each provider sees only theirs |
| GET | `/offers/:id` | participant only |
| POST | `/offers/:id/withdraw` | PENDING→WITHDRAWN |
| POST | `/offers/:id/accept` | **critical**: transactional accept (doc 67 rules) |
| POST | `/offers/:id/reject` | owner rejects |
| POST | `/offers/:id/counter` | counter-offer (creates negotiation event) |
| GET | `/requests/:id/offers/compare` | comparison payload with provider trust metrics |

### `/v1/negotiations`
`GET /negotiations/:id`, `POST /negotiations/:id/messages`,
`POST /negotiations/:id/accept` (final price → accept offer).

### `/v1/jobs`
| Method | Path | Notes |
|---|---|---|
| GET | `/jobs` | mine (customer or provider), filtered |
| GET | `/jobs/:id` | participant only; exact address only after CONFIRMED |
| POST | `/jobs/:id/arrived` | provider marks arrival (GPS check) |
| POST | `/jobs/:id/start` | requires OTP or customer confirm per service config |
| POST | `/jobs/:id/complete` | provider submits evidence |
| POST | `/jobs/:id/confirm-completion` | customer confirms → triggers capture |
| POST | `/jobs/:id/cancel` | cancellation policy applied server-side |
| POST | `/jobs/:id/dispute` | opens dispute |
| POST | `/jobs/:id/tracking` | provider location ping (rate-limited, privacy-bounded) |
| GET | `/jobs/:id/tracking` | customer view of latest ping |
| GET | `/jobs/:id/timeline` | `job_events` projection |

### `/v1/messages`
`GET /conversations`, `POST /conversations` (request/job scoped), `GET /conversations/:id`,
`GET /conversations/:id/messages` (cursor), `POST /conversations/:id/messages`,
`POST /messages/:id/read`, `GET /conversations/:id/attachments`.

### `/v1/payments`
`POST /payments/intents` (idempotent), `POST /payments/:id/confirm`,
`GET /payments/:id`, `POST /payments/:id/refund` (customer/admin), `GET /payments/methods`,
`POST /payments/methods`, `GET /payments/:id/receipt`.

### `/v1/wallet`
`GET /wallet`, `GET /wallet/transactions`, `POST /payouts`, `GET /payouts`,
`GET /payouts/:id`, `GET /wallet/summary`.

### `/v1/reviews`
`POST /jobs/:id/reviews`, `GET /jobs/:id/reviews`, `GET /providers/:id/reviews`,
`GET /users/me/reviews`, `POST /reviews/:id/report`, `POST /reviews/:id/reply`.

### `/v1/disputes`
`POST /disputes`, `GET /disputes`, `GET /disputes/:id`, `POST /disputes/:id/evidence`,
`POST /disputes/:id/messages`, `POST /disputes/:id/withdraw`.

### `/v1/notifications`
`GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all`,
`GET/PATCH /notifications/preferences`, `POST /notifications/devices` (push registration).

### `/v1/support`
`POST /support/tickets`, `GET /support/tickets`, `GET /support/tickets/:id`,
`POST /support/tickets/:id/messages`, `GET /support/categories`.

### `/v1/promotions`
`GET /promotions/active`, `POST /promotions/validate`, `POST /referrals/apply`,
`GET /referrals/me`.

### `/v1/admin/*` (separate auth realm, RBAC + audit on every mutation)
`admin/dashboard`, `admin/stats/*`, `admin/users`, `admin/providers`, `admin/verification`,
`admin/categories` (+ `subcategories`, `services`, `service-fields`, `field-options`),
`admin/requests`, `admin/offers`, `admin/jobs`, `admin/payments`, `admin/refunds`,
`admin/payouts`, `admin/disputes`, `admin/reviews`, `admin/support`, `admin/promotions`,
`admin/coupons`, `admin/commission-rules`, `admin/cancellation-rules`, `admin/settings`,
`admin/feature-flags`, `admin/audit-logs`, `admin/risk`, `admin/geo`, `admin/analytics`,
`admin/notifications/templates`, `admin/broadcast`.

### `/v1/analytics`
`GET /analytics/events` (admin), `GET /analytics/metrics/daily`,
`GET /analytics/funnel`, `GET /analytics/categories`, `GET /analytics/geo`.

### `/v1/webhooks`
`POST /webhooks/payments/:provider` (signature-verified, idempotent),
`POST /webhooks/verify/:provider`, `POST /webhooks/email/:provider`.

## 6.4 Pagination, filtering, sorting

- Default `pageSize=20`, max `100` (hard cap, spec §60).
- Feeds (requests/notifications/messages) use **cursor** pagination (`?cursor=&limit=`).
- Admin tables use offset pagination with `total` (needs counts).
- Filters are explicit allow-lists per endpoint; unknown params are ignored, not passed through.
- Sorting is a whitelist of indexed columns (prevents sorting on unindexed/expensive columns).

## 6.5 Validation & authorization pipeline

Every request passes through, in order:
1. `requestId` + security headers
2. Rate limiter (per IP, per user, per endpoint class)
3. Access token verification (`JwtAuthGuard`)
4. Role guard (`@Roles('PROVIDER')`)
5. Zod schema validation of body/query/params (`ValidationPipe`) — **server-side, always**
6. Ownership/relationship guard (`@OwnsRequest('id')`, participant checks)
7. Idempotency interceptor (money/state mutations)
8. Handler → service (business rules, state machine, transaction)
9. Response transform + logging

## 6.6 Rate limits (defaults, configurable per country)

| Class | Limit |
|---|---|
| auth endpoints | 10 / 15 min / IP + exponential backoff |
| OTP request | 3 / hour / phone |
| create request | 10 / day / user |
| create offer | 60 / hour / provider |
| send message | 120 / hour / conversation |
| upload | 30 / hour / user, 25 MB/file |
| payments | 20 / hour / user |
| admin mutations | 300 / hour / admin |
| global per-IP | 600 / min |

## Auth context & admin permissions (Task 3)

Every authenticated request carries an `AuthContext` built server-side from the
verified access token **and** a fresh database read:

- `authenticate` verifies the JWT against `AUTH_SECRET`, then re-checks the
  `auth_sessions` row so a revoked session stops working immediately.
- For `role = 'ADMIN'`, `loadAuthorization` additionally loads the linked
  `admins` row to resolve `adminRole` (sub-role) and explicit `permissions`.
  A user with `role = 'ADMIN'` but no active `admins` row gets no admin powers.
- `/auth/me` returns `admin_role` alongside the profile so the admin console can
  render sub-role-aware navigation. It never returns a hash or secret.

Guard decorators: `authenticate`, `optionalAuth`, `requireCustomer`,
`requireProvider`, `requireAdmin`, `requireRole(...)`, and
`requirePermission(permission)` (admin permission, e.g. `users:write`).

Shared client/server validation lives in `@bidly/validation` (`auth.ts`):
`registerSchema`, `loginSchema`, `verifyEmailSchema`, `forgotPasswordSchema`,
`resetPasswordSchema`, `changePasswordSchema`, `updateProfileSchema`, and
`strongPasswordSchema` — the same rules the API enforces and the web forms use.

## Customer request flow (Task 4)

The demand-side flow is database-driven end to end:

1. `GET /categories` returns the full category → subcategory → service tree.
2. `GET /services/:slug/form` returns the service plus its `service_fields`
   (with options), which is what the web form renders — there is no per-service
   form component anywhere in the product.
3. `POST /requests` creates the request as `DRAFT`, normalising dynamic answers
   into `request_answers` rows and validating every required field server-side.
4. `POST /requests/:id/publish` moves `DRAFT → PUBLISHED` and records an initial
   match run/candidate set (matching itself is a later task).
5. `GET /requests/mine` and `GET /requests/:id` are scoped to the authenticated
   customer; another customer receives `403`.
6. `POST /requests/:id/cancel` is allowed only from an open status, enforced by
   the DB state machine.

The client never sends a status: `status` only changes through the publish and
cancel endpoints, each of which validates the transition against the enum.
Shared schemas live in `@bidly/validation` (`request.ts`): `createRequestSchema`,
`cancelRequestSchema`, and `validateServiceAnswers` for dynamic fields.

# BIDLY — 07. Authentication & Authorization Architecture

## 7.1 Auth model

Three principals share one identity table but have separate role bindings:

- **CUSTOMER** — default role on signup.
- **PROVIDER** — granted by completing provider onboarding (`POST /users/me/roles/provider`), then
  gated by verification level.
- **ADMIN** — **never** self-grantable; created only by an existing admin via the admin console, with
  separate credentials realm and mandatory 2FA.

A single user may be both CUSTOMER and PROVIDER (common: a driver who also orders services). Roles are
rows in `user_roles`, not a column, so this is natural.

## 7.2 Credential & token design

| Concern | Decision |
|---|---|
| Password hashing | **Argon2id** (memory 64 MB, iterations 3, parallelism 1), per-user salt |
| Password policy | min 10 chars, zxcvbn score ≥ 3, checked against breach list (k-anonymity API) |
| Access token | JWT, **15 min TTL**, `HS256` with rotating secret, claims: `sub`, `sid`, `roles`, `ver`, `amr` |
| Refresh token | opaque 256-bit random, **30 day TTL**, stored hashed (SHA-256) in `sessions` |
| Refresh rotation | every refresh issues a new token; reuse of an old token revokes the whole family |
| Session binding | `sessions` row holds device id, user agent, IP, country, last_seen → device list + revoke |
| Logout | revokes the session row; access token dies within 15 min (short TTL by design) |
| Password change | revokes all sessions except current |
| Account deletion | soft delete + 30-day grace, then anonymise; legal hold respected |
| 2FA (admin, optional users) | TOTP; enforced for ADMIN role via `admin_users.mfa_required` |

**Storage rule:** only the access token is held in memory (never `localStorage`); the refresh token is
an `HttpOnly; Secure; SameSite=Strict` cookie. This removes the common XSS token-theft path.

## 7.3 Authorization (RBAC + ownership + relationship)

Authorization is three-layered, all server-side:

1. **Role check** — `@Roles('PROVIDER')` on the controller/route.
2. **Ownership / relationship check** — the decisive layer. Examples:
   - request detail: requester is the owner, OR a provider with an active `match_candidate` row
   - conversation: requester is in `conversation_participants`
   - job action: requester is `job.customer_id` or `job.provider_id`
   - wallet: requester owns the wallet
   Non-participants receive **404**, never 403, to avoid leaking existence.
3. **State & business preconditions** — the service layer validates the state machine and
   category/market rules before any write.

### Permission matrix (abridged)

| Resource | Customer | Provider | Admin |
|---|---|---|---|
| Own profile | RW | RW | RW (audited) |
| Other user's profile | R (public fields) | R (public fields) | R (audited) |
| Request (own) | RW | — | R + R (audited) |
| Request (matched) | — | R (redacted) | R + R (audited) |
| Request (unmatched) | — | — | R (audited) |
| Offers (own) | RW | RW | R (audited) |
| Offers (others') | R (on own request) | — | R (audited) |
| Job (own) | RW (lifecycle) | RW (lifecycle) | R + intervene (audited) |
| Messages | participants only | participants only | metadata only, content via break-glass |
| Payments (own) | R | R (payout side) | R + refund (audited) |
| Identity documents | own only | own only | reviewer role only |
| Platform settings | — | — | RW (superadmin) |
| Audit logs | — | — | R (audited) |

### Admin sub-roles (`admin_roles` → `admin_permissions`)
`SUPER_ADMIN`, `OPS_ADMIN`, `SUPPORT_AGENT`, `FINANCE`, `VERIFICATION_REVIEWER`, `CONTENT_MODERATOR`.
A support agent can see a dispute but not raw messages; finance can refund but not edit catalog; a
verification reviewer can see ID documents but not payments. This satisfies spec §34 (admins must not
have unrestricted access to private content).

### Break-glass access
Any admin reading private message content or identity documents must attach a case reference
(`support_ticket_id` or `dispute_id`). The action is written to `audit_logs` and the case is notified.
Two-person rule applies to bulk exports.

## 7.4 Provider verification gates

Verification is a ladder, configurable per country/service:

| Level | Unlocks |
|---|---|
| `EMAIL_VERIFIED` | browse, create profile |
| `PHONE_VERIFIED` | **make offers** on low-risk services |
| `IDENTITY_VERIFIED` (KYC doc + selfie, or manual review) | high-value services, payouts |
| `BUSINESS_VERIFIED` (registration + tax id) | business account, invoicing, team members |

`services.required_verification_level` + `countries.required_verification_level` determine the gate; the
offer endpoint re-checks it at write time, not just at onboarding.

## 7.5 Threat model & mitigations

| Threat | Mitigation |
|---|---|
| Credential stuffing | Argon2id, per-IP + per-account rate limits, breach-list check, device anomaly signal |
| Session hijack | 15-min access token in memory, rotating refresh in HttpOnly cookie, session list + revoke |
| Refresh-token replay | Rotation + family revocation on reuse |
| CSRF | SameSite=Strict refresh cookie + `Origin` check on state-changing routes |
| XSS | React auto-escaping, strict CSP, no `dangerouslySetInnerHTML` on user content, sanitise rich text |
| SQL injection | Prisma parameterised queries; raw SQL only with bound parameters, reviewed |
| IDOR | Relationship guards on every resource; opaque UUIDv7 ids |
| Enumeration | Register/forgot-password always return 200; 404 for non-participants |
| Privilege escalation | Roles from DB only, never trusted from client; admin realm separate |
| Account takeover via OTP | OTP rate limits, 6-digit numeric, 5-min TTL, single use, hashed at rest |
| Device/account farming | Device fingerprint + phone verification + risk score (doc 31) |
| Malicious uploads | MIME sniffing + extension match, size cap, AV scan, served from a separate origin |
| Replay of money mutations | `Idempotency-Key` + `idempotency_keys` table (doc 61) |
| Insider abuse | Admin RBAC, break-glass, append-only audit log, alerting on anomalies |
| Scraping | Rate limits, cursor caps, no bulk endpoints without admin scope |

## 7.6 Secrets & environment

- All secrets from environment variables validated at boot (`packages/config` Zod schema). The app
  **refuses to start** if a required secret is missing or a placeholder is still present.
- Secrets live in the platform secret store; never in the repo, never in logs, never in client bundles.
- Separate key sets per environment; production payment keys are never present in dev/staging.
- JWT signing keys rotate with a `kid` header; old keys accepted for one TTL window only.
- Webhook signatures verified with constant-time comparison.

## 7.7 Compliance hooks

- `consents` records ToS/Privacy version + locale + timestamp per user, per country.
- Data export and deletion endpoints are provided (GDPR/CCPA-shaped).
- Retention rules per table (doc 04 §4.5) enforce a bounded lifetime for OTPs, tracking pings and
  login attempts.
- Identity documents are stored in a separate, access-restricted bucket with short-lived signed URLs
  and are never exposed to the customer app.

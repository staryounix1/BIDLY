# BIDLY — 15. Security Architecture

Complements doc 07 (auth/authz). This document covers the application-wide controls required by
spec §30–32, §60–66, §104.

## 15.1 Defence in depth

```
 Edge            →  CDN, WAF, DDoS protection, TLS 1.2+ only, HSTS
 Transport       →  HTTPS everywhere, secure cookies, OCSP stapling
 Application     →  authn, authz, validation, idempotency, rate limits, CSP
 Data            →  RLS, least-privilege DB roles, encryption at rest, PII separation
 Operations      →  secret management, audited admin actions, backups, monitoring
```

## 15.2 Input handling

- **Every** request body/query/param validated with a Zod schema server-side. Client validation is UX
  only and is never trusted (spec §104).
- Unknown fields are stripped, not passed through to the database.
- Strings are length-capped and normalised (NFC) to prevent homoglyph/duplicate-account tricks.
- Rich text (descriptions, messages) is sanitised against an allow-list of tags; plain-text fields are
  escaped on render.
- File uploads: extension **and** MIME sniffing must agree; images re-encoded server-side (strips
  embedded scripts/EXIF); max sizes (image 10 MB, video 50 MB, document 25 MB) enforced at the API and
  at the storage layer; AV scan before the file becomes downloadable.
- Uploads are received via short-lived presigned URLs scoped to a single object key and content type.
- Numeric fields (money, quantity, radius) are parsed to integers with explicit bounds; NaN/Infinity
  rejected.

## 15.3 Output & transport

- Strict **Content-Security-Policy** (no inline scripts in the app; nonce-based), `X-Content-Type-
  Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`.
- CORS is an explicit allow-list of first-party origins; credentials only for those origins.
- No stack traces, SQL, or internal ids in error responses — a generic code plus a request id
  (spec §56). Technical detail goes to logs and Sentry.
- User-generated media is served from a **separate origin** so an XSS in a file cannot reach app
  cookies/localStorage.
- API responses are DTO-shaped; internal columns (e.g. `password_hash`, PSP references, risk scores)
  are never serialised. Risk scores are admin-only and always accompanied by their explanation
  (spec §77).

## 15.4 Data protection

| Control | Implementation |
|---|---|
| Encryption in transit | TLS everywhere, including service-to-service |
| Encryption at rest | PostgreSQL + storage encryption (managed) |
| PII minimisation | Exact address only after CONFIRMED; phone only after CONFIRMED; email never exposed |
| PII separation | Identity documents in a dedicated bucket + table, restricted role |
| Column encryption | Sensitive columns (ID numbers, bank details) encrypted with app-level keys |
| Tokenisation | Cards are PSP tokens; we store brand/last4/expiry only |
| Backups | Encrypted, access-logged, restore-tested |
| Retention | Documented per table; automated purge for ephemeral data |
| Right to erasure | Soft-delete + anonymisation job, with legal-hold exceptions for disputes |

### Row-Level Security

Every user-owned table has RLS policies:

```sql
-- representative pattern
ALTER TABLE requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY requests_owner ON requests
  FOR ALL USING (customer_id = auth.uid());
-- providers read only requests they are matched to, via a security-definer function
CREATE POLICY requests_matched_provider ON requests FOR SELECT
  USING (EXISTS (SELECT 1 FROM match_candidates mc
                 JOIN providers p ON p.id = mc.provider_id
                 WHERE mc.request_id = requests.id AND p.user_id = auth.uid()));
```

The API connects with a least-privilege role; RLS is the safety net behind the application guard, so a
bug in one endpoint cannot expose another user's rows.

## 15.5 Abuse & rate limiting

Enforced in Redis with a sliding window per (ip, user, route-class) plus stricter per-account limits
for auth/OTP/offers (doc 06 §6.6). Behaviour:

- Soft limit → `429` with `Retry-After`.
- Repeated auth failures → temporary lock + CAPTCHA challenge, and a risk signal.
- OTP → 3 per hour per phone, incremental delays.
- Offers → per-provider hourly cap plus per-request uniqueness.
- Scraping → cursor caps, no unauthenticated list endpoints with unbounded results, bot heuristics.

## 15.6 Fraud & risk (spec §31)

Signals collected into `risk_signals` (never a single-signal ban):

| Category | Signals |
|---|---|
| Identity | duplicate device fingerprints, shared payment instruments, disposable emails, mismatched names |
| Payment | repeated auth failures, card testing patterns, chargebacks, mismatched IP/country |
| Behaviour | cancellation rate, offer spam, dispute rate, review velocity, impossible travel |
| Relationship | reciprocal 5-star loops, same-IP rating clusters, self-dealing attempts |
| Content | scam keywords, off-platform payment requests, prohibited items |

A weighted **risk score** per user/provider (0–100) with a documented factor breakdown, thresholds
that route to `risk_reviews` (watch → restrict → suspend → ban), and mandatory human review before any
ban. The score is never shown to the counterparty; only its *actionable* consequences (e.g. "verified")
are surfaced.

## 15.7 Concurrency & state integrity (spec §67–68)

- All state transitions validated server-side against the state machine; illegal transitions return
  `409 INVALID_STATE_TRANSITION`.
- Accept-offer runs in a single transaction with `SELECT ... FOR UPDATE` on the request and offer, plus
  `UNIQUE(jobs.accepted_offer_id)` and `UNIQUE(jobs.request_id)` as the final guard. Two customers or a
  double-tap can never create two jobs.
- Job completion uses a conditional UPDATE (`WHERE status = 'IN_PROGRESS'`) so a retry cannot complete
  twice.
- Payouts are guarded by `UNIQUE` on their source wallet transactions and a status check on the batch.
- Admin approvals use optimistic concurrency (`version` column) so two admins cannot apply
  conflicting changes.

## 15.8 Auditability (spec §58)

`audit_logs` is append-only (enforced by a DB trigger rejecting UPDATE/DELETE) and captures actor,
action, target, before/after values, reason, IP, device, request id, and case reference. Sensitive reads
(viewing ID docs, reading message content under break-glass, exporting data) are also audited. Logs are
shipped to a separate store with a longer retention than the app database.

## 15.9 Logging hygiene (spec §57)

Structured JSON logs include request id, user id, provider id, job id, action, result, duration and
error code. **Never logged:** passwords, tokens, OTP codes, full card data, full addresses, ID numbers,
message bodies (only message ids and lengths). Log fields are allow-listed at the logger level so a
developer cannot accidentally leak a secret object.

## 15.10 Secure SDLC

- Dependency scanning (Dependabot + `pnpm audit`) blocking on high severity.
- SAST on every PR; secret scanning on push (blocks committed keys).
- Security checklist on every PR touching auth, payments, or PII.
- Pre-deploy: type check, lint, unit + integration + E2E, migration dry-run, env validation.
- Threat model reviewed whenever a new external integration or money path is added.
- Incident response runbook with contact paths, and a documented 72-hour breach-notification process.

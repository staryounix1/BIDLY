# BIDLY — 10. Admin Flow

Admin is desktop-first but responsive (spec §42). Every mutation is authorised by sub-role, validated
server-side, and written to `audit_logs` (spec §58).

## 10.1 Admin home / dashboard (spec §33)

**KPI strip (live, from `daily_metrics` rollups):**
total users · total providers · online providers · active requests · requests receiving offers ·
active jobs · completed jobs (period) · GMV · platform fees · refunds · open disputes ·
new registrations · verification queue depth.

**Charts:** revenue over time (gross/commission/net), jobs over time, new users vs new providers,
requests→offers→jobs funnel, category performance, geographic activity heatmap.

**Action queues (the reason admins open the console):**
- Provider verification requests awaiting review
- Disputes awaiting decision
- Payouts awaiting approval
- Flagged risk reviews
- Support tickets breaching SLA
- Failed payments / webhook failures
- Offers/requests nearing expiry without activity

## 10.2 Module-by-module

### Users (spec §35)
Search by name/email/phone/id; filter by role, status, verification, country, registration date.
Actions: view, suspend, reactivate, restrict (feature-scoped), verify/unverify channel, force logout,
request data export, delete where legally permitted. Every action requires a reason and writes an
audit row. Suspension immediately invalidates sessions.

### Providers (spec §36)
Full provider 360: profile, services, service areas, availability, documents, verification history,
jobs, ratings, complaints, earnings, payouts, cancellation rate, response rate, risk indicators.
Actions: approve/reject verification, request more documents, adjust service radius, suspend, ban,
adjust reliability, force offline.

### Verification queue
Document viewer with zoom, side-by-side comparison, approve/reject with reason codes, request-resubmit
flow, SLA timer, and an immutable reviewer trail. ID documents are visible only to the
`VERIFICATION_REVIEWER` role, and opening one is logged with a case reference.

### Catalog & dynamic forms (spec §28 — the critical one)
- **Categories** — create/edit/reorder/enable/disable/deactivate, per-country availability,
  icon/colour slug, i18n keys.
- **Subcategories** and **Services** — same, plus: pricing model (FIXED/OFFER/RANGE/HOURLY/QUOTE),
  min/max price, currency, default offer expiry, required verification level, required documents,
  matching rules (radius defaults, capacity, vehicle/equipment requirements), commission rule
  reference, cancellation rule reference.
- **Dynamic form builder** — drag-and-drop field editor: add `service_fields` with type, label,
  i18n key, validation, required flag, group, order, help text, and conditional logic
  (show field B when field A = X). Field options for selects/radios/multiselects.
  **A live preview renders the exact customer form** so admins see what they are shipping.
  No code deploy is needed for any of this.

### Requests (spec §34)
List with filters (status, category, country, city, price range, has offers, date). Detail shows:
customer, dynamic answers, media, match candidates and why each was/wasn't eligible, all offers,
negotiations, selected provider, job, payment, timeline, dispute. **Message content is metadata-only
unless a case reference is attached** (break-glass, doc 07 §7.3).

### Offers & negotiations
Global offer monitoring, abnormally low/high price flags, offer velocity per provider, and the ability
to void an offer with a reason (audited). Admin never chooses a provider for the customer.

### Jobs
Live board (kanban by status), per-job detail with timeline, evidence, OTP audit, tracking history
(pings are pruned after 30 days), cancellation data.

### Payments, refunds, payouts
- Payments list with state, PSP reference, idempotency key, webhook history.
- Refund composer: full/partial, reason, destination, idempotent submission.
- Payout approval queue: eligibility, amount, destination, fraud flags, batch approval with dual
  control above a threshold.
- Reconciliation view: PSP settlement vs local ledger discrepancies; unresolved items block payouts.
- Commission configuration (spec §20): rules scoped by country / category / provider type / promo
  period, supporting percentage, fixed fee, or fixed + percentage, with priority ordering.

### Disputes (spec §23)
Workflow: OPEN → UNDER_REVIEW → AWAITING_EVIDENCE → RESOLVED (refund / partial refund / release /
split) → CLOSED. Request evidence from either party, freeze the payment hold, view the full timeline,
decide with justification and policy reference. Every action logged; outcomes feed the risk model.

### Reviews (spec §22)
Moderation queue for reported reviews, abuse patterns, revenge-review detection (requires a completed
job and a rating pattern check), removal with reason (audited), reply moderation.

### Support (spec §37)
Ticket inbox with SLA timers, assignment, priority, canned responses, internal notes, escalation to
dispute/refund with one click, satisfaction tracking.

### Promotions & coupons (spec §75)
Create promotions with start/end, eligibility, usage caps, budget, stacking rules, and country/category
scope. Referral programs with qualification rules and reward validation before payout (spec §76).

### Risk & fraud (spec §31)
Signal explorer (multi-account, payment anomalies, cancellation spikes, offer abuse, dispute frequency,
fake reviews, impossible travel, device anomalies), risk score per user/provider, review queue with
evidence, actions from watch → restrict → suspend → ban. **No automatic ban from a single signal** —
score plus human review. Score history is kept and explainable (spec §77).

### Geography & service areas
Country/city/postal-zone management, service availability toggles per category per area, launch-region
controls, demand vs supply heatmaps for recruiting providers.

### Notifications
Template editor per event × channel × language with variable preview; broadcast composer with audience
segmentation; delivery stats and failure inspection; per-user preference enforcement.

### Settings & feature flags
Platform fee defaults, currency defaults, category min/max, offer expiry, request expiry, cancellation
rules, verification requirements, supported languages, legal document versions, maintenance mode,
feature flags with an optional percentage rollout.

### Analytics (spec §54–55)
Requests created, requests receiving offers, average offers per request, average accepted price,
average time to first offer, average time to provider selection, completion rate, cancellation rate,
dispute rate, revenue, commission, provider earnings, customer retention, provider retention, category
performance, geographic performance, and the funnel from visit → signup → request → first offer →
selection → completion → review.

### Audit logs (spec §58)
Append-only. Columns: who, what, when, target, previous value, new value, reason, IP/device, request id,
case reference. Filter by actor, action, target type, date. Export is itself audited and rate-limited.

## 10.4 Admin sub-role → module access

| Module | SUPER | OPS | SUPPORT | FINANCE | VERIF | MOD |
|---|---|---|---|---|---|---|
| Dashboard | RW | RW | R | R | R | R |
| Users | RW | RW | R+restrict | R | R | R |
| Providers | RW | RW | R | R | R+verify | R |
| Verification docs | RW | R | — | — | RW | — |
| Catalog/forms | RW | RW | — | — | — | R |
| Requests/Offers/Jobs | RW | RW | R | R | — | R |
| Payments/Refunds | RW | R | R | RW | — | — |
| Payouts | RW | R | — | RW | — | — |
| Disputes | RW | RW | R | R+refund | — | R |
| Reviews | RW | RW | R | — | — | RW |
| Promotions | RW | RW | — | R | — | R |
| Risk | RW | RW | R | R | R | R |
| Settings/Flags | RW | R | — | — | — | — |
| Audit logs | R | R | — | R | — | — |

## 10.5 Admin safety rails

- Dual control for: mass refunds, payout batch approval above threshold, ban issuance, bulk exports,
  commission and fee changes.
- Confirmation modals state the **consequence**, not just "Are you sure?".
- Destructive actions default to reversible states (suspend before ban; restrict before suspend).
- Every admin session is subject to shorter token TTLs and mandatory MFA.
- An admin cannot approve their own dispute decision or their own payout request.

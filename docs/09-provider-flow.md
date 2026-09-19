# BIDLY — 09. Provider Flow

Design goal (spec §82): a provider must be able to see **What? Where? When? Budget?** and act in
seconds. Offers are the core action; every other screen exists to get a provider to a good offer fast.

```
Splash → Login → Provider onboarding wizard → Verification → Dashboard
                                                              │
   ┌──────────────┬──────────────┬──────────────┬─────────────┴──────────────┐
   ▼              ▼              ▼              ▼                            ▼
Online/Offline  Nearby        Active job     Offers sent            Earnings / wallet
 switch         requests      (lifecycle)    awaiting reply         payouts
                  │
                  ▼
            Request details (redacted location)
                  │
                  ▼
            Make offer / counter-offer / ask a question / decline
```

## 9.1 Onboarding wizard (required before receiving requests)

1. **Account** — email/phone, password, OTP verification.
2. **Provider type** — INDIVIDUAL or BUSINESS.
3. **Profile** — name / business name, photo, description (i18n-aware).
4. **Services** — pick categories → services from the DB catalog; set per-service pricing preference
   (accept customer price, floor price, hourly rate).
5. **Service area** — country, city, radius (km/miles), optional postal-prefix zones, base location.
6. **Availability** — weekly windows in the provider's timezone plus date exceptions.
7. **Equipment / capability** — category-driven questions (e.g. van size, towing capacity, tools).
8. **Documents** — required per service/country from `service_required_documents`.
9. **Payout method** — tokenised bank/PayPal/wallet destination (never raw card data).
10. **Agreement** — provider terms acceptance recorded in `consents`.

The wizard is resumable; completion state drives the `verification_records` ladder (doc 07 §7.4).

## 9.2 Dashboard (provider home, spec §40)

- **Online / Offline** switch (sticky, one tap). Offline = no new-request alerts, no location pings.
- **Nearby requests** feed — eligible only, with distance, category, budget, timing, urgency.
- **Active job** card with the next required action ("Head to customer", "Arrived", "Start", "Complete").
- **Today's earnings**, week-to-date, pending payout.
- **Pending offers** with expiry countdown.
- **Performance** — acceptance rate, response time, cancellation rate, rating trend.
- **Notifications** — new request, offer accepted, message, payment, verification.

## 9.3 Request feed & matching rules

Requests appear only if the provider is: ONLINE, verified to the required level, serving the category,
inside the service area/radius, available for the window, and not at capacity. The feed shows:

| Field | Shown before acceptance |
|---|---|
| Category, service, description, media | yes |
| Budget / pricing model | yes |
| Distance to pickup (rounded) | yes |
| General area (neighbourhood-level) | yes |
| Exact address | **no** |
| Customer full name / phone | **no** (first name + initial only) |
| Urgency, preferred window | yes |
| Answers to dynamic questions | yes (may include sensitive details the customer chose to share) |

Privacy before acceptance is deliberate (spec §14, §102).

## 9.4 Make an offer

Actions on a request: **Accept customer price**, **Counter-offer**, **Offer different time**,
**Ask a question**, **Decline**, or ignore. The offer form:

- Price (pre-filled with the customer's price; steppers and quick +/-)
- Message (optional, templates available)
- ETA (now / in X minutes / scheduled)
- Estimated duration
- Validity / expiry (from `offers.default_expiry_minutes` unless the provider overrides)
- Optional extra line items (materials, tolls, helpers) — each becomes part of the negotiation record

Safeguards: one active offer per provider per request (`UNIQUE` partial index), server-side eligibility
re-check, price bounds from the service config, and an `Idempotency-Key` so a double-tap cannot create
two offers.

## 9.5 Negotiation

Counter-offers are **append-only** events in `negotiation_events`; nothing is overwritten. The provider
sees the full history and can accept, reject, or counter again. A provider may withdraw while PENDING;
accepted/expired offers cannot be withdrawn.

## 9.6 Job lifecycle from the provider side

```
Offer ACCEPTED → Job CONFIRMED → [Navigate] → HEADING_TO_CUSTOMER → ARRIVED
   → [enter customer OTP or customer confirms] → JOB_STARTED
   → [work] → [upload evidence] → COMPLETED → payment captured → wallet credit
```

- **Navigate** — deep-links to the device's map app with the (now revealed) destination.
- **Arrived** — records a `job_events` entry; optional GPS proximity check when the category requires
  it.
- **Start job** — requires the customer's 4-digit OTP for services where proof of presence matters;
  otherwise an explicit customer confirmation. The OTP is generated per job, single-use, short TTL.
- **Complete job** — requires evidence per service config: photos, customer signature, or an OTP from
  the customer. Evidence lands in `job_media` / `job_completion_evidence`.
- **Cancellation** — allowed with a reason; the cancellation policy (configurable per category and
  market) decides any fee and whether the reliability score is affected. Repeat cancellations lower
  the reliability score (spec §24).

## 9.7 Earnings & wallet (spec §21)

| Panel | Contents |
|---|---|
| Available balance | withdrawable now |
| Pending balance | authorized but not captured, or in dispute hold |
| Total earnings | lifetime net of commission |
| Completed jobs | count + value |
| Withdrawals | list with status (REQUESTED → PROCESSING → PAID → FAILED) |
| Transaction history | every ledger entry with reference to the job/payment |

Balances are **derived from `wallet_transactions`**; the cached balance column is reconciled by a
trigger and a nightly job. Nothing updates a balance without a ledger row.

## 9.8 Reviews & disputes

- Provider sees incoming reviews, can post one public reply, and can report abusive reviews.
- Provider can open a dispute (customer no-show, damage, non-payment) with evidence.
- Provider can review the customer after completion — two-sided trust.

## 9.9 Provider screens (all required screens from spec §80)

Splash · Login · Signup · Provider onboarding · Document verification · Service selection ·
Service area · Availability · Dashboard · Online/offline · Requests · Request details · Make offer ·
Negotiation · Chat · Active job · Navigation · Start job · Complete job · Earnings · Wallet · Payouts ·
Reviews · Profile · Settings.

## 9.10 Provider navigation (mobile-first, spec §42)

Bottom tabs: **Home · Requests · Jobs · Earnings · Messages · Profile**

## 9.11 Empty & error states

| Screen | Empty | Error |
|---|---|---|
| Requests feed | "No matching requests right now. You're online — we'll alert you." | "Couldn't refresh requests." + retry |
| Pending offers | "You have no offers waiting." | stale badge + refresh |
| Active job | "No active job." + link to requests | "Status may be out of date." + refresh |
| Earnings | "Complete your first job to see earnings here." | show last-known values + retry |
| Wallet | "Your wallet will appear after your first completed job." | retry, never fabricate a balance |
| Payouts | "No payouts yet." + eligibility note | "Payout status unknown — don't retry." |

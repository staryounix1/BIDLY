# BIDLY — 08. Customer Flow

Design goal: the customer should feel they are **telling us what they need**, not filling a form
(spec §81). Progressive disclosure, one decision per screen, everything pre-fillable.

```
Splash → Onboarding → Home
                        │
   ┌────────────────────┼──────────────────────────────────────────────┐
   ▼                    ▼                                              ▼
Login/Signup      "What do you need?"                        Active jobs / history
                        │
                        ▼
                 Category picker (from DB)
                        │
                        ▼
                 Service picker (from DB)
                        │
                        ▼
              Request composer (dynamic form)
                        │
                        ▼
                 Location + timing + budget
                        │
                        ▼
                 Review & publish
                        │
                        ▼
          Searching / matching (live status)
                        │
                        ▼
              Offers stream in (realtime)
                        │
                        ▼
              Compare offers side-by-side
                        │
                        ▼
              Provider profile + reviews
                        │
                        ▼
                 Accept offer → JOB
                        │
                        ▼
          Chat · track · OTP start · completion
                        │
                        ▼
                 Payment captured
                        │
                        ▼
                 Rate the provider
                        │
                        ▼
            History · receipts · support
```

## 8.1 Step detail

### Step 1 — Open app
- Splash with original BIDLY mark, tagline "Post it. Let providers compete."
- Buttons: **Log in**, **Sign up**, **Continue browsing** (guest can browse catalog only; publishing
  requires an account).
- Session restore from refresh cookie → straight to the correct home (customer or provider).

### Step 2 — Choose service
- "What do you need?" search box + category cards rendered from `GET /catalog/categories`.
- Categories are DB-driven; icons are stored as a slug referencing the design system's icon set.
- Recent requests and recommended categories shown for returning users (personalised by history, not
  a hidden ranking of providers).

### Step 3 — Create request (dynamic)
- Form is generated from `service_fields` for the chosen service. Field types: `text`, `textarea`,
  `number`, `money`, `select`, `multiselect`, `radio`, `checkbox`, `date`, `datetime`, `time`,
  `address`, `location`, `photo`, `video`, `file`, `boolean`, `slider`, `otp`.
- Fields carry `required`, `validation` (min/max/regex), `group` (section), `order`, `help_text`,
  `placeholder`, i18n keys — so a new service needs zero frontend work (spec §28).
- **AI assist (optional):** a single free-text box "Describe what you need" calls
  `POST /requests/parse`, which proposes values across fields. **The user must review and confirm**
  each extracted value before publish (spec §72).
- Autosave draft to `requests` with `status=DRAFT`.

### Step 4 — Location, timing, urgency
- Location picker: current location, address search, map pin, saved addresses.
- Timing: ASAP / scheduled date+time window.
- Urgency: flexible / today / within hours (drives match radius and notification urgency).
- Privacy: the exact address is stored, but providers only see a rounded location + distance until
  selection.

### Step 5 — Budget ("Your offer price")
- Copy: *"You choose the amount you're willing to pay. Providers may accept your offer or send
  another offer."*
- Pricing mode comes from `service_pricing_models`:
  - `FIXED` — price is set, providers can only accept/decline
  - `OFFER` — customer proposes, providers counter freely
  - `RANGE` — customer sets min–max, providers bid inside
  - `HOURLY` — rate × estimated hours
  - `QUOTE` — no price yet; providers must send a full quote
- Currency follows the request's country; amounts are validated server-side against category
  min/max and are stored in minor units.

### Step 6 — Review & publish
- Summary cards, edit shortcuts, total price preview including any customer-side fee.
- Publishing = `POST /requests/:id/publish`: state `DRAFT → PUBLISHED → MATCHING`, matching starts
  immediately, and the customer sees the searching screen.

### Step 7 — Searching / matching
- Live screen: "Finding providers near you…", pulsing map with the request area, count of providers
  notified, elapsed time.
- Honest messaging: if nobody is eligible, this is stated immediately rather than faking activity.
- If no offer arrives in the configured window: the spec-§101 recovery card appears (below).

### Step 8 — Offers
- Offers arrive over the WebSocket and animate into the list.
- Each offer card: price, provider name/photo, rating, completed jobs, distance, ETA, verification
  badges, response time, cancellation rate, message preview.
- Offer countdown timer when the offer has an expiry.
- Filters: cheapest, fastest, highest rated, verified only. **Sorting is neutral** — no hidden
  selection algorithm (spec §11).

### Step 9 — Compare
- Side-by-side table for 2–4 offers with a "best value" highlight that is **explainable** (it shows
  which metric won). The customer always makes the final choice.

### Step 10 — Provider profile
- Public trust profile: photo, name/business, description, services, rating, completed jobs, reviews,
  member since, verification badges, response rate, cancellation rate, portfolio where applicable.

### Step 11 — Accept offer
- Confirmation screen shows final price, fees, ETA and cancellation policy **before** confirming.
- Server performs the transactional accept (doc 67): locks the request, re-validates the offer,
  accepts it, rejects competing offers per rules, creates the job, creates the payment intent.
- Other providers are notified politely that the job was awarded.

### Step 12 — Job tracking
- Status timeline: CONFIRMED → provider HEADING_TO_CUSTOMER → ARRIVED → JOB_STARTED → COMPLETED.
- Chat with the provider (participant-scoped).
- Provider phone number revealed only after CONFIRMED; exact address revealed at the same point.
- Start OTP: customer sees a 4-digit code to give the provider at the door.

### Step 13 — Payment
- On accept: `PAYMENT_AUTHORIZED` (held, not charged).
- On job completion + customer confirmation: `PAYMENT_CAPTURED`; commission split recorded.
- UI never says "paid" before the provider's webhook confirms capture (spec §103). States shown as
  *Holding*, *Charged*, *Refunded* with receipts.

### Step 14 — Review
- Prompted after completion; 1–5 stars plus optional category scores (communication, professionalism,
  quality, punctuality, value) and text. Duplicate/early reviews are blocked server-side.

### Step 15 — Recovery when no providers (spec §101)
The customer sees: *"We couldn't find an available provider right now."* plus actionable options:
- Expand the service area
- Increase the budget
- Change the schedule
- Try another category
- Repost the request
None of these are dead ends — each pre-fills the existing request.

## 8.2 Customer screens (all required screens from spec §80)

Splash · Onboarding · Login · Signup · Home · Category list · Service selection · Request creation ·
Location picker · Budget · Request review · Searching/matching · Offers · Offer comparison ·
Provider profile · Chat · Active job · Job tracking · Payment · Completion · Review · History ·
Profile · Settings · Support · Notifications.

## 8.3 Customer navigation (mobile-first, spec §42)

Bottom tabs: **Home · Requests · Messages · Activity · Profile**
- Requests — active + draft + history with status chips
- Messages — conversations (request, job, dispute, support)
- Activity — job timeline, payments, receipts
- Profile — addresses, payment methods, favourites, language, notifications, support, legal

## 8.4 Empty, loading and error states (spec §83–85)

| Screen | Empty state | Loading | Error |
|---|---|---|---|
| Home | "Tell us what you need and providers will start sending offers." | skeleton category cards | retry + offline banner |
| Requests | "No requests yet. Post your first one." + CTA | skeleton list | cached list + retry |
| Offers | "We're notifying providers near you…" with live count | offer skeletons + pulse | "Still searching" + recovery card |
| Messages | "Your conversations will appear here." | skeleton bubbles | "Messages unavailable, retrying…" |
| Active job | "No active job right now." | skeleton timeline | stale-status note + refresh |
| History | "Completed jobs will appear here." | skeleton rows | retry |
| Payment | — | processing spinner with honest state | "Payment not completed. Nothing was charged." |

Loading always uses skeletons, never a blank screen. Offline shows a banner and queues safe retries —
financial operations are **never** auto-retried blindly (spec §85).

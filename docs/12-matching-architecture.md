# BIDLY — 12. Matching Architecture

The matching engine decides **who may see a request**. It never chooses a provider for the customer
(spec §8, §11). Selection is always the customer's decision.

## 12.1 Pipeline

```
 request PUBLISHED
        │
        ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ 1. CANDIDATE PRE-FILTER (SQL, indexed, cheap)                   │
 │    • provider_services covers the requested service             │
 │    • provider status = ACTIVE and online_mode = ONLINE          │
 │    • verification_level >= service.required_verification_level  │
 │    • bounding box / geohash on primary location                 │
 │    • country matches request country                            │
 └──────────────────────────┬──────────────────────────────────────┘
                            ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ 2. ELIGIBILITY FILTER (application, precise)                    │
 │    • haversine distance <= provider service radius              │
 │    • availability window intersects request window (timezone)   │
 │    • capacity: active_jobs < provider.max_concurrent_jobs       │
 │    • equipment/vehicle requirements from service rules          │
 │    • provider not blocked by the customer; customer not blocked │
 │    • not already offered / declined this request                │
 │    • service enabled in this country/city                       │
 └──────────────────────────┬──────────────────────────────────────┘
                            ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ 3. SCORING (ranking only, transparent)                          │
 │    score = w1·proximity + w2·rating + w3·reliability            │
 │          + w4·response_speed + w5·acceptance_history            │
 │          + w6·workload_balance − w7·recent_declines             │
 │    All weight sets are stored in settings per category.         │
 └──────────────────────────┬──────────────────────────────────────┘
                            ▼
 ┌─────────────────────────────────────────────────────────────────┐
 │ 4. FAN-OUT (dispatch)                                           │
 │    • take top N (settings.match_fanout, default 25)             │
 │    • write match_run + match_candidate rows (score + reasons)   │
 │    • enqueue notifications (push/email/in-app) via outbox       │
 │    • open a realtime room for the request                       │
 └──────────────────────────┬──────────────────────────────────────┘
                            ▼
              request status → RECEIVING_OFFERS
```

## 12.2 Scaling dispatch

- Matching runs **asynchronously** via a BullMQ job so publishing a request is fast.
- `match_runs` records the input snapshot; `match_candidates` records the outcome per provider,
  including a `reasons` JSONB explaining inclusion/exclusion. This makes support and debugging
  possible ("why didn't I see this request?").
- If fewer than `min_candidates` are found, the engine performs **expanding rings** (1.5× → 2× → 3×
  radius) before giving up, and records each ring in the run.
- If still zero: the request stays `PUBLISHED` in a low-frequency re-match loop (every 5 min) until
  `request_expires_at`, and the customer is offered the spec-§101 recovery card immediately.

## 12.3 Eligibility signals & their sources

| Signal | Source |
|---|---|
| Category / service coverage | `provider_services` |
| Geographic area | `provider_service_areas` + provider base location |
| Distance | haversine / (phase 2) PostGIS `ST_DWithin` |
| Availability & schedule | `provider_availability` + timezone of country |
| Online status | `providers.online_mode` + `last_online_at` |
| Verification | `verification_records` ladder vs `services.required_verification_level` |
| Rating | `user_rating_stats.avg_rating` |
| Reliability | trust score (doc 31) |
| Workload | count of jobs in ACTIVE states |
| Equipment / vehicle | category-driven provider capability answers |
| Service radius | `provider_service_areas.radius_km` |
| Blocks | `user_blocks` |
| Already invited / declined | `match_candidates`, `offers` |

## 12.4 Scoring detail

```
proximity_norm      = clamp(1 − distance / max(radius, service.default_radius), 0, 1)
rating_norm         = avg_rating / 5
reliability_norm    = trust_score / 100
response_norm       = clamp(1 − median_response_seconds / 900, 0, 1)
acceptance_norm     = acceptance_rate_30d
workload_norm       = clamp(1 − active_jobs / max_concurrent_jobs, 0, 1)
decline_penalty     = clamp(recent_declines_7d / 10, 0, 1)

score = 100 * ( w1*proximity_norm + w2*rating_norm + w3*reliability_norm
              + w4*response_norm  + w5*acceptance_norm + w6*workload_norm )
        − 100 * w7 * decline_penalty
```

Weights live in `settings` and are configurable per category and country, so a towing marketplace can
weight proximity heavily while a design marketplace weights rating and reliability.

New providers get a **cold-start boost** (`settings.new_provider_boost`) for their first N jobs so the
marketplace is not winner-take-all; the boost is recorded in `match_candidates.reasons` so it is
auditable and never hidden.

## 12.5 Anti-starvation & fairness

- The fan-out cap prevents notifying hundreds of providers for one small job.
- Providers who receive many requests but never respond get a decreasing score (decline penalty).
- Distribution monitoring alerts when a small set of providers wins a disproportionate share of a
  category, which surfaces both super-sellers and possible gaming.
- Sponsored placement, if ever introduced, must be labelled in the UI (spec §78).

## 12.6 Re-matching triggers

| Trigger | Action |
|---|---|
| Request published | initial run |
| No offers after `settings.rematch_after_minutes` | re-run with a wider ring |
| All offers expired | re-run + notify customer |
| Customer edited schedule | re-run and notify the previous candidates |
| Provider went offline mid-request | remove from active candidate set |
| Request reposted | fresh run, previous run archived |

# BIDLY — 13. Notification Architecture

## 13.1 Channels

| Channel | MVP | Notes |
|---|---|---|
| In-app (`notifications` table + WS badge) | ✅ | always on, cannot be disabled |
| Web Push (VAPID) for the PWA | ✅ | opt-in per user, per category |
| Email | ✅ | transactional, provider-agnostic adapter |
| SMS | phase 2 | per-country vendor; costly, so gated by event importance |
| Native push (FCM/APNs) | phase 3 | when a native shell exists |

## 13.2 Event catalogue

| Event key | Customer | Provider | Admin | Channels |
|---|---|---|---|---|
| `request.published` | — | ✅ | — | push, in-app |
| `request.offer_received` | ✅ | — | — | push, email(digest), in-app |
| `offer.created` | — | — | — | in-app |
| `offer.countered` | ✅ | ✅ | — | push, in-app |
| `offer.accepted` | ✅ | ✅ | — | push, email, in-app, WS |
| `offer.rejected` | ✅ | — | — | in-app |
| `offer.expiring_soon` | ✅ | ✅ | — | push, in-app |
| `request.expiring_soon` | ✅ | — | — | push, in-app |
| `request.expired` | ✅ | — | — | push, in-app |
| `job.provider_arriving` | ✅ | — | — | push, in-app, WS |
| `job.started` | ✅ | ✅ | — | in-app, WS |
| `job.completed` | ✅ | ✅ | — | push, in-app, WS |
| `payment.authorized` | ✅ | ✅ | — | email, in-app |
| `payment.captured` | ✅ | ✅ | — | email(receipt), in-app |
| `payment.failed` | ✅ | — | — | push, email, in-app |
| `refund.created` | ✅ | ✅ | — | email, in-app |
| `payout.paid` | — | ✅ | — | email, in-app |
| `review.requested` | ✅ | ✅ | — | push, in-app |
| `review.received` | ✅ | ✅ | — | push, in-app |
| `dispute.updated` | ✅ | ✅ | ✅ | push, email, in-app |
| `verification.approved` / `.rejected` | — | ✅ | — | push, email, in-app |
| `support.replied` | ✅ | ✅ | — | push, in-app |
| `admin.announcement` | ✅ | ✅ | ✅ | configurable |
| `security.new_device_login` | ✅ | ✅ | — | email, in-app |

## 13.3 Delivery pipeline

```
 domain action (inside tx)
        │
        ▼
 outbox_events (same transaction!)          ← no lost side effects
        │
        ▼ (outbox worker)
 notification_dispatch job
        │
        ├── resolve recipients (user ids, locale, timezone)
        ├── render template (event + locale + variables)   ← notification_templates
        ├── filter by notification_preferences (channel × event × quiet hours)
        ├── deduplicate on (event_id, user_id, channel)     ← notification_deliveries UNIQUE
        ├── enqueue per-channel jobs
        └── write notifications rows (in-app) + WS emit
                │
                ├── push job      → PushProvider
                ├── email job     → EmailProvider (retry w/ backoff)
                └── sms job       → SmsProvider
```

**Transactional outbox** is the key design choice: the notification intent is committed atomically with
the business change, so a crash can never leave "job completed but nobody told". Workers consume the
outbox with at-least-once delivery, and the delivery table's unique constraint makes that
**effectively exactly-once** for the user (spec §63).

## 13.4 Templates

Stored in `notification_templates`: `event_key`, `channel`, `locale`, `subject`, `body`, `variables`
(JSONB schema), `version`, `active`. Rendered with a strict template engine (no arbitrary code) and
escaped per channel (HTML-escaped for email, plain for push/SMS).

Variables are an allow-list per event — a template cannot access data it was not handed, which prevents
an admin from accidentally emailing a customer a provider's private data.

## 13.5 User preferences

`notification_preferences(user_id, event_key, channel, enabled, quiet_hours_start,
quiet_hours_end, timezone)`.

Rules:
- Security and money events (`payment.failed`, `security.new_device_login`, `dispute.updated`) are
  **mandatory in-app + email** and cannot be fully disabled.
- Marketing events require explicit opt-in and honour country-specific consent law.
- Quiet hours defer non-urgent push until the window ends; urgent events (provider arriving) bypass.
- A global "pause all non-essential" switch exists in settings.

## 13.6 Idempotency & reliability

- `notification_deliveries UNIQUE(event_id, user_id, channel)` prevents duplicates from worker retries.
- Retries use exponential backoff with jitter; after N attempts the delivery is marked `FAILED` and
  surfaced in the admin delivery inspector.
- Provider adapters are wrapped in a circuit breaker so a dead email vendor cannot stall the queue.
- Every push subscription that returns 410/404 is auto-deactivated.
- A daily digest option exists for non-urgent customer notifications so we do not train users to mute
  the app.

## 13.7 i18n

Templates exist per locale (`en`, `fr`, `ar`) with `ar` rendered RTL. The recipient's locale and
timezone come from `user_profiles` / `users.locale` / country defaults, and times are always rendered
in the user's timezone (stored UTC, spec §48).

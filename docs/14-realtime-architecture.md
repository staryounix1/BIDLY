# BIDLY — 14. Real-Time Architecture

## 14.1 Why WebSockets (and not polling)

Offers arriving, chat messages, job status changes and tracking updates are all latency-sensitive and
bursty. Polling would waste mobile battery and server CPU, and would make the offer experience feel
dead (spec §50). We use Socket.IO with the Redis adapter so gateways scale horizontally.

## 14.2 Connection & auth

```
client connects  ──►  gateway verifies access JWT (short TTL)
                       ├─ invalid/expired ─► server emits 'auth:refresh_required', client refreshes,
                       │                     reconnects with a new token (no silent failure)
                       └─ valid ─► bind socket to userId, roles, locale
```

- One socket per device; multiple tabs multiplex or open separate sockets, both supported.
- On token expiry the gateway keeps the socket but marks it unauthenticated for privileged emits until
  refreshed; it does not silently leak data.
- Server-side every room join is re-authorised against the database (a client cannot join a room it
  does not own by guessing an id).

## 14.3 Rooms / channels

| Room | Members | Events |
|---|---|---|
| `user:{userId}` | that user's sockets | personal notifications, offer updates, job updates |
| `request:{requestId}` | the customer + matched providers | `request:updated`, `offer:created`, `offer:updated` |
| `conversation:{conversationId}` | participants only | `message:new`, `message:read`, `typing` |
| `job:{jobId}` | customer + assigned provider | `job:status`, `tracking:update`, `payment:status` |
| `dispute:{disputeId}` | customer, provider, assigned agents | `dispute:updated` |
| `admin:ops` | admin roles | queues, risk alerts, live metrics |
| `provider:{providerId}` | provider account + members | new eligible requests |

## 14.4 Event catalogue (server → client)

| Event | Payload | Trigger |
|---|---|---|
| `notification:new` | notification row | outbox dispatcher |
| `request:matched` | run summary (counts only) | match run complete |
| `request:updated` | status projection | request state machine |
| `offer:created` | offer + provider trust summary | offer created |
| `offer:updated` | status/price change | accept/reject/withdraw/expire |
| `offer:expiring` | offer id + seconds left | scheduler |
| `negotiation:event` | counter event | negotiation append |
| `job:status` | {jobId, status, actor, at} | job state machine |
| `tracking:update` | {jobId, lat, lng, heading, at} | provider ping |
| `payment:status` | {paymentId, state} | payment state machine / webhook |
| `message:new` | message row | message insert |
| `message:read` | reader + message ids | read receipt |
| `wallet:updated` | balances | ledger insert |
| `admin:alert` | risk / operational alert | fraud worker |

## 14.5 Client → server (all validated, most are REST instead)

Sockets carry only: `conversation:join`, `conversation:typing`, `job:subscribe`,
`provider:location` (rate-limited to 1 per 10 s per provider). Everything state-changing goes through
REST so validation, idempotency and audit live in one place.

## 14.6 Tracking design (privacy + battery, spec §15)

- Provider location is shared **only** when a job is in
  `HEADING_TO_CUSTOMER | ARRIVED | IN_PROGRESS` **and** the provider has tracking enabled for that job.
- Ping cadence adapts: 15 s while heading to customer, 60 s after arrival, 0 when completed/offline.
- If the distance to the customer is large, cadence drops (no need for per-second updates).
- Pings are written to `job_tracking_pings` (partitioned by day, auto-purged after 30 days) and
  broadcast on `job:{jobId}` only.
- The customer sees a smoothed position, never a raw breadcrumb history.
- If a WebSocket drops, the client falls back to a slow REST poll (every 30 s) rather than a tight loop.

## 14.7 Reconnection & consistency

Sockets are treated as an optimization, never the source of truth:

- On reconnect the client re-fetches the affected resource over REST (`GET /jobs/:id`, messages cursor)
  and then resumes incremental updates over WS.
- Events carry a monotonic `seq` per room; the client discards out-of-order/duplicate events and
  requests a resync if it detects a gap.
- Every WS payload includes the entity's `updatedAt` so the client can prefer the fresher of
  (WS event, REST response).

## 14.8 Scaling

```
        ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
        │  WS gateway  │   │  WS gateway  │   │  WS gateway  │
        └───────┬──────┘   └───────┬──────┘   └───────┬──────┘
                └──────────────┬───┴──────────────────┘
                               ▼
                     ┌──────────────────┐
                     │  Redis pub/sub   │   room broadcasts cross-instance
                     └──────────────────┘
                               ▲
                     API instances publish domain events after commit
```

- Gateways are stateless apart from their socket map, so autoscaling is trivial.
- Publishers publish **after** the transaction commits, via the outbox worker, so no client ever
  receives an event for a change that was rolled back.
- Backpressure: per-socket emit queue with a cap; slow clients get coalesced updates, not infinite
  buffering.

## 14.9 Security

- Every emit is authorised against the room membership resolved from the database, not from client
  claims.
- Private media uses signed URLs; the socket never carries permanent links.
- Rate limits per socket for inbound events (typing, location).
- No sensitive data (full address, phone, payment details) is put in a broadcast payload before the
  allowed lifecycle stage — the same redaction rules as REST apply.
- A revoked session closes its sockets on the next auth check (max 15 min) and immediately on explicit
  logout via the `user:{id}` room.

# BIDLY — 11. Payment Architecture

## 11.1 Principles

1. The core never imports a PSP SDK outside its adapter.
2. Money is integer minor units + currency code, always.
3. No user-visible "paid / captured / refunded" before the PSP (or our webhook-confirmed state) says so.
4. Every money mutation is idempotent.
5. Every balance change has a ledger row.

## 11.2 `PaymentProvider` interface

```ts
export interface PaymentProvider {
  readonly id: string;                       // 'stripe' | 'paypal' | 'adyen' | 'cmi' ...

  // Methods (tokenised): return only opaque tokens, never PAN/CVV
  createPaymentMethod(input: CreateMethodInput): Promise<PaymentMethodResult>;

  // Money movement
  authorize(intent: AuthorizeIntent): Promise<AuthorizationResult>;   // hold
  capture(ref: CaptureRef): Promise<CaptureResult>;                   // take
  void(ref: VoidRef): Promise<VoidResult>;                            // release hold
  refund(ref: RefundRef): Promise<RefundResult>;                      // full or partial

  // Payouts (provider earnings out)
  createPayout(input: PayoutInput): Promise<PayoutResult>;
  getPayout(ref: PayoutRef): Promise<PayoutResult>;

  // Webhooks
  verifyWebhook(raw: Buffer, headers: Headers): WebhookEvent;
  parseWebhook(raw: Buffer, headers: Headers): NormalizedWebhookEvent;
}

export interface AuthorizeIntent {
  idempotencyKey: string;
  amountMinor: bigint;
  currency: string;
  jobId: string;
  customerId: string;
  paymentMethodToken: string;
  captureMethod: 'automatic' | 'manual';
  metadata: Record<string, string>;
}
```

Adapters: `StripeAdapter` (first), then `PaypalAdapter`, `AdyenAdapter`, and regional adapters
(CMI / Payzone for Morocco, etc.). `payment_provider_countries` maps country+currency → allowed
providers; the payment module picks the adapter at runtime.

## 11.3 Payment lifecycle

```
                     ┌──────────────────┐
                     │ PAYMENT_REQUIRED │  job created, no auth yet
                     └────────┬─────────┘
                              │ customer confirms / job accepted
                              ▼
                   ┌────────────────────┐
                   │ PAYMENT_AUTHORIZED │  funds held on the method
                   └───┬────────────┬───┘
        job starts ok  │            │ auth expires / fails
                       ▼            ▼
        ┌────────────────┐   ┌───────────────┐
        │  IN_ESCROW     │   │ PAYMENT_FAILED│ → customer retries; job may auto-cancel
        │ (held, work    │   └───────────────┘
        │  in progress)  │
        └───┬────────┬───┘
  completed │        │ dispute opened
            ▼        ▼
   ┌────────────────┐  ┌──────────────────┐
   │ PAYMENT_CAPTURED│ │ PAYMENT_HELD      │ → dispute resolution
   │ + commission    │ │ (frozen)          │
   │ + wallet credit │ └────────┬──────────┘
   └────────┬────────┘          │
            │                   ├─► PAYMENT_CAPTURED (release to provider)
            │                   └─► PAYMENT_REFUNDED / PARTIALLY_REFUNDED
            ▼
   ┌────────────────┐
   │ PAYOUT_ELIGIBLE│ → payout batch → PAID
   └────────────────┘
```

State transitions are validated by the payment state machine and only advanced by
(a) our own transaction after a PSP call succeeds, or (b) a verified PSP webhook.

## 11.4 Capture-on-completion model (MVP)

| Moment | Action |
|---|---|
| Offer accepted | `authorize` (hold) for the agreed amount; job → CONFIRMED |
| Provider arrived / started | no money movement; hold remains |
| Provider completes | evidence recorded; `payment.capture_ready = true` |
| Customer confirms (or auto-confirm window elapses per category) | `capture` |
| On capture success | write `payment_transactions(CAPTURE)`, `commission_ledger`, credit provider wallet (pending → available per hold policy) |
| On dispute | hold the wallet credit (`wallet_transactions(HOLD)`), freeze capture if not yet captured |

If the authorization expires before completion, the system re-authorizes once and notifies both
parties rather than failing silently.

## 11.5 Commission (spec §20)

`commission_rules` fields: `scope` (GLOBAL | COUNTRY | CATEGORY | SERVICE | PROVIDER_TYPE | PROMO),
`priority` (higher wins; most specific wins), `model` (PERCENT | FIXED | FIXED_PLUS_PERCENT),
`rate_bps` (basis points, integer), `fixed_minor`, `currency`, `min_fee_minor`, `max_fee_minor`,
`effective_from`, `effective_to`, `active`.

Evaluation: filter active rules matching (country, category, service, provider type, promo) with
`now` inside the effective window → sort by specificity then priority → first match wins.
The **entire rule snapshot is copied into `commission_ledger`** so historical splits remain provable
even after admins change rates.

Example: `PERCENT 1000 bps` on a $100 job → commission $10, provider $90.
`FIXED_PLUS_PERCENT` `$2 + 5%` on $100 → $7 commission, $93 provider.

## 11.6 Refunds (spec §23, §103)

- Full or partial, initiated by admin (disputes) or by cancellation policy.
- Refund amount ≤ captured amount − already refunded; enforced in SQL.
- Every refund creates a `refunds` row plus `payment_transactions(REFUND)` and, if the provider was
  already credited, a compensating `wallet_transactions(DEBIT)`.
- The UI states "Refund initiated", then "Refunded" only after the PSP webhook confirms.
- `refunds.psp_refund_id` unique → webhook replay cannot double-refund.

## 11.7 Cancellation fees & policy

`cancellation_rules` fields: `scope`, `cancelled_by` (CUSTOMER|PROVIDER), `stage`
(BEFORE_ACCEPT | AFTER_ACCEPT_BEFORE_START | AFTER_START), `fee_model` (NONE | FIXED | PERCENT |
PERCENT_CAPPED), `value`, `cap_minor`, `reliability_impact`, `active`.
Evaluated server-side from the job's actual stage at cancellation time. Provider-cancellation
reliability impact feeds the trust score (spec §24, §77).

## 11.8 Ledger model

```
payments               (1 per job attempt)         state, amount, currency, psp, psp_ref
payment_transactions   (append-only)               AUTHORIZE | CAPTURE | VOID | REFUND | FEE | ADJUSTMENT
commission_ledger      (append-only)               gross, commission, net, rule snapshot
refunds                (append-only)               amount, reason, psp_refund_id (unique)
wallets                (1 per provider)            cached available/pending/total (derived)
wallet_transactions    (append-only)               CREDIT | DEBIT | HOLD | RELEASE | PAYOUT
payouts + payout_items (batch out)                 REQUESTED → PROCESSING → PAID | FAILED
```

**Invariant:** `wallets.available_minor = SUM(wallet_transactions)` for that wallet with the correct
signs; enforced by a DB function invoked on every insert, plus a nightly reconciliation job that
alerts on drift instead of silently fixing it.

## 11.9 Idempotency (spec §61)

- Every money POST requires `Idempotency-Key`.
- `idempotency_keys(scope, key, request_hash, response_body, status)` with `UNIQUE(scope, key)`.
- Behaviour: first call executes and stores the response; a replay with the same key returns the stored
  response; a replay with the same key but a **different body** returns `409 IDEMPOTENCY_KEY_REUSED`.
- Keys are sent downstream to the PSP too, so a network timeout on our side cannot double-charge.
- Payouts, refunds and captures are all idempotent by the same mechanism plus unique PSP references.

## 11.10 Security & compliance

- **No PAN, no CVV, ever.** Card data is collected by the PSP's hosted/SDK fields; we persist only a
  token plus brand/last4/expiry for display.
- PCI scope stays SAQ-A.
- All webhooks: signature verification with constant-time comparison, replay window, and idempotent
  handling keyed by the PSP event id.
- 3-D Secure / SCA is driven by the adapter's `requires_action` response; the job pauses in
  `PAYMENT_REQUIRED` until the action completes.
- Tax: `tax_rules` per country/category, computed server-side, stored on the payment record and
  printed on receipts; configurable so a market can opt out.
- Receipts are generated server-side and stored; customers can always retrieve them.
- Reconciliation runs daily: PSP settlement file vs ledger; unresolved deltas create a finance task and
  block the affected provider's payout until resolved.

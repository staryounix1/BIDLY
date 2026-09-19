import type { PaymentMethod, PaymentStatus, LedgerType, LedgerDirection } from '@bidly/types';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { computeCommission, money, type CommissionRule } from '@bidly/money';
import { AppError, ERROR_CODES, notFound, paymentProviderError } from '../../core/errors.js';

/**
 * Payment provider abstraction.
 *
 * The platform never stores card numbers, CVVs, or any sensitive instrument
 * data. It stores only: which provider handled the payment, the provider's
 * own reference, the amount, the status, and a redacted payload log.
 *
 * Adding CMI, Stripe, PayPal, or cash-on-delivery means implementing this
 * interface — no marketplace logic changes.
 */

export interface PaymentIntent {
  providerRef: string;
  status: PaymentStatus;
  clientSecret?: string;
  redirectUrl?: string;
  raw?: Record<string, unknown>;
}

export interface PaymentResult {
  providerRef: string;
  status: PaymentStatus;
  amountMinor: number;
  currency: string;
  raw?: Record<string, unknown>;
}

export interface RefundResult {
  providerRef: string;
  status: 'COMPLETED' | 'PROCESSING' | 'FAILED';
  amountMinor: number;
  raw?: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly name: string;
  readonly supportsPartialRefund: boolean;
  readonly supportsAuthorization: boolean;

  createIntent(params: {
    paymentId: string;
    amountMinor: number;
    currency: string;
    method: PaymentMethod;
    customerId: string;
    jobId: string;
    idempotencyKey: string;
    metadata?: Record<string, string>;
  }): Promise<PaymentIntent>;

  authorize(params: { providerRef: string; amountMinor: number; currency: string; idempotencyKey: string }): Promise<PaymentResult>;

  capture(params: { providerRef: string; amountMinor: number; currency: string; idempotencyKey: string }): Promise<PaymentResult>;

  void(params: { providerRef: string; idempotencyKey: string }): Promise<PaymentResult>;

  refund(params: { providerRef: string; amountMinor: number; currency: string; idempotencyKey: string }): Promise<RefundResult>;

  verifyWebhookSignature(payload: string, signature: string): boolean;

  normalizeWebhook(payload: unknown): {
    providerRef: string | null;
    eventType: string;
    status: PaymentStatus | null;
    amountMinor: number | null;
    failureCode?: string;
  };
}

// ---------------------------------------------------------------------
// Internal provider — used for development, cash, and wallet payments.
// It is a real, deterministic bookkeeping provider: it does not pretend to
// move money with a card network.
// ---------------------------------------------------------------------

export class InternalPaymentProvider implements PaymentProvider {
  readonly name = 'internal';
  readonly supportsPartialRefund = true;
  readonly supportsAuthorization = true;

  async createIntent(params: {
    paymentId: string;
    amountMinor: number;
    currency: string;
    method: PaymentMethod;
    idempotencyKey: string;
  }): Promise<PaymentIntent> {
    if (params.amountMinor < 0) throw paymentProviderError('negative amount');
    return {
      providerRef: `int_${params.paymentId.replace(/-/g, '').slice(0, 20)}`,
      status: 'PENDING',
      raw: { method: params.method, idempotencyKey: params.idempotencyKey },
    };
  }

  async authorize(params: { providerRef: string; amountMinor: number }): Promise<PaymentResult> {
    return {
      providerRef: params.providerRef,
      status: 'AUTHORIZED',
      amountMinor: params.amountMinor,
      currency: 'MAD',
      raw: { simulated: true },
    };
  }

  async capture(params: { providerRef: string; amountMinor: number; currency: string }): Promise<PaymentResult> {
    return {
      providerRef: params.providerRef,
      status: 'CAPTURED',
      amountMinor: params.amountMinor,
      currency: params.currency,
      raw: { simulated: true },
    };
  }

  async void(params: { providerRef: string }): Promise<PaymentResult> {
    return { providerRef: params.providerRef, status: 'VOIDED', amountMinor: 0, currency: 'MAD' };
  }

  async refund(params: { providerRef: string; amountMinor: number; currency: string }): Promise<RefundResult> {
    return {
      providerRef: params.providerRef,
      status: 'COMPLETED',
      amountMinor: params.amountMinor,
    };
  }

  verifyWebhookSignature(_payload: string, _signature: string): boolean {
    // The internal provider has no external webhooks.
    return false;
  }

  normalizeWebhook(): { providerRef: null; eventType: string; status: null; amountMinor: null } {
    throw new AppError({ code: ERROR_CODES.PAYMENT_PROVIDER_ERROR, message: 'The internal provider does not receive webhooks.' });
  }
}

// ---------------------------------------------------------------------
// Development webhook provider.
//
// A provider that can actually deliver verified webhooks is needed to exercise
// the webhook path end to end without live card-network credentials. This one
// signs payloads with HMAC-SHA256 over the shared `PAYMENT_WEBHOOK_SECRET`, so
// signature verification is real and replay protection is testable. It reuses
// the same deterministic bookkeeping as the internal provider.
// ---------------------------------------------------------------------

export class SignedWebhookProvider implements PaymentProvider {
  readonly name = 'internal-webhook';
  readonly supportsPartialRefund = true;
  readonly supportsAuthorization = true;
  private readonly secret: string;
  private readonly inner = new InternalPaymentProvider();

  constructor(secret: string) {
    this.secret = secret;
  }

  createIntent(params: Parameters<PaymentProvider['createIntent']>[0]): Promise<PaymentIntent> {
    return this.inner.createIntent(params);
  }

  authorize(params: Parameters<PaymentProvider['authorize']>[0]): Promise<PaymentResult> {
    return this.inner.authorize(params);
  }

  capture(params: Parameters<PaymentProvider['capture']>[0]): Promise<PaymentResult> {
    return this.inner.capture(params);
  }

  void(params: Parameters<PaymentProvider['void']>[0]): Promise<PaymentResult> {
    return this.inner.void(params);
  }

  refund(params: Parameters<PaymentProvider['refund']>[0]): Promise<RefundResult> {
    return this.inner.refund(params);
  }

  verifyWebhookSignature(payload: string, signature: string): boolean {
    if (!this.secret || !signature) return false;
    const expected = createHmac('sha256', this.secret).update(payload).digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(signature.replace(/^sha256=/, ''), 'hex');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  normalizeWebhook(payload: unknown): {
    providerRef: string | null;
    eventType: string;
    status: PaymentStatus | null;
    amountMinor: number | null;
    failureCode?: string;
  } {
    const p = (payload ?? {}) as Record<string, unknown>;
    const status = typeof p.status === 'string' ? (p.status as PaymentStatus) : null;
    return {
      providerRef: typeof p.providerRef === 'string' ? p.providerRef : null,
      eventType: typeof p.eventType === 'string' ? p.eventType : 'payment.updated',
      status,
      amountMinor: typeof p.amountMinor === 'number' ? p.amountMinor : null,
      failureCode: typeof p.failureCode === 'string' ? p.failureCode : undefined,
    };
  }

  /** Test/dev helper: produce the signature this provider expects. */
  sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('hex');
  }
}

// ---------------------------------------------------------------------
// Stub adapters. They are intentionally explicit about being unconfigured:
// they refuse to run rather than silently faking a charge.
// ---------------------------------------------------------------------

class UnconfiguredProvider implements PaymentProvider {
  readonly name: string;
  readonly supportsPartialRefund = false;
  readonly supportsAuthorization = false;

  constructor(name: string) {
    this.name = name;
  }

  private fail(): never {
    throw new AppError({
      code: ERROR_CODES.PAYMENT_PROVIDER_ERROR,
      message: `Payment provider "${this.name}" is not configured. Set its credentials to enable it.`,
      expose: true,
    });
  }

  createIntent(): Promise<PaymentIntent> { return this.fail(); }
  authorize(): Promise<PaymentResult> { return this.fail(); }
  capture(): Promise<PaymentResult> { return this.fail(); }
  void(): Promise<PaymentResult> { return this.fail(); }
  refund(): Promise<RefundResult> { return this.fail(); }
  verifyWebhookSignature(): boolean { return false; }
  normalizeWebhook(): never { return this.fail(); }
}

export type PaymentProviderName = 'internal' | 'internal-webhook' | 'cmi' | 'stripe' | 'paypal' | 'cash';

export class PaymentProviderRegistry {
  private readonly providers = new Map<string, PaymentProvider>();

  constructor(active: string, webhookSecret?: string) {
    this.providers.set('internal', new InternalPaymentProvider());
    this.providers.set('internal-webhook', new SignedWebhookProvider(webhookSecret ?? ''));
    this.providers.set('cmi', new UnconfiguredProvider('cmi'));
    this.providers.set('stripe', new UnconfiguredProvider('stripe'));
    this.providers.set('paypal', new UnconfiguredProvider('paypal'));
    this.providers.set('cash', new UnconfiguredProvider('cash'));
    this.activeName = this.providers.has(active) ? active : 'internal';
  }

  readonly activeName: string;

  get(name?: string): PaymentProvider {
    const provider = this.providers.get(name ?? this.activeName);
    if (!provider) throw notFound('Payment provider');
    return provider;
  }

  get active(): PaymentProvider {
    return this.get(this.activeName);
  }
}

// ---------------------------------------------------------------------
// Ledger helpers — every money movement produces a ledger row.
// ---------------------------------------------------------------------

export interface LedgerEntryInput {
  walletId: string;
  type: LedgerType;
  direction: LedgerDirection;
  amountMinor: number;
  currency: string;
  balanceAfterMinor: number;
  referenceType?: string;
  referenceId?: string;
  groupId?: string;
  jobId?: string;
  paymentId?: string;
  description?: string;
}

/**
 * Resolve the effective commission for a price, preferring an explicit rule.
 * Kept pure so it can be unit-tested and snapshotted at accept time.
 */
export function resolveCommission(
  priceMinor: number,
  currency: string,
  rule: CommissionRule,
): { commissionMinor: number; providerNetMinor: number; effectiveBps: number } {
  const result = computeCommission(money(priceMinor, currency), rule);
  return {
    commissionMinor: result.commission.amountMinor,
    providerNetMinor: result.providerNet.amountMinor,
    effectiveBps: result.effectiveBps,
  };
}

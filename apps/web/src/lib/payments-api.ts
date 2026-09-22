import { api } from './auth-api';

/**
 * Payments, wallet and payout API.
 *
 * Money is the one place the UI must be exact, so this module keeps the
 * provider-facing calls typed and small: pay a job, read the wallet and its
 * ledger, request a payout, and read a payment's own transaction history.
 */

export interface Wallet {
  id: string;
  owner_type: string;
  currency: string;
  available_minor: number;
  pending_minor: number;
  reserved_minor: number;
  lifetime_in_minor: number;
  lifetime_out_minor: number;
  is_frozen: boolean;
}

export interface LedgerEntry {
  id: string;
  type: string;
  direction: 'CREDIT' | 'DEBIT';
  amount_minor: number;
  currency: string;
  balance_after_minor: number;
  reference_type: string | null;
  reference_id: string | null;
  job_id: string | null;
  description: string | null;
  created_at: string;
}

export interface Payout {
  id: string;
  amount_minor: number;
  currency: string;
  fee_minor: number;
  net_minor: number;
  method: string;
  destination_masked: string | null;
  status: string;
  failure_reason: string | null;
  requested_at: string;
  processed_at: string | null;
  paid_at: string | null;
}

export interface PaymentResult {
  paymentId: string;
  status: string;
  alreadyPaid?: boolean;
  amountMinor?: number;
  currency?: string;
  retryable?: boolean;
}

export interface TopUpPackage {
  id: string;
  code: string;
  pay_minor: number;
  credit_minor: number;
  bonus_minor: number;
  currency: string;
  label_en: string | null;
  label_fr: string | null;
  label_ar: string | null;
  sort_order: number;
}

export type TopUpStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface TopUpRequest {
  id: string;
  status: TopUpStatus;
  pay_minor: number;
  credit_minor: number;
  bonus_minor: number;
  currency: string;
  method: string;
  reference: string | null;
  note: string | null;
  completed_at: string | null;
  created_at: string;
}

export const paymentsApi = {
  /** Customer: authorize + capture the payment for a completed job. Idempotent. */
  async payJob(jobId: string, method = 'CARD'): Promise<PaymentResult> {
    const res = await api.post<PaymentResult>(`/payments/job/${jobId}/pay`, { method });
    return res.data;
  },

  /** Active top-up packages (pay X, get X + bonus) for the wallet tiles. */
  async topUpPackages(): Promise<TopUpPackage[]> {
    const res = await api.get<TopUpPackage[]>('/wallets/topup-packages');
    return res.data;
  },

  /**
   * Provider: file a top-up request for an admin to settle.
   *
   * Money is credited only after an operator confirms it was received, so this
   * creates a PENDING request rather than adding balance. One open request per
   * provider is enforced server-side.
   */
  async requestTopUp(input: {
    packageId?: string;
    amountMinor?: number;
    method?: string;
    reference?: string;
    note?: string;
  }): Promise<TopUpRequest> {
    const res = await api.post<TopUpRequest>('/wallets/me/topup-requests', input);
    return res.data;
  },

  /** Provider: my top-up requests, newest first. */
  async myTopUpRequests(limit = 20): Promise<TopUpRequest[]> {
    const res = await api.get<TopUpRequest[]>(`/wallets/me/topup-requests?limit=${limit}`);
    return res.data;
  },

  /** Provider: cancel a request that is still PENDING. */
  async cancelTopUpRequest(id: string): Promise<TopUpRequest> {
    const res = await api.post<TopUpRequest>(`/wallets/me/topup-requests/${id}/cancel`, {});
    return res.data;
  },

  /** Provider: the wallet balance and lifetime totals. */
  async myWallet(): Promise<Wallet | null> {
    const res = await api.get<Wallet | null>('/wallets/me');
    return res.data;
  },

  /** Provider: the append-only ledger for the wallet. */
  async myLedger(params: { page?: number; limit?: number; type?: string } = {}): Promise<LedgerEntry[]> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
    const suffix = q.toString() ? `?${q.toString()}` : '';
    const res = await api.get<LedgerEntry[]>(`/wallets/me/transactions${suffix}`);
    return res.data;
  },

  /** Provider: request a payout from the available balance. */
  async requestPayout(input: { amountMinor: number; method?: string; destinationMasked?: string }): Promise<Payout> {
    const res = await api.post<Payout>('/payouts', input);
    return res.data;
  },

  /** Provider: my payout history. */
  async myPayouts(): Promise<Payout[]> {
    const res = await api.get<Payout[]>('/payouts/mine');
    return res.data;
  },
};

/** Format minor units as a readable amount (MAD by default). */
export function formatMinor(amountMinor: number | null | undefined, currency = 'MAD', locale = 'en'): string {
  if (amountMinor == null) return '—';
  const value = amountMinor / 100;
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

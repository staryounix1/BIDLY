import { api } from './auth-api';

/**
 * Offers API — the supply side of the marketplace.
 *
 * A provider submits one active offer per request, may counter-negotiate, and
 * may withdraw. The customer accepts exactly one offer, which the server turns
 * into a job + payment intent inside a single transaction. All pricing and
 * eligibility checks are re-validated server-side; this module only shapes the
 * calls.
 */

export interface Offer {
  id: string;
  request_id: string;
  provider_id: string;
  price_minor: number;
  currency: string;
  message: string | null;
  eta_minutes: number | null;
  estimated_duration_minutes?: number | null;
  status: string;
  created_at: string;
  expires_at?: string | null;
  provider_name?: string;
  provider_avatar?: string | null;
  rating_avg?: number | null;
  completed_jobs?: number | null;
}

export interface OfferOnRequest extends Offer {
  request_code?: string;
  request_title?: string | null;
  request_status?: string;
  service_name?: string;
  request_currency?: string;
}

export interface NegotiationEntry {
  id: string;
  actor_role: string;
  side: string;
  type: string;
  price_minor: number;
  currency: string;
  message: string | null;
  round_number: number;
  created_at: string;
}

export interface CreateOfferInput {
  requestId: string;
  priceMinor: number;
  message?: string;
  etaMinutes?: number;
  estimatedDurationMinutes?: number;
  priceIncludesMaterials?: boolean;
}

export const offersApi = {
  async create(input: CreateOfferInput): Promise<Offer> {
    const res = await api.post<Offer>('/offers', input);
    return res.data;
  },

  async counter(id: string, priceMinor: number, message?: string): Promise<Offer> {
    const res = await api.post<Offer>(`/offers/${id}/counter`, { priceMinor, message });
    return res.data;
  },

  async accept(id: string): Promise<{
    jobId: string;
    jobCode: string;
    finalPriceMinor: number;
    currency: string;
    commissionMinor: number;
    providerNetMinor: number;
    /** Present on this API version; used to open the chat after accepting. */
    providerUserId?: string | null;
  }> {
    const res = await api.post<{
      jobId: string;
      jobCode: string;
      finalPriceMinor: number;
      currency: string;
      commissionMinor: number;
      providerNetMinor: number;
      providerUserId?: string | null;
    }>('/offers/' + id + '/accept', {});
    return res.data;
  },

  /**
   * Both sides confirm the negotiated deal. Charging the platform commission
   * happens server-side in the same transaction, so a failure here means no
   * money moved.
   */
  async agree(offerId: string): Promise<{
    jobId: string;
    jobCode: string;
    alreadyCharged: boolean;
    commissionMinor: number;
    providerNetMinor: number;
    finalPriceMinor: number;
    currency: string;
    walletBalanceMinor: number | null;
  }> {
    const res = await api.post<{
      jobId: string;
      jobCode: string;
      alreadyCharged: boolean;
      commissionMinor: number;
      providerNetMinor: number;
      finalPriceMinor: number;
      currency: string;
      walletBalanceMinor: number | null;
    }>(`/offers/${offerId}/agree`, {});
    return res.data;
  },

  async reject(id: string, reason?: string): Promise<Offer> {
    const res = await api.post<Offer>(`/offers/${id}/reject`, reason ? { reason } : {});
    return res.data;
  },

  async withdraw(id: string): Promise<Offer> {
    const res = await api.post<Offer>(`/offers/${id}/withdraw`, {});
    return res.data;
  },

  async mine(params: { page?: number; limit?: number; status?: string } = {}): Promise<{ items: OfferOnRequest[]; meta?: { total?: number } }> {
    const q = new URLSearchParams();
    if (params.page) q.set('page', String(params.page));
    if (params.limit) q.set('limit', String(params.limit));
    if (params.status) q.set('status', params.status);
    const suffix = q.toString() ? `?${q.toString()}` : '';
    const res = await api.get<{ items: OfferOnRequest[]; meta?: { total?: number } }>(`/offers/mine${suffix}`);
    return res.data;
  },

  async history(id: string): Promise<{ history: NegotiationEntry[]; negotiations: NegotiationEntry[] }> {
    const res = await api.get<{ history: NegotiationEntry[]; negotiations: NegotiationEntry[] }>(
      `/offers/${id}/history`,
    );
    return res.data;
  },
};

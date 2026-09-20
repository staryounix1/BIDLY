import { api } from './auth-api';

/**
 * Jobs API — the confirmed engagement between a customer and a provider.
 *
 * A job is created by accepting an offer. The customer's main interactions after
 * that are: watch its status/timeline, confirm completion, or open a dispute
 * (later task). The event timeline and payment summary come from the same call.
 */

export interface JobSummary {
  id: string;
  code: string;
  status: string;
  payment_status: string;
  final_price_minor: number;
  currency: string;
  commission_minor: number;
  provider_net_minor: number;
  service_name?: string;
  provider_name?: string;
  customer_email?: string;
  pickup_city_name: string | null;
  destination_city_name: string | null;
  scheduled_at: string | null;
  created_at: string;
  completed_at: string | null;
  request_id: string;
  accepted_offer_id: string;
}

export interface JobEvent {
  id: string;
  type: string;
  from_status: string | null;
  to_status: string | null;
  actor_role: string | null;
  note: string | null;
  created_at: string;
}

export interface JobPayment {
  id: string;
  status: string;
  amount_minor: number;
  currency: string;
  commission_minor: number;
  provider_net_minor: number;
  method: string | null;
  captured_at: string | null;
}

export interface JobDetail {
  job: JobSummary & {
    provider_id: string;
    pickup_line1: string | null;
    pickup_lat: number | null;
    pickup_lng: number | null;
    destination_line1: string | null;
    destination_lat: number | null;
    destination_lng: number | null;
    start_otp_expires_at: string | null;
    cancellation_reason?: string | null;
    cancellation_fee_minor?: number | null;
    completion_note?: string | null;
  };
  events: JobEvent[];
  payment: JobPayment | null;
}

/** Statuses where the customer is waiting on a provider who is on the move. */
export const TRACKABLE_JOB_STATUSES = [
  'CONFIRMED',
  'PROVIDER_EN_ROUTE',
  'PROVIDER_ARRIVED',
  'IN_PROGRESS',
] as const;

/**
 * Provider-side job actions.
 *
 * The provider drives the job through PROVIDER_EN_ROUTE → PROVIDER_ARRIVED and
 * starts work with the customer's one-time code. Every transition is validated
 * by the state machine on the server; the UI only offers the actions that are
 * legal for the current status, and a rejected call surfaces the server's own
 * message rather than being silently retried.
 */

/** Which provider action is legal from a given job status. */
export function providerNextAction(status: string): 'enRoute' | 'arrived' | 'start' | 'complete' | null {
  switch (status) {
    case 'CONFIRMED':
    case 'CREATED':
      return 'enRoute';
    case 'PROVIDER_EN_ROUTE':
      return 'arrived';
    case 'PROVIDER_ARRIVED':
      return 'start';
    case 'IN_PROGRESS':
    case 'STARTED':
      return 'complete';
    default:
      return null;
  }
}

export const jobsApi = {
  async mine(params: { page?: number; limit?: number; status?: string; role?: 'customer' | 'provider' } = {}) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
    const suffix = q.toString() ? `?${q.toString()}` : '';
    const res = await api.get<{ items: JobSummary[]; meta?: { total?: number } }>(`/jobs/mine${suffix}`);
    return res.data;
  },

  async get(id: string): Promise<JobDetail> {
    const res = await api.get<JobDetail>(`/jobs/${id}`);
    return res.data;
  },

  async confirm(id: string): Promise<JobSummary> {
    const res = await api.post<JobSummary>(`/jobs/${id}/confirm`, {});
    return res.data;
  },

  /** Provider: on the way. */
  async enRoute(id: string, coords?: { lat?: number; lng?: number }): Promise<JobSummary> {
    const res = await api.post<JobSummary>(`/jobs/${id}/en-route`, coords ?? {});
    return res.data;
  },

  /** Provider: at the customer's location. */
  async arrived(id: string): Promise<JobSummary> {
    const res = await api.post<JobSummary>(`/jobs/${id}/arrived`, {});
    return res.data;
  },

  /** Provider: begin work using the customer's one-time code. */
  async start(id: string, otp: string): Promise<JobSummary> {
    const res = await api.post<JobSummary>(`/jobs/${id}/start`, { otp });
    return res.data;
  },

  /** Provider: finish the work, optionally with a note and photo URLs. */
  async complete(id: string, input: { note?: string; photoUrls?: string[] } = {}): Promise<JobSummary> {
    const res = await api.post<JobSummary>(`/jobs/${id}/complete`, input);
    return res.data;
  },

  /** Either party: cancel, subject to the configured fee policy. */
  async cancel(id: string, reason?: string): Promise<JobSummary & { cancellationFeeMinor?: number }> {
    const res = await api.post<JobSummary & { cancellationFeeMinor?: number }>(
      `/jobs/${id}/cancel`,
      reason ? { reason } : {},
    );
    return res.data;
  },
};

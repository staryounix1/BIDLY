import { api } from './auth-api';
import type { CreateRequestInput } from '@bidly/validation';

/**
 * Requests API — the customer's demand-side operations.
 *
 * Creation starts the request in DRAFT; publishing it kicks off matching. The
 * customer may edit or cancel while the request is still open.
 */

export type RequestStatus =
  | 'DRAFT'
  | 'PUBLISHED'
  | 'MATCHING'
  | 'RECEIVING_OFFERS'
  | 'PROVIDER_SELECTED'
  | 'CONFIRMED'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'EXPIRED'
  | 'DISPUTED'
  | 'REFUNDED'
  | 'FAILED';

export interface RequestSummary {
  id: string;
  code: string;
  title: string | null;
  description: string | null;
  status: RequestStatus;
  pricing_model: string;
  budget_min_minor: number | null;
  budget_max_minor: number | null;
  currency: string;
  urgency: string;
  pickup_city_name: string | null;
  pickup_line1?: string | null;
  destination_city_name: string | null;
  scheduled_at: string | null;
  offer_count: number;
  published_at: string | null;
  expires_at: string | null;
  cancelled_at?: string | null;
  created_at: string;
  service_name: string;
  service_slug: string;
  category_name: string;
}

export interface RequestDetail {
  request: RequestSummary & {
    service_id: string;
    category_id: string;
    subcategory_id: string | null;
    customer_id: string;
    answers: Record<string, unknown>;
    pickup_line1: string | null;
    pickup_line2: string | null;
    pickup_district: string | null;
    pickup_notes: string | null;
    destination_line1: string | null;
    destination_notes: string | null;
    subcategory_name: string | null;
    item_count: number | null;
    requires_helper: boolean;
    selected_offer_id: string | null;
    job_id: string | null;
  };
  answers: Array<{ id: string; field_key: string; field_type: string; value_text: string | null; value_number: string | null; value_boolean: boolean | null; value_date: string | null; value_json: unknown }>;
  media: Array<{ id: string; url: string; kind: string }>;
  offers: Array<{
    id: string;
    provider_id: string;
    price_minor: number;
    currency: string;
    message: string | null;
    eta_minutes: number | null;
    status: string;
    provider_name: string;
    provider_avatar: string | null;
    rating_avg: number | null;
    completed_jobs: number | null;
    created_at: string;
  }>;
}

export interface Page<T> {
  items: T[];
  meta?: { page?: number; limit?: number; total?: number; totalPages?: number };
}

export const requestsApi = {
  async create(input: CreateRequestInput): Promise<{ id: string; code: string }> {
    const res = await api.post<{ id: string; code: string }>('/requests', input);
    return res.data;
  },

  async publish(id: string, expiresInHours?: number): Promise<RequestSummary> {
    const res = await api.post<RequestSummary>(
      `/requests/${id}/publish`,
      expiresInHours ? { expiresInHours } : {},
    );
    return res.data;
  },

  async update(id: string, patch: Record<string, unknown>): Promise<RequestSummary> {
    const res = await api.patch<RequestSummary>(`/requests/${id}`, patch);
    return res.data;
  },

  async mine(params: { page?: number; limit?: number; status?: string } = {}): Promise<Page<RequestSummary>> {
    const query = new URLSearchParams();
    if (params.page) query.set('page', String(params.page));
    if (params.limit) query.set('limit', String(params.limit));
    if (params.status) query.set('status', params.status);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const res = await api.get<Page<RequestSummary>>(`/requests/mine${suffix}`);
    return res.data;
  },

  async get(id: string): Promise<RequestDetail> {
    const res = await api.get<RequestDetail>(`/requests/${id}`);
    return res.data;
  },

  async cancel(id: string, reason?: string): Promise<RequestSummary> {
    const res = await api.post<RequestSummary>(
      `/requests/${id}/cancel`,
      reason ? { reason } : {},
    );
    return res.data;
  },
};

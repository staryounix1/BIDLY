import { api } from './auth-api';

/**
 * Boosts, complaints and public tracking links — the optional modules behind
 * their admin feature switches. Every call degrades gracefully when the
 * operator has the feature off: the API answers with a business-rule error,
 * which the UI turns into "not available right now".
 */

export interface BoostOption {
  hours: number;
  priceMinor: number;
}

export interface BoostRecord {
  id: string;
  duration_hours: number;
  price_minor: string | number;
  currency: string;
  starts_at: string;
  ends_at: string;
  is_active: boolean;
}

export interface Complaint {
  id: string;
  code: string;
  subject: string;
  status: string;
  priority: string;
  guarantee_days: number;
  resolution: string | null;
  refund_minor: string | number | null;
  created_at: string;
  resolved_at: string | null;
  job_code: string | null;
}

export interface ComplaintEligibility {
  enabled: boolean;
  guaranteeDays: number;
  canComplain: boolean;
  hasOpenComplaint: boolean;
  windowEndsAt: string | null;
}

export interface TrackingLink {
  id: string;
  token: string;
  label: string | null;
  expires_at: string;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  created_at: string;
}

export interface PeakStats {
  enabled: boolean;
  byHour: Array<{ hour: number; requests: number }>;
  byWeekday: Array<{ weekday: number; requests: number }>;
}

export const extrasApi = {
  boostPrices: () =>
    api.get<{ enabled: boolean; options: BoostOption[] }>('/boosts/prices').then((r) => r.data),

  buyBoost: (hours: number) =>
    api.post<{ priceMinor: number; hours: number }>('/boosts', { hours }).then((r) => r.data),

  myBoosts: () => api.get<BoostRecord[]>('/boosts/mine').then((r) => r.data),

  complain: (input: { jobId: string; subject: string; body: string; category?: string }) =>
    api.post<{ id: string; code: string }>('/complaints', input).then((r) => r.data),

  myComplaints: () => api.get<Complaint[]>('/complaints/mine').then((r) => r.data),

  complaintEligibility: (jobId: string) =>
    api.get<ComplaintEligibility>(`/complaints/eligibility/${jobId}`).then((r) => r.data),

  createTrackingLink: (jobId: string, hours = 12) =>
    api.post<TrackingLink>(`/jobs/${jobId}/tracking-link`, { hours }).then((r) => r.data),

  trackingLinks: (jobId: string) =>
    api.get<TrackingLink[]>(`/jobs/${jobId}/tracking-links`).then((r) => r.data),

  revokeTrackingLink: (id: string) =>
    api.post<{ id: string }>(`/tracking-links/${id}/revoke`, {}).then((r) => r.data),

  peakStats: () => api.get<PeakStats>('/providers/me/peak-stats').then((r) => r.data),
};

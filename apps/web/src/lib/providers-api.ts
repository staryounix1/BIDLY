import { api, ApiError } from './auth-api';

const isNotFound = (err: unknown): boolean => err instanceof ApiError && err.status === 404;

/**
 * Providers API — the supply-side profile.
 *
 * A provider must exist before they can see the request feed or submit offers.
 * Getting a provider to ACTIVE is an admin/verification step (a later task),
 * so the UI surfaces the status clearly rather than blocking the profile.
 */

export interface ProviderProfile {
  id: string;
  user_id: string;
  display_name: string;
  legal_name: string | null;
  bio: string | null;
  avatar_url: string | null;
  city_id: string | null;
  country_code: string | null;
  service_radius_km: number | null;
  languages: string[] | null;
  status: string;
  verification_status: string;
  is_online: boolean;
  is_available: boolean;
  rating_avg: number | null;
  completed_jobs: number | null;
  currency: string;
  created_at: string;
}

export interface ProviderService {
  id: string;
  provider_id: string;
  service_id: string;
  slug: string;
  name_en: string;
  name_fr: string;
  name_ar: string;
  pricing_model: string;
  min_price_minor: number | null;
  max_price_minor: number | null;
  hourly_rate_minor: number | null;
  eta_minutes: number | null;
  experience_years: number | null;
  is_active: boolean;
  currency: string;
}

export interface FeedRequest {
  id: string;
  code: string;
  title: string | null;
  description: string | null;
  status: string;
  pricing_model: string;
  budget_min_minor: number | null;
  budget_max_minor: number | null;
  currency: string;
  urgency: string;
  pickup_city_name: string | null;
  destination_city_name: string | null;
  scheduled_at: string | null;
  offer_count: number;
  published_at: string | null;
  expires_at: string | null;
  service_name: string;
  service_slug: string;
  category_name: string;
  media_count: number;
}

export interface ProviderArea {
  id: string;
  provider_id: string;
  city_id: string | null;
  center_lat: number | null;
  center_lng: number | null;
  radius_km: number;
  city_name?: string | null;
}

export interface AvailabilitySlot {
  id: string;
  provider_id: string;
  weekday: number | null;
  start_time: string;
  end_time: string;
  period: string;
  exception_date?: string | null;
}

export type ProviderDocumentType = 'IDENTITY' | 'BUSINESS' | 'LICENSE' | 'INSURANCE' | 'CERTIFICATION';

export interface ProviderDocument {
  id: string;
  type: ProviderDocumentType;
  status: string;
  file_url: string;
  rejection_reason: string | null;
  expires_at: string | null;
  created_at: string;
  reviewed_at: string | null;
}

export const providersApi = {
  /** Null when the signed-in user has no provider profile yet (404). */
  async me(): Promise<ProviderProfile | null> {
    try {
      const res = await api.get<ProviderProfile>('/providers/me');
      return res.data;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  },

  async create(input: {
    displayName: string;
    legalName?: string;
    bio?: string;
    cityId?: string;
    serviceRadiusKm?: number;
    languages?: string[];
  }): Promise<ProviderProfile> {
    const res = await api.post<ProviderProfile>('/providers', input);
    return res.data;
  },

  async update(patch: Partial<{
    displayName: string;
    bio: string;
    avatarUrl: string;
    serviceRadiusKm: number;
    isOnline: boolean;
    isAvailable: boolean;
    languages: string[];
  }>): Promise<ProviderProfile> {
    const res = await api.patch<ProviderProfile>('/providers/me', patch);
    return res.data;
  },

  async myServices(): Promise<ProviderService[]> {
    try {
      const res = await api.get<ProviderService[]>('/providers/me/services');
      return res.data;
    } catch (err) {
      if (isNotFound(err)) return [];
      throw err;
    }
  },

  async upsertService(input: {
    serviceId: string;
    minPriceMinor?: number;
    maxPriceMinor?: number;
    hourlyRateMinor?: number;
    etaMinutes?: number;
    experienceYears?: number;
    isActive?: boolean;
  }): Promise<ProviderService> {
    // PUT, not POST: the route is an upsert ("Add or update an offered
    // service"), so posting to it 404s with "The requested endpoint was not
    // found" when a provider adds a service on the profile screen.
    const res = await api.put<ProviderService>('/providers/me/services', input);
    return res.data;
  },

  async removeService(serviceId: string): Promise<void> {
    await api.delete(`/providers/me/services/${serviceId}`);
  },

  /** Requests matching this provider's active services. */
  async feed(params: {
    page?: number;
    limit?: number;
    serviceId?: string;
    cityId?: string;
    minBudgetMinor?: number;
    sortBy?: string;
    sortDir?: 'asc' | 'desc';
  } = {}): Promise<{ items: FeedRequest[]; meta?: { total?: number; page?: number; totalPages?: number } }> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') q.set(k, String(v));
    }
    const suffix = q.toString() ? `?${q.toString()}` : '';
    const res = await api.get<{ items: FeedRequest[]; meta?: { total?: number } }>(`/requests/feed${suffix}`);
    return res.data;
  },

  // --- coverage areas -------------------------------------------------

  async myAreas(): Promise<ProviderArea[]> {
    const res = await api.get<ProviderArea[]>('/providers/me/areas');
    return res.data;
  },

  async addArea(input: {
    cityId?: string;
    centerLat?: number;
    centerLng?: number;
    radiusKm?: number;
  }): Promise<ProviderArea> {
    const res = await api.post<ProviderArea>('/providers/me/areas', input);
    return res.data;
  },

  // --- weekly availability --------------------------------------------

  async myAvailability(): Promise<AvailabilitySlot[]> {
    const res = await api.get<AvailabilitySlot[]>('/providers/me/availability');
    return res.data;
  },

  async setAvailability(input: {
    weekday: number;
    startTime: string;
    endTime: string;
    period?: 'DAY' | 'NIGHT' | 'ANY';
  }): Promise<AvailabilitySlot> {
    // The route is declared as PUT on the API (`app.put('/providers/me/availability')`).
    // Posting to it 404s with "The requested endpoint was not found", which the
    // profile screen surfaced after saving the slot.
    const res = await api.put<AvailabilitySlot>('/providers/me/availability', input);
    return res.data;
  },

  // --- verification documents -----------------------------------------

  async myDocuments(): Promise<ProviderDocument[]> {
    const res = await api.get<ProviderDocument[]>('/providers/me/documents');
    return res.data;
  },

  async submitDocument(input: {
    type: 'IDENTITY' | 'BUSINESS' | 'LICENSE' | 'INSURANCE' | 'CERTIFICATION';
    fileUrl: string;
    fileMime?: string;
    documentNumber?: string;
  }): Promise<ProviderDocument> {
    const res = await api.post<ProviderDocument>('/providers/me/documents', input);
    return res.data;
  },
};

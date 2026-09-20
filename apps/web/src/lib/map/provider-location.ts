'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { api } from '@/lib/auth-api';

/**
 * Publish the provider's position while they are online.
 *
 * A provider who is marked available must be findable on the map, so this
 * watches the browser's position and POSTs it to the API. It only runs while
 * `enabled` is true (the provider is online with an active job or available),
 * stops on unmount, and backs off naturally because it is driven by the
 * browser's own `watchPosition` cadence rather than a fixed timer.
 */

export function useProviderLocationPing(enabled: boolean) {
  const [error, setError] = useState<string | null>(null);
  const [lastSentAt, setLastSentAt] = useState<number | null>(null);
  const lastSent = useRef(0);

  const send = useCallback(async (pos: GeolocationPosition) => {
    // One POST per ~20s is plenty for a map pin and keeps the trail small.
    const now = Date.now();
    if (now - lastSent.current < 20_000) return;
    lastSent.current = now;
    try {
      await api.post('/providers/me/location', {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        ...(pos.coords.accuracy != null ? { accuracyM: Math.round(pos.coords.accuracy) } : {}),
        ...(pos.coords.heading != null && !Number.isNaN(pos.coords.heading) ? { heading: pos.coords.heading } : {}),
        ...(pos.coords.speed != null && pos.coords.speed >= 0 ? { speedKmh: Math.round(pos.coords.speed * 3.6) } : {}),
      });
      setLastSentAt(now);
      setError(null);
    } catch {
      setError('ping');
    }
  }, []);

  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined' || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => void send(pos),
      () => setError('denied'),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled, send]);

  return { error, lastSentAt };
}

/**
 * A generic map of nearby providers, used on the customer home and the
 * provider request feed so both sides see the same geography.
 */
export function useNearbyProviders(
  point: { lat: number; lng: number } | null,
  opts: { radiusKm?: number; serviceId?: string; enabled?: boolean } = {},
) {
  const { radiusKm = 25, serviceId, enabled = true } = opts;
  const [providers, setProviders] = useState<NearbyProvider[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!point || !enabled) {
      setProviders([]);
      return;
    }
    let alive = true;
    setLoading(true);
    const qs = new URLSearchParams({
      lat: String(point.lat),
      lng: String(point.lng),
      radiusKm: String(radiusKm),
      limit: '50',
    });
    if (serviceId) qs.set('serviceId', serviceId);

    api
      .get<{ providers: NearbyProvider[] }>(`/providers/nearby?${qs.toString()}`)
      .then((res) => alive && setProviders(res.data.providers ?? []))
      .catch(() => alive && setProviders([]))
      .finally(() => alive && setLoading(false));

    return () => {
      alive = false;
    };
  }, [point?.lat, point?.lng, radiusKm, serviceId, enabled]);

  return { providers, loading };
}

export interface NearbyProvider {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  rating_avg: number | null;
  rating_count: number | null;
  completed_jobs: number | null;
  verification_status: string | null;
  is_online: boolean | null;
  currency: string | null;
  lat: number;
  lng: number;
  distance_km: number;
  recorded_at: string | null;
}

/** Small label used by both maps to describe how far away something is. */
export function useDistanceLabel() {
  const { t } = useI18n();
  return useCallback(
    (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} ${t('common.km')}`),
    [t],
  );
}

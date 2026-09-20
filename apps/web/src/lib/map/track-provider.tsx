'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { api } from '@/lib/auth-api';
import { useMap, TILE_URL, TILE_ATTRIBUTION } from './leaflet';

/**
 * Live arrival tracking.
 *
 * The customer watches the awarded provider's pin move toward the job site.
 * The provider app publishes its position with POST /providers/me/location;
 * here we poll GET /providers/:id/location and also refresh on job-status
 * realtime events, which is when the pin matters most.
 *
 * Polling rather than a socket is deliberate: positions change on a human
 * timescale (a moving vehicle), and a request every few seconds costs far less
 * than a dedicated streaming channel per viewer.
 */

export interface TrackProviderProps {
  providerId: string;
  destination: { lat: number; lng: number } | null;
  providerName?: string | null;
  /** Bump this to force an immediate refresh (e.g. on a job status event). */
  refreshKey?: unknown;
  height?: number;
  pollMs?: number;
}

interface ProviderLocation {
  lat: number;
  lng: number;
  heading: number | null;
  speed_kmh: number | null;
  accuracy_m: number | null;
  recorded_at: string | null;
}

export function TrackProvider({
  providerId,
  destination,
  providerName,
  refreshKey,
  height = 280,
  pollMs = 12_000,
}: TrackProviderProps) {
  const { t } = useI18n();
  const [location, setLocation] = useState<ProviderLocation | null>(null);
  const [stale, setStale] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const markerRef = useRef<{ setLatLng: (ll: [number, number]) => void } | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;

    async function pull() {
      try {
        const res = await api.get<ProviderLocation | null>(`/providers/${providerId}/location`);
        if (!alive) return;
        const loc = res.data;
        if (loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng))) {
          setLocation({ ...loc, lat: Number(loc.lat), lng: Number(loc.lng) });
          // Older than two poll windows means the provider app stopped pinging.
          const age = loc.recorded_at ? Date.now() - new Date(loc.recorded_at).getTime() : 0;
          setStale(age > pollMs * 2.5);
        } else {
          setLocation(null);
        }
      } catch {
        if (alive) setLocation(null);
      } finally {
        if (alive) timer = setTimeout(pull, pollMs);
      }
    }

    void pull();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [providerId, pollMs, refreshKey]);

  // Move the pin without rebuilding the map — recreating Leaflet on every poll
  // would flash the tiles and lose the user's pan/zoom.
  useEffect(() => {
    if (!location) return;
    markerRef.current?.setLatLng([location.lat, location.lng]);
  }, [location?.lat, location?.lng]);

  useMap(
    containerRef,
    (L, map) => {
      L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);
      const centre = location ?? destination;
      map.setView(centre ? [centre.lat, centre.lng] : [33.5731, -7.5898], 13);

      if (destination) {
        L.circle([destination.lat, destination.lng], {
          radius: 500,
          color: '#0ea5e9',
          fillColor: '#0ea5e9',
          fillOpacity: 0.3,
        }).addTo(map);
      }
      const marker = L.marker(
        location ? [location.lat, location.lng] : destination ? [destination.lat, destination.lng] : [33.5731, -7.5898],
        { opacity: location ? 1 : 0 },
      ).addTo(map);
      markerRef.current = marker;
      return () => {
        markerRef.current = null;
      };
    },
    [],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold">{t('map.trackTitle')}</span>
        {location ? (
          <span className={`inline-flex items-center gap-1.5 ${stale ? 'text-amber-600' : 'text-emerald-600'}`}>
            <span className={`inline-block h-2 w-2 rounded-full ${stale ? 'bg-amber-500' : 'bg-emerald-500'} ${stale ? '' : 'animate-pulse'}`} />
            {stale ? t('map.offline') : providerName}
          </span>
        ) : (
          <span className="opacity-50">{t('map.offline')}</span>
        )}
      </div>
      <div
        ref={containerRef}
        style={{ height }}
        className="w-full overflow-hidden rounded-2xl border border-black/10 dark:border-white/15"
        dir="ltr"
      />
    </div>
  );
}

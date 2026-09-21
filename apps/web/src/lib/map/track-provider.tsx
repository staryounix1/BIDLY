'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import { useI18n } from '@/lib/i18n-provider';
import { api } from '@/lib/auth-api';
import { CategoryIcon } from '@/lib/icons';
import { MapView, ThemedMarker, DEFAULT_MAP_STYLE } from './map-view';
import { useFollow } from './use-follow';

/**
 * Live arrival tracking.
 *
 * The customer watches the awarded provider's pin move toward the job site.
 * The provider app publishes its position with POST /providers/me/location;
 * here we poll GET /providers/:id/location and also refresh on job-status
 * realtime events (the `refreshKey` prop), which is when the pin matters most.
 *
 * Both data paths are unchanged from the previous implementation — only the map
 * plumbing moved to react-leaflet. The pin is a `ThemedMarker` whose position
 * prop changes, so it moves without the map remounting and without a tile flash.
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

const MOROCCO_CENTER: [number, number] = [33.5731, -7.5898];

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
  const mapRef = useRef<LeafletMap | null>(null);

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

  // The incoming provider is the subject of this screen, so the map follows
  // them: smoothly while they move, and only until the customer pans away.
  const follow = useFollow({ point: location, zoom: 14, enabled: true });

  const onMapReady = useCallback(
    (map: LeafletMap) => {
      mapRef.current = map;
      follow.onMapReady(map);
    },
    [follow.onMapReady],
  );

  const centre = location ?? destination;
  const startCenter: [number, number] = centre
    ? [centre.lat, centre.lng]
    : MOROCCO_CENTER;

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
      <div className="relative overflow-hidden rounded-2xl border border-[rgb(var(--line))]">
        <div style={{ height }} className="map-canvas w-full">
          <MapView
            center={startCenter}
            zoom={14}
            style={DEFAULT_MAP_STYLE}
            className="h-full w-full"
            onReady={onMapReady}
          >
            {destination && (
              <ThemedMarker
                position={[destination.lat, destination.lng]}
                kind="pin"
                label={t('map.destinationPoint')}
              />
            )}

            {/* The provider pin. Keyed on the marker's identity, not position,
                so react-leaflet moves it rather than recreating it. */}
            <ThemedMarker
              position={
                location
                  ? [location.lat, location.lng]
                  : destination
                    ? [destination.lat, destination.lng]
                    : MOROCCO_CENTER
              }
              kind="provider"
              opacity={location ? 1 : 0}
              {...(providerName ? { label: providerName } : {})}
            />
          </MapView>
        </div>

        {/* Reappears only after the customer has panned away from the provider,
            so following is one tap to restore but never automatic again. */}
        {follow.userMoved && !follow.following && location && (
          <button
            type="button"
            onClick={follow.recenter}
            className="map-recenter"
            style={{ insetInlineEnd: '0.75rem', bottom: '0.75rem' }}
          >
            <CategoryIcon name="nav" size={16} strokeWidth={2.3} />
            {t('map.recenter')}
          </button>
        )}
      </div>
    </div>
  );
}

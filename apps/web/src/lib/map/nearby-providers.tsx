'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { useMap, addTileLayer, DEFAULT_MAP_STYLE } from './leaflet';
import { createMeMarker, createMarker } from './markers';
import { useNearbyProviders, type NearbyProvider } from './provider-location';

/**
 * "Who is around me right now" — the customer-facing map of online providers.
 *
 * This is the inDrive reassurance moment before a request even exists: it
 * proves the marketplace has supply nearby. Positions come from the same
 * `provider_locations` trail the arrival tracker uses, so the two views can
 * never disagree.
 */
export function NearbyProvidersMap({
  serviceId,
  radiusKm = 15,
  height = 300,
}: {
  serviceId?: string;
  radiusKm?: number;
  height?: number;
}) {
  const { t } = useI18n();
  const [point, setPoint] = useState<{ lat: number; lng: number } | null>(null);
  const [geoState, setGeoState] = useState<'idle' | 'asking' | 'denied' | 'ready'>('idle');
  const mapRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Ask for the location once on mount. Without a point there is nothing to
  // centre on, and defaulting to a city centre would show a lie.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoState('denied');
      return;
    }
    setGeoState('asking');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGeoState('ready');
      },
      () => setGeoState('denied'),
      { enableHighAccuracy: true, timeout: 12_000, maximumAge: 60_000 },
    );
  }, []);

  const { providers, loading } = useNearbyProviders(point, {
    radiusKm,
    ...(serviceId ? { serviceId } : {}),
    enabled: geoState === 'ready',
  });

  useMap(
    mapRef,
    (L, map) => {
      if (!point) return undefined;
      const map2 = map;
      addTileLayer(L, map2, DEFAULT_MAP_STYLE);
      map2.setView([point.lat, point.lng], 13, { animate: false });

      // "You are here" is a distinct marker from the providers, so the customer
      // can always tell their own position from supply.
      createMeMarker(L, [point.lat, point.lng], { label: t('map.myLocation') }).addTo(map2);

      for (const p of providers) {
        createMarker(L, [Number(p.lat), Number(p.lng)], 'provider', {
          dim: !p.is_online,
          ...(p.display_name ? { label: p.display_name } : {}),
        })
          .addTo(map2)
          .bindPopup(p.display_name ?? '');
      }
      return undefined;
    },
    [point?.lat, point?.lng, providers.map((p) => p.id).join('|')],
    { style: DEFAULT_MAP_STYLE },
  );

  if (geoState === 'denied') {
    return (
      <p className="rounded-2xl border border-dashed border-black/15 p-5 text-sm opacity-70 dark:border-white/15">
        {t('map.denied')}
      </p>
    );
  }

  return (
    <div className="space-y-2" ref={containerRef}>
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold">{t('map.providersNearby')}</span>
        <span className="opacity-60">
          {loading
            ? t('common.loading')
            : providers.length > 0
              ? t('map.providerCount', { count: providers.length })
              : t('map.noProviders')}
        </span>
      </div>
      <div
        ref={mapRef}
        style={{ height }}
        className="w-full overflow-hidden rounded-2xl border border-black/10 dark:border-white/15"
        dir="ltr"
      />
      {providers.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {providers.slice(0, 6).map((p) => (
            <ProviderRow key={p.id} provider={p} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ProviderRow({ provider }: { provider: NearbyProvider }) {
  const { t } = useI18n();
  const km = Number(provider.distance_km);
  return (
    <li className="flex items-center gap-3 rounded-xl border border-black/10 px-3 py-2 text-sm dark:border-white/15">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold dark:bg-slate-700">
        {(provider.display_name ?? '?').slice(0, 1).toUpperCase()}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{provider.display_name ?? '—'}</span>
        <span className="block text-xs opacity-60">
          {Number.isFinite(km) ? `${km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} ${t('common.km')}`}` : ''}
          {provider.rating_avg != null && <> · ★ {Number(provider.rating_avg).toFixed(1)}</>}
        </span>
      </span>
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${provider.is_online ? 'bg-emerald-500' : 'bg-slate-400'}`}
        title={provider.is_online ? 'online' : 'offline'}
      />
    </li>
  );
}

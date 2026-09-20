'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { useMap, TILE_URL, TILE_ATTRIBUTION, type LeafletMap, type LeafletMarker } from './leaflet';

/** A pin with no chosen point yet stays invisible instead of sitting at the default centre. */
function hideMarker(marker: LeafletMarker) {
  marker.setOpacity(0);
}

function showMarker(marker: LeafletMarker) {
  marker.setOpacity(1);
}

/**
 * Pick a point on a map.
 *
 * Tap anywhere on the map (or drag the pin) to set coordinates. The address
 * line is filled in by reverse geocoding only when the user asks, because
 * Nominatim rate-limits and a wrong guess is worse than an empty field.
 */

export interface PickedPoint {
  lat: number;
  lng: number;
}

export interface MapPickerProps {
  value: PickedPoint | null;
  onChange: (point: PickedPoint) => void;
  /** Address line to show under the pin; owned by the parent form. */
  address?: string;
  onAddressChange?: (address: string) => void;
  height?: number;
  /** Fallback centre when nothing is picked yet. */
  defaultCenter?: [number, number];
}

export function MapPicker({
  value,
  onChange,
  address,
  onAddressChange,
  height = 260,
  defaultCenter = [33.5731, -7.5898],
}: MapPickerProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<LeafletMarker | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [reverseBusy, setReverseBusy] = useState(false);

  // The change handler is called from Leaflet's own event loop, outside React's
  // render, so keep the latest callback in a ref instead of re-creating the map.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialValueRef = useRef(value);

  useMap(
    containerRef,
    (L, map) => {
      mapRef.current = map;
      L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);

      const start = initialValueRef.current ?? { lat: defaultCenter[0], lng: defaultCenter[1] };
      map.setView([start.lat, start.lng], initialValueRef.current ? 15 : 12);

      // One draggable pin, created up front and hidden until a point is chosen.
      const marker = L.marker([start.lat, start.lng], { draggable: true })
        .addTo(map)
        .on('dragend', () => {
          const ll = marker.getLatLng();
          onChangeRef.current({ lat: ll.lat, lng: ll.lng });
        });
      markerRef.current = marker;
      if (!initialValueRef.current) hideMarker(marker);

      map.on('click', (e) => {
        const point = { lat: e.latlng.lat, lng: e.latlng.lng };
        marker.setLatLng([point.lat, point.lng]);
        showMarker(marker);
        onChangeRef.current(point);
      });

      return () => {
        markerRef.current = null;
        mapRef.current = null;
      };
    },
    [],
  );

  // Keep the pin in sync when the parent sets a point (e.g. after geolocation).
  useEffect(() => {
    if (!value) return;
    markerRef.current?.setLatLng([value.lat, value.lng]);
    if (markerRef.current) showMarker(markerRef.current);
    mapRef.current?.setView([value.lat, value.lng], 15);
  }, [value?.lat, value?.lng]);

  const locate = useCallback(() => {
    if (!navigator.geolocation) {
      setGeoError(t('map.unsupported'));
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const point = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        onChangeRef.current(point);
        setLocating(false);
      },
      () => {
        setGeoError(t('map.denied'));
        setLocating(false);
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    );
  }, [t]);

  const reverse = useCallback(async () => {
    if (!value || !onAddressChange) return;
    setReverseBusy(true);
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${value.lat}&lon=${value.lng}&accept-language=${encodeURIComponent(document.documentElement.lang || 'ar')}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = (await res.json()) as { display_name?: string };
      if (data.display_name) onAddressChange(data.display_name);
    } catch {
      /* reverse geocoding is a convenience; leaving the field is fine */
    } finally {
      setReverseBusy(false);
    }
  }, [value?.lat, value?.lng, onAddressChange]);

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        style={{ height }}
        className="w-full overflow-hidden rounded-xl border border-black/10 dark:border-white/15"
        dir="ltr"
      />

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          onClick={locate}
          disabled={locating}
          className="rounded-lg border border-black/15 px-3 py-1.5 font-medium disabled:opacity-50 dark:border-white/20"
        >
          {locating ? t('map.locating') : `📍 ${t('map.myLocation')}`}
        </button>

        {value && onAddressChange && (
          <button
            type="button"
            onClick={reverse}
            disabled={reverseBusy}
            className="rounded-lg border border-black/15 px-3 py-1.5 font-medium disabled:opacity-50 dark:border-white/20"
          >
            {reverseBusy ? t('map.looking') : t('map.fillAddress')}
          </button>
        )}

        {value && (
          <span className="font-mono text-[11px] opacity-60" dir="ltr">
            {value.lat.toFixed(5)}, {value.lng.toFixed(5)}
          </span>
        )}
      </div>

      {geoError && <p className="text-xs text-amber-600">{geoError}</p>}
      {!value && <p className="text-xs opacity-60">{t('map.tapHint')}</p>}
      {address && <p className="text-xs opacity-60">{address}</p>}
    </div>
  );
}

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { CategoryIcon } from '@/lib/icons';
import {
  useMap,
  addTileLayer,
  DEFAULT_MAP_STYLE,
  type LeafletMap,
  type LeafletMarker,
  type MapStyle,
} from './leaflet';
import { createPinMarker, createMeMarker } from './markers';
import { useMyLocation, NEIGHBOURHOOD_ZOOM, type LatLng } from './use-my-location';

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
 *
 * The map opens already centred on the user at neighbourhood zoom (see
 * `useMyLocation`), so the first frame is the final frame — there is no
 * zoom-in animation and no world view to correct.
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
  /** Basemap style; defaults to the app default (Dark Matter). */
  mapStyle?: MapStyle;
  /**
   * `boxed` (default) is the bordered, fixed-height card used inside forms.
   * `full` drops the border and fills the parent, for the full-screen compose
   * map where the container owns the size.
   */
  variant?: 'boxed' | 'full';
  /** Extra class on the outer wrapper (e.g. to raise the FAB over a sheet). */
  className?: string;
  /** Render the floating "my location" button. Default true. */
  showLocateButton?: boolean;
  /** Keep the map following the user as they move. Default false. */
  follow?: boolean;
  /** Called once the starting view is committed, so a parent can hide a loader. */
  onReady?: () => void;
}

export function MapPicker({
  value,
  onChange,
  address,
  onAddressChange,
  height = 260,
  defaultCenter,
  mapStyle = DEFAULT_MAP_STYLE,
  variant = 'boxed',
  className,
  showLocateButton = true,
  follow = false,
  onReady,
}: MapPickerProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markerRef = useRef<LeafletMarker | null>(null);
  const meRef = useRef<LeafletMarker | null>(null);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [reverseBusy, setReverseBusy] = useState(false);

  const fallback = defaultCenter
    ? { lat: defaultCenter[0], lng: defaultCenter[1] }
    : undefined;
  const geo = useMyLocation({ live: follow, zoom: NEIGHBOURHOOD_ZOOM });

  // The centre the map is committed to at mount: an explicit default wins,
  // otherwise the remembered/device position resolved synchronously.
  const startRef = useRef<LatLng>(fallback ?? geo.initialCenter);
  const startZoom = useRef<number>(value ? NEIGHBOURHOOD_ZOOM : NEIGHBOURHOOD_ZOOM);

  // The change handler is called from Leaflet's own event loop, outside React's
  // render, so keep the latest callback in a ref instead of re-creating the map.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initialValueRef = useRef(value);

  useMap(
    containerRef,
    (L, map) => {
      mapRef.current = map;
      addTileLayer(L, map, mapStyle);

      const start = initialValueRef.current ?? startRef.current;

      // Open at the final position and zoom, in one call. No `flyTo`, no
      // intermediate country view: this is the first and only view the user sees.
      map.setView([start.lat, start.lng], startZoom.current, { animate: false });
      onReady?.();

      // The draggable pin, created up front and hidden until a point is chosen.
      const marker = createPinMarker(L, [start.lat, start.lng], { draggable: true })
        .addTo(map)
        .on('dragend', () => {
          const ll = marker.getLatLng();
          onChangeRef.current({ lat: ll.lat, lng: ll.lng });
        });
      markerRef.current = marker;
      if (!initialValueRef.current) hideMarker(marker);

      // "You are here" — a pulsing dot separate from the chosen pin, so the
      // user can see both their own position and the point they picked.
      const me = createMeMarker(L, [geo.initialCenter.lat, geo.initialCenter.lng]).addTo(map);
      meRef.current = me;

      map.on('click', (e) => {
        const point = { lat: e.latlng.lat, lng: e.latlng.lng };
        marker.setLatLng([point.lat, point.lng]);
        showMarker(marker);
        onChangeRef.current(point);
      });

      return () => {
        markerRef.current = null;
        meRef.current = null;
        mapRef.current = null;
      };
    },
    [mapStyle],
    { style: mapStyle },
  );

  // Keep the pin in sync when the parent sets a point (e.g. after geolocation).
  useEffect(() => {
    if (!value) return;
    markerRef.current?.setLatLng([value.lat, value.lng]);
    if (markerRef.current) showMarker(markerRef.current);
    mapRef.current?.setView([value.lat, value.lng], NEIGHBOURHOOD_ZOOM, { animate: true });
  }, [value?.lat, value?.lng]);

  // Move the "you are here" dot as the fix refreshes or the user moves.
  useEffect(() => {
    const p = geo.position;
    if (!p || !meRef.current) return;
    meRef.current.setLatLng([p.lat, p.lng]);
  }, [geo.position?.lat, geo.position?.lng]);

  const locate = useCallback(() => {
    setGeoError(null);
    geo.refresh();
  }, [geo]);

  // Surface a refusal only when there is nothing to fall back on; otherwise the
  // remembered city is a perfectly good answer and an error would be noise.
  useEffect(() => {
    if (geo.status === 'denied') setGeoError(t('map.denied'));
    else if (geo.status === 'unsupported') setGeoError(t('map.unsupported'));
    else setGeoError(null);
  }, [geo.status, t]);

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

  const isFull = variant === 'full';

  return (
    <div className={isFull ? className : `space-y-2 ${className ?? ''}`}>
      <div
        className={
          isFull
            ? 'relative h-full w-full overflow-hidden'
            : 'relative overflow-hidden rounded-xl border border-[rgb(var(--line))]'
        }
      >
        {/* Edge-to-edge canvas: Leaflet's own chrome (zoom, attribution) floats
            over the tiles, so the map occupies the full box. */}
        <div
          ref={containerRef}
          className={isFull ? 'map-canvas h-full w-full' : 'map-canvas'}
          style={isFull ? undefined : { height }}
          dir="ltr"
        />

        {/* While the first fix is pending, a small pill explains the wait rather
            than leaving a blank or grey map. It fades the moment we have a
            centre, which for a returning user is immediate. */}
        {geo.locating && (
          <div className="map-status" role="status" aria-live="polite">
            <span className="map-status-spinner" aria-hidden />
            {t('map.locating')}
          </div>
        )}

        {showLocateButton && (
          <button
            type="button"
            onClick={locate}
            disabled={geo.locating}
            aria-label={t('map.myLocation')}
            title={t('map.myLocation')}
            className={['map-fab map-fab-brand', isFull ? '' : 'absolute end-3 bottom-3']
              .filter(Boolean)
              .join(' ')}
            style={
              isFull
                ? { position: 'absolute', insetInlineEnd: '0.75rem', bottom: '0.75rem' }
                : undefined
            }
          >
            {geo.locating ? (
              <span className="map-fab-spinner" aria-hidden />
            ) : (
              <CategoryIcon name="nav" size={21} strokeWidth={2.1} />
            )}
          </button>
        )}
      </div>

      {!isFull && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
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
        </>
      )}
    </div>
  );
}

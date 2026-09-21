'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Marker as LeafletMarker } from 'leaflet';
import { useI18n } from '@/lib/i18n-provider';
import { CategoryIcon } from '@/lib/icons';
import { MapView, ThemedMarker, DEFAULT_MAP_STYLE, type MapStyle } from './map-view';
import { useMyLocation, NEIGHBOURHOOD_ZOOM, type LatLng } from './use-my-location';

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
  /**
   * Resolve and report the address automatically whenever the picked point
   * changes. Used by the compose screen, where the map is the only place the
   * location is entered and there is no address field to fill in.
   */
  autoFillAddress?: boolean;
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
  autoFillAddress = false,
  onReady,
}: MapPickerProps) {
  const { t } = useI18n();
  const markerRef = useRef<LeafletMarker | null>(null);
  const [picked, setPicked] = useState<PickedPoint | null>(value);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [reverseBusy, setReverseBusy] = useState(false);

  const fallback = defaultCenter
    ? { lat: defaultCenter[0], lng: defaultCenter[1] }
    : undefined;
  const geo = useMyLocation({ live: follow, zoom: NEIGHBOURHOOD_ZOOM });

  // The centre the map is committed to at mount: an explicit default wins,
  // otherwise the remembered/device position resolved synchronously.
  const startRef = useRef<LatLng>(fallback ?? geo.initialCenter);

  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // `MapContainer` props are immutable, so capture the starting view once.
  const startCenter: [number, number] = useRef<[number, number]>(
    value
      ? [value.lat, value.lng]
      : [startRef.current.lat, startRef.current.lng],
  ).current;

  const handlePick = useCallback((lat: number, lng: number) => {
    const point = { lat, lng };
    setPicked(point);
    onChangeRef.current(point);
  }, []);

  // Keep the pin in sync when the parent sets a point (e.g. after geolocation).
  useEffect(() => {
    if (!value) return;
    setPicked(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.lat, value?.lng]);

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
    if (!picked || !onAddressChange) return;
    setReverseBusy(true);
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${picked.lat}&lon=${picked.lng}&accept-language=${encodeURIComponent(document.documentElement.lang || 'ar')}`;
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      const data = (await res.json()) as { display_name?: string };
      if (data.display_name) onAddressChange(data.display_name);
    } catch {
      /* reverse geocoding is a convenience; leaving the field is fine */
    } finally {
      setReverseBusy(false);
    }
  }, [picked?.lat, picked?.lng, onAddressChange]);

  // In `autoFillAddress` mode the map is the only place a location is entered,
  // so resolve the address as soon as the point settles. Nominatim rate-limits,
  // so debounce: a drag or a few taps collapse into one request.
  const autoReverse = useRef(reverse);
  autoReverse.current = reverse;
  useEffect(() => {
    if (!autoFillAddress || !picked || !onAddressChange) return;
    const id = window.setTimeout(() => void autoReverse.current(), 600);
    return () => window.clearTimeout(id);
  }, [autoFillAddress, picked?.lat, picked?.lng, onAddressChange]);

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
          className={isFull ? 'compose-map-canvas' : 'map-canvas'}
          style={isFull ? undefined : { height }}
        >
          <MapView
            center={startCenter}
            zoom={NEIGHBOURHOOD_ZOOM}
            style={mapStyle}
            className={isFull ? 'h-full w-full' : 'h-full w-full'}
            onReady={() => {
              startRef.current = fallback ?? geo.initialCenter;
              onReady?.();
            }}
            onMapClick={handlePick}
            view={
              value
                ? { center: [value.lat, value.lng], zoom: NEIGHBOURHOOD_ZOOM, animate: true }
                : undefined
            }
          >
            {/* The draggable pin, hidden until a point is chosen. */}
            <ThemedMarker
              position={picked ? [picked.lat, picked.lng] : startCenter}
              kind="pin"
              opacity={picked ? 1 : 0}
              draggable
              markerRef={(m) => {
                markerRef.current = m;
              }}
              onDragEnd={handlePick}
            />

            {/* "You are here" — a pulsing dot separate from the chosen pin, so
                the user can see both their own position and the point they
                picked. */}
            <ThemedMarker
              position={[geo.position?.lat ?? startRef.current.lat, geo.position?.lng ?? startRef.current.lng]}
              kind="me"
            />
          </MapView>
        </div>

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

        {/* Full-screen mode has no room for a hint below the map, but the point
            is required before the request can be sent. Say so on the map, and
            keep saying it until a point exists, so the send button is never the
            first place the customer learns a location is missing. */}
        {isFull && !picked && (
          <div className="map-prompt" role="status" aria-live="polite">
            <CategoryIcon name="pin" size={17} strokeWidth={2.2} />
            {t('map.tapHint')}
          </div>
        )}
      </div>

      {!isFull && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {picked && onAddressChange && (
              <button
                type="button"
                onClick={reverse}
                disabled={reverseBusy}
                className="rounded-lg border border-black/15 px-3 py-1.5 font-medium disabled:opacity-50 dark:border-white/20"
              >
                {reverseBusy ? t('map.looking') : t('map.fillAddress')}
              </button>
            )}

            {picked && (
              <span className="font-mono text-[11px] opacity-60" dir="ltr">
                {picked.lat.toFixed(5)}, {picked.lng.toFixed(5)}
              </span>
            )}
          </div>

          {geoError && <p className="text-xs text-amber-600">{geoError}</p>}
          {!picked && <p className="text-xs opacity-60">{t('map.tapHint')}</p>}
          {address && <p className="text-xs opacity-60">{address}</p>}
        </>
      )}
    </div>
  );
}

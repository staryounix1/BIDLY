'use client';

import { useEffect, useMemo, type ReactNode } from 'react';
import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  ZoomControl,
  useMap,
  useMapEvents,
} from 'react-leaflet';
import type { Map as LeafletMap, Marker as LeafletMarker } from 'leaflet';
import { markerIconFor, type MarkerKind } from './marker-icons';

/**
 * Map primitives, built on react-leaflet.
 *
 * react-leaflet is the official React binding for Leaflet: it owns the map
 * instance and the layers through React state, so there is no imperative
 * `map.addLayer()` bookkeeping and no cleanup ordering to get wrong. Leaflet
 * still does the rendering — react-leaflet only drives it — which is why the
 * tiles, gestures and projection behave exactly as before.
 *
 * The whole screen shape (dark basemap, no zoom animation, neighbourhood start)
 * is preserved; only the plumbing moved from hand-written effects to components.
 */

export type MapStyle = 'dark' | 'voyager' | 'positron' | 'osm';

/**
 * CARTO basemaps need an API key, and passing it as `api_key` is silently
 * ignored (which shows a watermark), so it must go in as `key`.
 */
const CARTO_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY ?? '';

const carto = (name: string, retina: boolean) =>
  `https://{s}.basemaps.cartocdn.com/${name}/{z}/{x}/{y}${retina ? '@2x' : ''}.png?key=${encodeURIComponent(CARTO_KEY)}`;

export function tileUrlFor(style: MapStyle): { url: string; attribution: string } {
  // Without a key CARTO watermarks its tiles, so fall back to plain OSM, which
  // is always usable and needs no configuration.
  if (!CARTO_KEY || style === 'osm') {
    return {
      url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    };
  }
  const names: Record<Exclude<MapStyle, 'osm'>, string> = {
    dark: 'dark_all',
    voyager: 'rastertiles/voyager',
    positron: 'light_all',
  };
  return {
    url: carto(names[style as Exclude<MapStyle, 'osm'>] ?? 'dark_all', true),
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  };
}

/** The app paints dark by default when a CARTO key is present, else OSM. */
export const DEFAULT_MAP_STYLE: MapStyle = CARTO_KEY ? 'dark' : 'osm';

/** Re-measure after layout settles. react-leaflet sizes on mount, but these
 *  screens put the map in a fixed layer whose height can still be 0 at that
 *  instant; without this Leaflet caches a zero viewport and draws nothing. */
function AutoResize() {
  const map = useMap();
  useEffect(() => {
    const refresh = () => map.invalidateSize();
    const t0 = window.setTimeout(refresh, 0);
    const t1 = window.setTimeout(refresh, 150);
    const el = map.getContainer();
    let ro: ResizeObserver | undefined;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => {
        if (el.offsetHeight) refresh();
      });
      ro.observe(el);
    }
    return () => {
      window.clearTimeout(t0);
      window.clearTimeout(t1);
      ro?.disconnect();
    };
  }, [map]);
  return null;
}

/** Runs Leaflet gesture wiring once the map exists. */
function MapReady({ onReady }: { onReady?: (map: LeafletMap) => void }) {
  const map = useMap();
  useEffect(() => {
    onReady?.(map);
  }, [map, onReady]);
  return null;
}

/** Reports clicks/taps on the map. */
function MapClicks({ onClick }: { onClick?: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onClick?.(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/** Re-centre declaratively whenever the target changes. */
function ViewTo({
  center,
  zoom,
  animate,
}: {
  center: [number, number] | null;
  zoom: number;
  animate: boolean;
}) {
  const map = useMap();
  useEffect(() => {
    if (!center) return;
    map.setView(center, zoom, { animate });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.[0], center?.[1], zoom]);
  return null;
}

export interface MapViewProps {
  center: [number, number];
  zoom: number;
  style?: MapStyle;
  className?: string;
  children?: ReactNode;
  /** Leaflet interaction toggles, passed straight through. */
  zoomControl?: boolean;
  dragging?: boolean;
  scrollWheelZoom?: boolean;
  /** Called once with the map instance (for follow/recenter wiring). */
  onReady?: (map: LeafletMap) => void;
  onMapClick?: (lat: number, lng: number) => void;
  /** Move the view when these change (used for external recentring). */
  view?: { center: [number, number] | null; zoom: number; animate?: boolean };
}

/**
 * The map itself. `MapContainer` props are immutable after mount (react-leaflet
 * contract), so anything that changes over time is a child component instead.
 */
export function MapView({
  center,
  zoom,
  style = DEFAULT_MAP_STYLE,
  className,
  children,
  zoomControl = true,
  dragging = true,
  scrollWheelZoom = true,
  onReady,
  onMapClick,
  view,
}: MapViewProps) {
  const tiles = useMemo(() => tileUrlFor(style), [style]);
  const isDark = style === 'dark';

  return (
    <MapContainer
      center={center}
      zoom={zoom}
      zoomControl={false}
      dragging={dragging}
      scrollWheelZoom={scrollWheelZoom}
      zoomAnimation={false}
      className={[className ?? '', 'map-canvas', isDark ? 'map-canvas--dark' : '']
        .filter(Boolean)
        .join(' ')}
    >
      <TileLayer url={tiles.url} attribution={tiles.attribution} maxZoom={19} subdomains="abcd" />
      {zoomControl && <ZoomControl position="bottomright" />}
      <AutoResize />
      <MapReady onReady={onReady} />
      <MapClicks onClick={onMapClick} />
      {view && (
        <ViewTo center={view.center} zoom={view.zoom} animate={view.animate ?? false} />
      )}
      {children}
    </MapContainer>
  );
}

export interface ThemedMarkerProps {
  position: [number, number];
  kind: MarkerKind;
  label?: string;
  dim?: boolean;
  opacity?: number;
  draggable?: boolean;
  /** Keep a handle on the Leaflet marker so parents can update it imperatively. */
  markerRef?: (marker: LeafletMarker | null) => void;
  onDragEnd?: (lat: number, lng: number) => void;
  /** Popup body; omit for no popup. */
  popup?: ReactNode;
}

/** A themed marker; the icon artwork lives in `marker-icons.ts`. */
export function ThemedMarker({
  position,
  kind,
  label,
  dim,
  opacity = 1,
  draggable = false,
  markerRef,
  onDragEnd,
  popup,
}: ThemedMarkerProps) {
  const icon = useMemo(() => markerIconFor(kind, { label, dim }), [kind, label, dim]);

  return (
    <Marker
      position={position}
      icon={icon}
      opacity={opacity}
      draggable={draggable}
      ref={(m) => {
        markerRef?.(m as LeafletMarker | null);
      }}
      {...(onDragEnd
        ? {
            eventHandlers: {
              dragend(e) {
                const ll = (e.target as LeafletMarker).getLatLng();
                onDragEnd(ll.lat, ll.lng);
              },
            },
          }
        : {})}
    >
      {popup ? <Popup>{popup}</Popup> : null}
    </Marker>
  );
}

export { useMap };
export type { LeafletMap };

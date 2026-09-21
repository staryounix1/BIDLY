'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Leaflet map, loaded from the CDN on demand.
 *
 * Leaflet is not an npm dependency: it is fetched as a script+stylesheet pair
 * the first time a map renders, then reused. That keeps it out of the Next.js
 * bundle (and off the main thread's parse cost) for every page that never
 * shows a map, which is most of them.
 *
 * OpenStreetMap tiles are free and need no API key, so there is nothing for
 * the user to configure and no billing surface.
 */

const LEAFLET_VERSION = '1.9.4';
const CSS_HREF = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
const JS_SRC = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;

declare global {
  interface Window {
    L?: LeafletNamespace;
  }
}

interface LeafletNamespace {
  map: (el: HTMLElement, opts?: Record<string, unknown>) => LeafletMap;
  tileLayer: (url: string, opts?: Record<string, unknown>) => { addTo: (m: LeafletMap) => void };
  marker: (ll: [number, number], opts?: Record<string, unknown>) => LeafletMarker;
  circle: (ll: [number, number], opts?: Record<string, unknown>) => LeafletLayer;
  divIcon: (opts: Record<string, unknown>) => unknown;
  latLng: (lat: number, lng: number) => unknown;
  control: Record<string, unknown>;
}

export interface LeafletMap {
  setView: (ll: [number, number], zoom?: number) => LeafletMap;
  on: (event: string, handler: (e: LeafletEvent) => void) => void;
  remove: () => void;
  invalidateSize: () => void;
  fitBounds: (b: unknown, opts?: Record<string, unknown>) => void;
  getZoom: () => number;
  zoomIn: (delta?: number) => LeafletMap;
  zoomOut: (delta?: number) => LeafletMap;
  zoomControl?: { setPosition: (pos: string) => void } | undefined;
}

interface LeafletEvent {
  latlng: { lat: number; lng: number };
}

export interface LeafletMarker {
  addTo: (m: LeafletMap) => LeafletMarker;
  setLatLng: (ll: [number, number]) => LeafletMarker;
  getLatLng: () => { lat: number; lng: number };
  bindPopup: (html: string) => LeafletMarker;
  openPopup: () => LeafletMarker;
  setOpacity: (opacity: number) => LeafletMarker;
  on: (event: string, handler: (e: LeafletEvent) => void) => LeafletMarker;
  remove: () => void;
}

interface LeafletLayer {
  addTo: (m: LeafletMap) => LeafletLayer;
  bindPopup: (html: string) => LeafletLayer;
  remove: () => void;
}

let loader: Promise<LeafletNamespace> | null = null;

/** Load Leaflet once; every caller after the first awaits the same promise. */
export function loadLeaflet(): Promise<LeafletNamespace> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.L) return Promise.resolve(window.L);
  if (loader) return loader;

  loader = new Promise<LeafletNamespace>((resolve, reject) => {
    if (!document.querySelector(`link[href="${CSS_HREF}"]`)) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = CSS_HREF;
      document.head.appendChild(link);
    }

    const existing = document.querySelector(`script[src="${JS_SRC}"]`) as HTMLScriptElement | null;
    const script = existing ?? document.createElement('script');
    script.src = JS_SRC;
    script.async = true;
    script.addEventListener('load', () => {
      if (window.L) resolve(window.L);
      else reject(new Error('Leaflet failed to initialise'));
    });
    script.addEventListener('error', () => reject(new Error('Leaflet failed to load')));
    if (!existing) document.body.appendChild(script);
  });

  loader.catch(() => {
    loader = null;
  });
  return loader;
}

/**
 * Basemaps.
 *
 * CARTO's Voyager and Positron are the clean, light, ride-hailing-grade
 * cartography this app wants. Since 2026 CARTO stamps every tile served
 * without a valid key with an "API KEY REQUIRED" watermark, so a keyless
 * Voyager is not shippable — it paints a diagonal advert across the map.
 *
 * The key is free, needs no CARTO account, and is requested at
 * https://carto.com/basemaps/apikey/. Supply it as `NEXT_PUBLIC_CARTO_API_KEY`
 * and Voyager is used. Without a key we fall back to the keyless OSM raster
 * style, which is clean enough to ship and never watermarked.
 *
 * CARTO reads the key from `?key=`. `?api_key=` is accepted by the dashboard
 * examples but is **ignored** by the raster CDN — verified by rendering both,
 * where only `?key=` clears the watermark.
 *
 * `{r}` lets Leaflet append `@2x` on retina displays, which is what keeps the
 * labels crisp on phones.
 */
export type MapStyle = 'voyager' | 'positron' | 'osm';

/** A CARTO style needs a key only because CARTO demands one. */
function cartoUrl(path: string): string {
  const key = (process.env.NEXT_PUBLIC_CARTO_API_KEY ?? '').trim();
  const suffix = key ? `?key=${encodeURIComponent(key)}` : '';
  return `https://{s}.basemaps.cartocdn.com/${path}/{z}/{x}/{y}{r}.png${suffix}`;
}

const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const CARTO_ATTRIBUTION = `${OSM_ATTRIBUTION} &copy; <a href="https://carto.com/attributions">CARTO</a>`;

export const TILE_STYLES: Record<MapStyle, { url: string; attribution: string }> = {
  voyager: { url: cartoUrl('rastertiles/voyager'), attribution: CARTO_ATTRIBUTION },
  positron: { url: cartoUrl('light_all'), attribution: CARTO_ATTRIBUTION },
  osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: OSM_ATTRIBUTION },
};

/** True when a CARTO key is configured, i.e. the CARTO styles are watermarked-free. */
export const HAS_CARTO_KEY = Boolean((process.env.NEXT_PUBLIC_CARTO_API_KEY ?? '').trim());

/**
 * Default basemap. Voyager when a CARTO key is present, otherwise the keyless
 * OSM style — never the watermarked one.
 */
export const DEFAULT_MAP_STYLE: MapStyle = HAS_CARTO_KEY ? 'voyager' : 'osm';

// `TILE_URL`/`TILE_ATTRIBUTION` are kept for callers that only need a URL; they
// follow the same key-aware default so nobody accidentally loads a watermark.
export const TILE_URL = TILE_STYLES[DEFAULT_MAP_STYLE].url;
export const TILE_ATTRIBUTION = TILE_STYLES[DEFAULT_MAP_STYLE].attribution;

/**
 * Add a basemap to `map`, defaulting to the key-aware default style.
 *
 * `crossOrigin` is required for retina subdomains and keeps the tiles
 * cache-friendly; `subdomains` only applies to the CARTO hosts.
 */
export function addTileLayer(
  L: LeafletNamespace,
  map: LeafletMap,
  style: MapStyle = DEFAULT_MAP_STYLE,
): void {
  const { url, attribution } = TILE_STYLES[style];
  L.tileLayer(url, {
    attribution,
    maxZoom: 19,
    ...(style === 'osm' ? {} : { subdomains: 'abcd' }),
    crossOrigin: true,
  }).addTo(map);
}

export function useLeaflet() {
  const [ready, setReady] = useState<boolean>(() => typeof window !== 'undefined' && !!window.L);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    loadLeaflet()
      .then(() => alive && setReady(true))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, []);

  return { ready, failed };
}

/**
 * Attach a map to `containerRef`, run `setup` once Leaflet is ready, and
 * always tear the map down on unmount so Fast Refresh cannot leak instances.
 */
export function useMap(
  containerRef: React.RefObject<HTMLElement | null>,
  setup: (L: LeafletNamespace, map: LeafletMap) => void | (() => void),
  deps: unknown[] = [],
) {
  const setupRef = useRef(setup);
  setupRef.current = setup;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let cleanup: void | (() => void);
    let map: LeafletMap | null = null;
    let alive = true;

    loadLeaflet().then((L) => {
      if (!alive || !containerRef.current) return;
      // Keep Leaflet's own zoom control (it handles enable/disable and touch
      // behaviour), but move it out of the top-left default into the
      // bottom-right inset; globals.css restyles it into a white pill.
      map = L.map(containerRef.current, { zoomControl: true, attributionControl: true });
      map.zoomControl?.setPosition('bottomright');
      const result = setupRef.current(L, map);
      cleanup = result ?? undefined;
      // Tiles and the container settle a tick after mount; nudge Leaflet so
      // the first paint is not a grey half-drawn canvas.
      setTimeout(() => map?.invalidateSize(), 120);
    });

    return () => {
      alive = false;
      cleanup?.();
      map?.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

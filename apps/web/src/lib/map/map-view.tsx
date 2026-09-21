'use client';

import { useEffect, useState, type ComponentType, type ReactNode } from 'react';

/**
 * SSR-safe façade for the map, backed by react-leaflet.
 *
 * Leaflet touches `window` the moment the module is evaluated, so importing
 * react-leaflet from a route that Next.js prerenders throws
 * `ReferenceError: window is not defined`. The real implementation therefore
 * lives in `leaflet-map.tsx` and is pulled in with a dynamic `import()` once the
 * component has mounted in the browser.
 *
 * Components import from this module (`@/lib/map/map-view`) rather than from
 * `leaflet-map` directly, so no server code path can reach Leaflet.
 *
 * While the chunk loads, a neutral placeholder holds the exact box the map will
 * occupy, which avoids a layout shift and keeps the height stable for the
 * ResizeObserver that re-measures Leaflet afterwards.
 */

export type { MapStyle, MapViewProps, ThemedMarkerProps } from './leaflet-map';

/** Shared with the real module; duplicated as a literal because this file must
 *  not import anything that transitively evaluates Leaflet on the server. */
const CARTO_KEY = process.env.NEXT_PUBLIC_CARTO_API_KEY ?? '';
export const DEFAULT_MAP_STYLE: import('./leaflet-map').MapStyle = CARTO_KEY ? 'dark' : 'osm';

type LeafletMapModule = typeof import('./leaflet-map');

let modulePromise: Promise<LeafletMapModule> | null = null;

function loadMapModule(): Promise<LeafletMapModule> {
  modulePromise ??= import('./leaflet-map');
  return modulePromise;
}

/** Load the real map module once mounted, and render it when ready. */
function useMapModule(): LeafletMapModule | null {
  const [mod, setMod] = useState<LeafletMapModule | null>(null);

  useEffect(() => {
    let alive = true;
    loadMapModule().then((m) => {
      if (alive) setMod(m);
    });
    return () => {
      alive = false;
    };
  }, []);

  return mod;
}

/** Holds the map's box while the browser-only chunk is loading. */
function MapPlaceholder({ className, dark }: { className?: string; dark: boolean }) {
  return (
    <div
      className={[className ?? '', 'map-canvas', dark ? 'map-canvas--dark' : '']
        .filter(Boolean)
        .join(' ')}
      aria-hidden
    />
  );
}

export function MapView(props: import('./leaflet-map').MapViewProps) {
  const mod = useMapModule();
  const dark = (props.style ?? DEFAULT_MAP_STYLE) === 'dark';
  if (!mod) return <MapPlaceholder className={props.className} dark={dark} />;
  return <mod.MapView {...props} />;
}

export function ThemedMarker(props: import('./leaflet-map').ThemedMarkerProps) {
  const mod = useMapModule();
  if (!mod) return null;
  return <mod.ThemedMarker {...props} />;
}

/** Re-exported for callers that need the Leaflet map instance. */
export type LeafletMap = import('leaflet').Map;

/** Compile-time guard: this module must never gain a static Leaflet import. */
export type { ReactNode, ComponentType };

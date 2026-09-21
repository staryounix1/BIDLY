'use client';

import type { DivIcon } from 'leaflet';

/**
 * Custom map markers.
 *
 * The stock Leaflet pin is a blue teardrop that fights the dark basemap and the
 * app's aqua brand. These are drawn as inline SVG `divIcon`s instead: no image
 * assets to ship, crisp at any DPR, and themeable from one place.
 *
 * Three markers cover every screen:
 *   `me`       — a pulsing aqua dot: where the user is.
 *   `pin`      — a teardrop for a chosen point (pickup, destination, job).
 *   `provider` — a filled disc for a nearby or incoming provider.
 *
 * Every one is anchored so the *pointed tip* sits on the coordinate, not the
 * icon's centre; otherwise a pin reads one street off from where it points.
 *
 * `leaflet` is imported lazily inside `markerIconFor`. Leaflet touches `window`
 * as soon as it is evaluated, so a top-level import would break server
 * rendering for every route that transitively includes this module.
 */

export type MarkerKind = 'me' | 'pin' | 'provider';

/** Aqua brand ramp, copied as literals because divIcons live outside CSS vars. */
const BRAND = '#32f4ba';
const BRAND_DEEP = '#063d30';
const PIN_BODY = '#10cd99';

export interface MarkerOptions {
  /** Small caption shown in a bubble above the marker. */
  label?: string;
  /** Provider markers only: online providers read brighter than offline ones. */
  dim?: boolean;
}

const PIN_SIZE: [number, number] = [34, 44];
const PIN_ANCHOR: [number, number] = [17, 42];
const DOT_SIZE: [number, number] = [18, 18];
const DISC_SIZE: [number, number] = [30, 30];

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

function markerHtml(kind: MarkerKind, opts: MarkerOptions): string {
  const bubble = opts.label
    ? `<span class="bidly-marker-label">${escapeHtml(opts.label)}</span>`
    : '';

  if (kind === 'me') {
    return `${bubble}<span class="bidly-me"><span class="bidly-me-pulse"></span><span class="bidly-me-dot"></span></span>`;
  }

  if (kind === 'provider') {
    const fill = opts.dim ? '#3d6b5c' : PIN_BODY;
    return `${bubble}<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
        <circle cx="15" cy="15" r="13" fill="${fill}" fill-opacity="0.22"/>
        <circle cx="15" cy="15" r="8" fill="${fill}" stroke="${BRAND_DEEP}" stroke-width="2"/>
        <circle cx="15" cy="15" r="3" fill="${BRAND_DEEP}"/>
      </svg>`;
  }

  return `${bubble}<svg width="34" height="44" viewBox="0 0 34 44" aria-hidden="true">
      <path d="M17 42S32 27 32 16A15 15 0 1 0 2 16C2 27 17 42 17 42z"
            fill="${BRAND}" stroke="${BRAND_DEEP}" stroke-width="2.5"/>
      <circle cx="17" cy="16" r="5.5" fill="${BRAND_DEEP}"/>
    </svg>`;
}

/**
 * Build the `DivIcon` for a marker kind.
 *
 * Icon sizes are in CSS pixels; Leaflet scales them for retina automatically, so
 * the SVGs stay crisp without shipping `@2x` assets.
 */
export function markerIconFor(kind: MarkerKind, opts: MarkerOptions = {}): DivIcon {
  const size = kind === 'me' ? DOT_SIZE : kind === 'provider' ? DISC_SIZE : PIN_SIZE;
  const anchor: [number, number] = kind === 'pin' ? PIN_ANCHOR : [size[0] / 2, size[1] / 2];

  // `require` keeps Leaflet out of the server bundle: this function only runs in
  // the browser, after `MapView` has mounted.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { divIcon } = require('leaflet') as typeof import('leaflet');

  return divIcon({
    className: `bidly-marker bidly-marker--${kind}`,
    html: markerHtml(kind, opts),
    iconSize: size,
    iconAnchor: anchor,
  });
}

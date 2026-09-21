'use client';

import type { LeafletNamespace, LeafletMap, LeafletMarker } from './leaflet';

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
  /** Any other Leaflet marker option (draggable, opacity, …). */
  [key: string]: unknown;
}

function svg(html: string, size: [number, number], anchor: [number, number], extraClass = '') {
  return {
    className: `bidly-marker ${extraClass}`.trim(),
    html,
    iconSize: size,
    iconAnchor: anchor,
  };
}

function markerHtml(kind: MarkerKind, opts: MarkerOptions): Record<string, unknown> {
  const bubble = opts.label
    ? `<span class="bidly-marker-label">${escapeHtml(opts.label)}</span>`
    : '';

  if (kind === 'me') {
    return svg(
      `${bubble}<span class="bidly-me"><span class="bidly-me-pulse"></span><span class="bidly-me-dot"></span></span>`,
      [18, 18],
      [9, 9],
      'bidly-marker--me',
    );
  }

  if (kind === 'provider') {
    const fill = opts.dim ? '#3d6b5c' : PIN_BODY;
    return svg(
      `${bubble}<svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
        <circle cx="15" cy="15" r="13" fill="${fill}" fill-opacity="0.22"/>
        <circle cx="15" cy="15" r="8" fill="${fill}" stroke="${BRAND_DEEP}" stroke-width="2"/>
        <circle cx="15" cy="15" r="3" fill="${BRAND_DEEP}"/>
      </svg>`,
      [30, 30],
      [15, 15],
      'bidly-marker--provider',
    );
  }

  // pin
  return svg(
    `${bubble}<svg width="34" height="44" viewBox="0 0 34 44" aria-hidden="true">
      <path d="M17 42S32 27 32 16A15 15 0 1 0 2 16C2 27 17 42 17 42z"
            fill="${BRAND}" stroke="${BRAND_DEEP}" stroke-width="2.5"/>
      <circle cx="17" cy="16" r="5.5" fill="${BRAND_DEEP}"/>
    </svg>`,
    [34, 44],
    [17, 42],
    'bidly-marker--pin',
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );
}

/** Create a themed marker ready to `.addTo(map)`. */
export function createMarker(
  L: LeafletNamespace,
  latlng: [number, number],
  kind: MarkerKind,
  opts: MarkerOptions & Record<string, unknown> = {},
): LeafletMarker {
  const icon = L.divIcon(markerHtml(kind, opts));
  const { label: _label, dim: _dim, ...rest } = opts;
  return L.marker(latlng, { icon, ...rest });
}

/** Convenience: a pulsing "you are here" dot. */
export function createMeMarker(
  L: LeafletNamespace,
  latlng: [number, number],
  opts: MarkerOptions = {},
): LeafletMarker {
  return createMarker(L, latlng, 'me', opts);
}

/** Convenience: a teardrop pin for a chosen point. */
export function createPinMarker(
  L: LeafletNamespace,
  latlng: [number, number],
  opts: MarkerOptions & Record<string, unknown> = {},
): LeafletMarker {
  return createMarker(L, latlng, 'pin', opts);
}

export type { LeafletNamespace, LeafletMap, LeafletMarker };

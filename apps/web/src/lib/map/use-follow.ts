'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import type { LatLng } from './use-my-location';

/**
 * Live follow: keep the map centred on a moving point until the user takes over.
 *
 * The interaction every maps app has, and the one people expect:
 *   - while `following` is on, each new point pans the map so the marker stays
 *     centred;
 *   - the moment the user drags or pinches, following switches *off* so the app
 *     never fights a deliberate gesture;
 *   - a recenter control turns it back on and flies to the current point.
 *
 * Panning uses Leaflet's own easing (`setView` with a duration), so movement is
 * smooth rather than a jump cut.
 */

export interface UseFollowOptions {
  /** The point to follow; usually the device position. */
  point: LatLng | null;
  zoom?: number;
  /** Start in follow mode. Default true. */
  enabled?: boolean;
  /** Only follow after the user has interacted — off by default. */
  requireIntent?: boolean;
}

export interface UseFollowResult {
  following: boolean;
  /** True once the user has panned/zoomed by hand at least once. */
  userMoved: boolean;
  /** Set on the map element to wire the gesture detection. */
  onMapReady: (map: LeafletMap) => void;
  /** Re-enable follow and fly to the point. */
  recenter: () => void;
  /** Toggle follow without moving the map (used before a fit). */
  setFollowing: (on: boolean) => void;
}

/** Leaflet pans with an object `{animate, duration}`; keep it short and eased. */
const PAN_DURATION_S = 0.6;

export function useFollow({
  point,
  zoom,
  enabled = true,
  requireIntent = false,
}: UseFollowOptions): UseFollowResult {
  const mapRef = useRef<LeafletMap | null>(null);
  const [following, setFollowingState] = useState(enabled && !requireIntent);
  const [userMoved, setUserMoved] = useState(false);
  const programmaticRef = useRef(false);
  const pointRef = useRef<LatLng | null>(point);
  pointRef.current = point;

  const panTo = useCallback(
    (target: LatLng, opts: { animate: boolean }) => {
      const map = mapRef.current;
      if (!map) return;
      programmaticRef.current = true;
      map.setView([target.lat, target.lng], zoom, {
        animate: opts.animate,
        duration: PAN_DURATION_S,
      });
      // Leaflet fires `movestart/moveend` for programmatic pans too; release the
      // guard on the next frame so a real gesture is still detected.
      window.setTimeout(() => {
        programmaticRef.current = false;
      }, opts.animate ? PAN_DURATION_S * 1000 + 60 : 0);
    },
    [zoom],
  );

  const onMapReady = useCallback(
    (map: LeafletMap) => {
      mapRef.current = map;

      // `dragstart` is the unambiguous "the user took the wheel" signal; zoom
      // buttons and pinch both end in a `zoomstart` we can check cheaply.
      const onDragStart = () => {
        if (!programmaticRef.current) {
          setUserMoved(true);
          setFollowingState(false);
        }
      };

      map.on('dragstart', onDragStart);
    },
    [],
  );

  // Follow every new position while the mode is on.
  useEffect(() => {
    if (!following || !point) return;
    // The very first fix should not animate if we are already there.
    panTo(point, { animate: userMoved });
    // Intentionally depend on the coordinates, not the object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following, point?.lat, point?.lng, panTo, userMoved]);

  const recenter = useCallback(() => {
    setFollowingState(true);
    const target = pointRef.current;
    if (target) panTo(target, { animate: true });
  }, [panTo]);

  const setFollowing = useCallback((on: boolean) => setFollowingState(on), []);

  return { following, userMoved, onMapReady, recenter, setFollowing };
}

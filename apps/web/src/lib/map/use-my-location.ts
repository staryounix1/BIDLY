'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Where the map should open.
 *
 * inDrive-like behaviour: the first map the user sees is already centred on
 * their own neighbourhood at street-ish zoom — never a country view they have
 * to zoom into. That means the centre has to be known *before* the first paint,
 * so this hook resolves it in this order:
 *
 *   1. a remembered city from a previous session (localStorage) — instant, no
 *      permission prompt, and correct for a returning user;
 *   2. the device's current position (Geolocation API) — the accurate answer,
 *      but asynchronous and possibly refused;
 *   3. the app's launch city — the last resort so a map is never empty.
 *
 * `initialCenter` is therefore always available immediately, which is what lets
 * the map call `setView` once at the final zoom instead of animating from a
 * default world view. When the precise fix arrives we optionally *ease* to it.
 */

const STORAGE_KEY = 'khdemli:last-map-center';
const STORAGE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/** The app's launch city (Marrakech), used only when nothing else is known. */
export const FALLBACK_CENTER: LatLng = { lat: 31.6295, lng: -7.9811 };

/** Neighbourhood zoom. 15 is a few blocks; 14 is a district. */
export const CITY_ZOOM = 13;
export const NEIGHBOURHOOD_ZOOM = 15;

export interface LatLng {
  lat: number;
  lng: number;
}

export type GeoStatus = 'locating' | 'granted' | 'denied' | 'unsupported' | 'remembered';

interface StoredCenter extends LatLng {
  savedAt: number;
  zoom?: number;
}

function readStored(): StoredCenter | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCenter;
    if (
      typeof parsed?.lat !== 'number' ||
      typeof parsed?.lng !== 'number' ||
      Number.isNaN(parsed.lat) ||
      Number.isNaN(parsed.lng)
    ) {
      return null;
    }
    if (parsed.savedAt && Date.now() - parsed.savedAt > STORAGE_MAX_AGE_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Remember where the user actually was, so the next visit opens there. */
export function rememberCenter(center: LatLng, zoom?: number): void {
  if (typeof window === 'undefined') return;
  try {
    const value: StoredCenter = { lat: center.lat, lng: center.lng, savedAt: Date.now(), zoom };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* private mode / quota — remembering is a convenience, not a requirement */
  }
}

export interface UseMyLocationOptions {
  /** Ask the device for a precise fix. Default true. */
  watch?: boolean;
  /** Report every position change instead of only the first (live follow). */
  live?: boolean;
  /** Zoom written alongside a remembered centre. */
  zoom?: number;
}

export interface UseMyLocationResult {
  /** Always present: the centre to open at, resolved synchronously. */
  initialCenter: LatLng;
  /** The freshest known position (device fix when granted, else the memory). */
  center: LatLng;
  /** Device fix only — null until permission is granted and a position lands. */
  position: LatLng | null;
  status: GeoStatus;
  /** True while the very first device fix is still pending (drives the loader). */
  locating: boolean;
  /** Re-request permission/position; used by the recenter button. */
  refresh: () => void;
  /** Persist a centre as the new "last seen". */
  remember: (c: LatLng) => void;
}

export function useMyLocation(options: UseMyLocationOptions = {}): UseMyLocationResult {
  const { watch = true, live = false, zoom = NEIGHBOURHOOD_ZOOM } = options;

  // Resolve the remembered centre during the first render so the map can open
  // at its final position with no visible jump or animation.
  const initialRef = useRef<StoredCenter | null | undefined>(undefined);
  if (initialRef.current === undefined) initialRef.current = readStored();
  const remembered = initialRef.current;

  const [position, setPosition] = useState<LatLng | null>(null);
  const [status, setStatus] = useState<GeoStatus>(remembered ? 'remembered' : 'locating');
  const [locating, setLocating] = useState(true);
  const watchIdRef = useRef<number | null>(null);
  const attemptRef = useRef(0);

  const initialCenter: LatLng = remembered ?? FALLBACK_CENTER;

  const clearWatch = useCallback(() => {
    if (watchIdRef.current != null && typeof navigator !== 'undefined' && navigator.geolocation) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setStatus('unsupported');
      setLocating(false);
      return;
    }

    clearWatch();
    const attempt = ++attemptRef.current;

    const onOk = (pos: GeolocationPosition) => {
      // A newer attempt superseded this one (e.g. the user hit recenter).
      if (attempt !== attemptRef.current) return;
      const next = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setPosition(next);
      setStatus('granted');
      setLocating(false);
      rememberCenter(next, zoom);
    };

    const onErr = () => {
      if (attempt !== attemptRef.current) return;
      // A refusal must not wipe a remembered city: keep showing it.
      setStatus(remembered ? 'remembered' : 'denied');
      setLocating(false);
    };

    const opts: PositionOptions = {
      enableHighAccuracy: true,
      timeout: 10_000,
      maximumAge: live ? 5_000 : 60_000,
    };

    if (live && watch) {
      watchIdRef.current = navigator.geolocation.watchPosition(onOk, onErr, opts);
    } else {
      navigator.geolocation.getCurrentPosition(onOk, onErr, opts);
    }
  }, [clearWatch, live, remembered, watch, zoom]);

  useEffect(() => {
    start();
    return clearWatch;
  }, [start, clearWatch]);

  const refresh = useCallback(() => {
    setLocating((prev) => (position ? prev : true));
    start();
  }, [position, start]);

  const remember = useCallback((c: LatLng) => rememberCenter(c, zoom), [zoom]);

  return {
    initialCenter,
    center: position ?? initialCenter,
    position,
    status,
    locating,
    refresh,
    remember,
  };
}

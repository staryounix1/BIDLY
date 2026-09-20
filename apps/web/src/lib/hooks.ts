'use client';

/**
 * Small client-side hooks shared across the marketplace screens.
 *
 * These exist so polling (provider availability counts, location refresh),
 * offer countdowns, and "still searching?" copy behave the same everywhere and
 * degrade safely during SSR. Every hook here is dependency-free: the app
 * already ships React, and a hook that depends on a timer library is a hook
 * nobody bothers to reuse.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

/**
 * A `setInterval` that survives re-renders and is safe to stop.
 *
 * `window.setInterval` captures whatever callback it was given at creation
 * time, so a naive `useEffect(() => setInterval(cb, ms))` either polls stale
 * state or restarts the whole timer on every render. We keep the callback in a
 * ref and never restart the interval, so the ticks stay evenly spaced while
 * always calling the newest closure.
 *
 * Passing `null` pauses the timer without unmounting — the usual way to stop
 * polling while a tab is backgrounded or a panel is collapsed, then resume.
 */
export function useInterval(callback: () => void, delayMs: number | null): void {
  const callbackRef = useRef(callback);

  // Keep the ref pointed at the latest callback without restarting the timer.
  useLayoutEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (delayMs === null || typeof window === 'undefined') return;
    const id = window.setInterval(() => callbackRef.current(), delayMs);
    return () => window.clearInterval(id);
  }, [delayMs]);
}

/** Stable snapshot storage behind `useSyncExternalStore` for media queries. */
interface MediaQueryStore {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => boolean;
  getServerSnapshot: () => boolean;
}

const mediaQueryStores = new Map<string, MediaQueryStore>();

/**
 * One shared `matchMedia` listener per query string.
 *
 * Offers frequently mount many components asking the same question ("is this a
 * phone?"). Reacting in each component means many near-identical listeners and
 * mismatched results between them; caching the store keeps every subscriber in
 * lockstep and caps the number of browser listeners at the number of distinct
 * queries.
 */
function getMediaQueryStore(query: string): MediaQueryStore {
  const existing = mediaQueryStores.get(query);
  if (existing) return existing;

  const listeners = new Set<() => void>();
  let mediaList: MediaQueryList | null =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query)
      : null;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const store: MediaQueryStore = {
    subscribe(onChange) {
      // Lazily (re)bind in case the module was evaluated on the server first.
      if (!mediaList && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        mediaList = window.matchMedia(query);
      }
      listeners.add(onChange);
      mediaList?.addEventListener('change', notify);
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) mediaList?.removeEventListener('change', notify);
      };
    },
    getSnapshot: () => mediaList?.matches ?? false,
    // The server cannot know the viewport, so render the "not matching" state
    // and let the client correct it after hydration.
    getServerSnapshot: () => false,
  };

  mediaQueryStores.set(query, store);
  return store;
}

/**
 * `window.matchMedia` as a reactive boolean.
 *
 * Built on `useSyncExternalStore` so there is no flash of wrong layout from an
 * effect that sets state after paint: React reads the current value during
 * render and on the server returns `false`, then re-queries on hydration.
 * `false` is the deliberate SSR default — the mobile-first base styles are the
 * correct thing to paint before the viewport is known.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => getMediaQueryStore(query).subscribe(onChange),
    [query],
  );
  const getSnapshot = useCallback(() => getMediaQueryStore(query).getSnapshot(), [query]);
  const getServerSnapshot = useCallback(
    () => getMediaQueryStore(query).getServerSnapshot(),
    [query],
  );

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export interface CountdownState {
  /** Whole seconds remaining, floored at 0. */
  secondsLeft: number;
  /** True once the target is reached or has passed. */
  expired: boolean;
}

const EXPIRED: CountdownState = { secondsLeft: 0, expired: true };

/**
 * Seconds until an offer's ISO deadline, ticking once per second.
 *
 * Offers expire on a hard clock the server enforces, so the UI must count down
 * to the same instant rather than trust whatever was rendered into the page
 * HTML (an offer opened in a background tab can be minutes stale). A `null`
 * target means "no deadline", which short-circuits to an expired state so
 * callers do not need a separate branch.
 */
export function useCountdown(targetIso: string | null): CountdownState {
  const targetMs = targetIso ? Date.parse(targetIso) : Number.NaN;

  const compute = useCallback((): CountdownState => {
    if (!Number.isFinite(targetMs)) return EXPIRED;
    const secondsLeft = Math.max(0, Math.ceil((targetMs - Date.now()) / 1000));
    return { secondsLeft, expired: secondsLeft <= 0 };
  }, [targetMs]);

  const [state, setState] = useState<CountdownState>(compute);

  // Recompute from scratch whenever the deadline changes, even between ticks.
  useEffect(() => {
    setState(compute());
  }, [compute]);

  useInterval(
    () => {
      setState((previous) => {
        const next = compute();
        // Avoid a render per second once the offer has already expired.
        return previous.expired && next.expired ? previous : next;
      });
    },
    Number.isFinite(targetMs) && state.expired ? null : 1000,
  );

  return state;
}

/**
 * True only after `active` has stayed true for `delayMs`.
 *
 * Used for copy like "still searching?" — flashing it instantly makes the app
 * feel broken on a fast connection, and showing it before a slow request even
 * finished is noise. Debouncing in a hook keeps that judgement in one place
 * instead of sprinkled through the screens.
 *
 * Going inactive flips the flag back immediately and cancels the pending
 * timer, so a stopped search cannot leave stale reassuring copy on screen.
 */
export function useDelayedFlag(active: boolean, delayMs: number): boolean {
  const [flag, setFlag] = useState(false);

  useEffect(() => {
    if (!active) {
      setFlag(false);
      return;
    }
    const id = window.setTimeout(() => setFlag(true), Math.max(0, delayMs));
    return () => window.clearTimeout(id);
  }, [active, delayMs]);

  return flag;
}

/**
 * `useState` backed by `localStorage`.
 *
 * Filter chips, last-used tab, and similar UI preferences should survive a
 * reload without becoming server state. The initial value is used for the
 * first render on both server and client — we only read the stored value in an
 * effect, after mount — so hydration output always matches and React does not
 * warn about a client/server mismatch.
 *
 * All storage access is wrapped: Safari private mode and quota limits throw on
 * `setItem`, and a malformed stored value should never take down a screen.
 */
export function useStickyState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(initial);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored !== null) setValue(parseJson<T>(stored));
    } catch {
      // Storage unavailable (private mode, blocked cookies): keep the default.
    }
  }, [key]);

  const setSticky = useCallback(
    (next: T) => {
      setValue(next);
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Ignore write failures; the in-memory value is still correct.
      }
    },
    [key],
  );

  return [value, setSticky];
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined as unknown as T;
  }
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from './auth-api';

/**
 * Web Push subscription for the browser.
 *
 * Push is the one thing a plain web page cannot do without help: the browser
 * needs a service worker and a VAPID public key from the server. If the
 * deployment has no VAPID keys configured the server reports `enabled: false`
 * and this hook stays inert, so nothing on screen promises a notification the
 * platform cannot deliver.
 */

export type PushState =
  | 'unsupported'
  | 'disabled'
  | 'default'
  | 'granted'
  | 'denied'
  | 'subscribing';

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalised);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function supported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function usePushNotifications() {
  const [state, setState] = useState<PushState>('default');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState<boolean | null>(null);

  // Ask the server whether push is configured, then mirror the browser's own
  // permission state so the UI never shows "Enable" when it is already on.
  useEffect(() => {
    if (!supported()) {
      setState('unsupported');
      return;
    }
    setState(Notification.permission as PushState);

    let alive = true;
    api
      .get<{ publicKey: string | null; enabled: boolean }>('/push/public-key')
      .then((res) => {
        if (!alive) return;
        setEnabled(res.data.enabled);
        if (!res.data.enabled) setState((prev) => (prev === 'unsupported' ? prev : 'disabled'));
      })
      .catch(() => alive && setEnabled(false));

    return () => {
      alive = false;
    };
  }, []);

  const subscribe = useCallback(async () => {
    if (!supported()) return;
    setBusy(true);
    setError(null);
    try {
      const keyRes = await api.get<{ publicKey: string | null; enabled: boolean }>('/push/public-key');
      if (!keyRes.data.enabled || !keyRes.data.publicKey) {
        setState('disabled');
        setError('PUSH_NOT_CONFIGURED');
        return;
      }

      const permission = await Notification.requestPermission();
      setState(permission as PushState);
      if (permission !== 'granted') return;

      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;

      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(keyRes.data.publicKey),
        }));

      // The API stores the whole subscription JSON as the device's push token,
      // which is why the devices column is a text field and not an opaque id.
      await api.post('/users/me/devices', {
        pushToken: JSON.stringify(subscription),
        platform: 'WEB',
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'PUSH_FAILED');
    } finally {
      setBusy(false);
    }
  }, []);

  const unsubscribe = useCallback(async () => {
    if (!supported()) return;
    setBusy(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration('/sw.js');
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await api.post('/users/me/devices/remove', { pushToken: JSON.stringify(subscription) }).catch(() => {
          /* the server row is deactivated on the next failed send too */
        });
        await subscription.unsubscribe();
      }
    } finally {
      setBusy(false);
    }
  }, []);

  return {
    state,
    busy,
    error,
    enabled,
    supported: supported(),
    subscribe,
    unsubscribe,
  };
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import {
  getPreferences, savePreferences, type NotificationPreferences,
} from '@/lib/notifications-api';
import { usePushNotifications } from '@/lib/push-notifications';

/**
 * Notification preferences.
 *
 * One row per event type, one column per channel. The backend owns the
 * defaults; this screen only edits them. Saving is explicit so a half-toggled
 * row never reaches the server.
 */
export default function NotificationPreferencesPage() {
  return (
    <RequireAuth>
      <Preferences />
    </RequireAuth>
  );
}

const CHANNELS = ['in_app', 'email', 'sms', 'push'] as const;

function Preferences() {
  const { t, locale } = useI18n();
  const [prefs, setPrefs] = useState<NotificationPreferences[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setPrefs(await getPreferences());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function toggle(eventType: string, channel: (typeof CHANNELS)[number]) {
    setSaved(false);
    setPrefs((prev) =>
      prev.map((p) => (p.event_type === eventType ? { ...p, [channel]: !p[channel] } : p)),
    );
  }

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      await savePreferences(prefs);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header>
        <Link href={`/${locale}/notifications`} className="text-sm opacity-60 hover:opacity-100">
          ← {t('notifications.title')}
        </Link>
        <h1 className="mt-1 text-2xl font-bold">{t('notifications.preferences')}</h1>
        <p className="mt-1 text-sm opacity-70">{t('notifications.preferencesHint')}</p>
      </header>

      {error && (
        <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}{' '}
          <button onClick={load} className="underline">{t('common.retry')}</button>
        </p>
      )}
      {saved && (
        <p className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {t('common.save')} ✓
        </p>
      )}

      <PushToggle />

      {loading ? (
        <p className="mt-6 opacity-60">{t('common.loading')}</p>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-black/10 text-start dark:border-white/10">
                <th className="py-2 text-start font-medium opacity-70">{t('notifications.title')}</th>
                {CHANNELS.map((c) => (
                  <th key={c} className="px-2 py-2 text-center font-medium opacity-70">
                    {t(`notifications.${c === 'in_app' ? 'inApp' : c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {prefs.map((p) => (
                <tr key={p.event_type} className="border-b border-black/5 dark:border-white/5">
                  <td className="py-2.5 pe-2">
                    {t(`notifications.eventTypes.${p.event_type}`) !== `notifications.eventTypes.${p.event_type}`
                      ? t(`notifications.eventTypes.${p.event_type}`)
                      : p.event_type}
                  </td>
                  {CHANNELS.map((c) => (
                    <td key={c} className="px-2 py-2.5 text-center">
                      <input
                        type="checkbox"
                        checked={Boolean(p[c])}
                        onChange={() => toggle(p.event_type, c)}
                        className="h-4 w-4 align-middle"
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <button
            onClick={onSave}
            disabled={saving}
            className="mt-5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
          >
            {t('common.save')}
          </button>
        </div>
      )}
    </main>
  );
}

/**
 * The browser-level push switch.
 *
 * Separate from the preference table on purpose: the table says *which events*
 * may notify, this says whether this device can receive notifications at all.
 * Both must be on for a phone to buzz, and conflating them is how users end up
 * with a "Push: on" row that never fires.
 */
function PushToggle() {
  const { t } = useI18n();
  const { state, busy, error, supported, subscribe, unsubscribe } = usePushNotifications();

  if (!supported || state === 'disabled') {
    return (
      <div className="mt-5 rounded-2xl border border-black/10 p-4 text-sm dark:border-white/15">
        <p className="font-medium">{t('push.deviceTitle')}</p>
        <p className="mt-1 text-xs opacity-60">
          {state === 'disabled' ? t('push.notConfigured') : t('push.unsupported')}
        </p>
      </div>
    );
  }

  const on = state === 'granted';
  return (
    <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-black/10 p-4 dark:border-white/15">
      <div>
        <p className="text-sm font-medium">{t('push.deviceTitle')}</p>
        <p className="mt-0.5 text-xs opacity-60">
          {state === 'denied' ? t('push.denied') : t('push.deviceHint')}
        </p>
        {error && <p className="mt-1 text-xs text-amber-600">{t('push.failed')}</p>}
      </div>
      <button
        type="button"
        onClick={() => void (on ? unsubscribe() : subscribe())}
        disabled={busy || state === 'denied'}
        className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50 ${
          on
            ? 'border border-black/15 dark:border-white/20'
            : 'bg-slate-900 text-white dark:bg-white dark:text-slate-900'
        }`}
      >
        {busy ? t('common.loading') : on ? t('push.turnOff') : t('push.turnOn')}
      </button>
    </div>
  );
}

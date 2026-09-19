'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import {
  getPreferences, savePreferences, type NotificationPreferences,
} from '@/lib/notifications-api';

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

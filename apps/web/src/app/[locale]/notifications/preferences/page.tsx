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
import { CategoryIcon } from '@/lib/icons';
import { SectionTitle, Spinner } from '@/lib/ui';

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
    <div className="app-shell container-page py-5">
      <header>
        <Link
          href={`/${locale}/notifications`}
          className="btn btn-ghost mb-2 -ms-2 !px-2"
        >
          <CategoryIcon name="arrow" size={16} className="rtl:rotate-180" />
          {t('notifications.title')}
        </Link>
        <h1 className="text-2xl font-extrabold tracking-tight">{t('notifications.preferences')}</h1>
        <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('notifications.preferencesHint')}</p>
      </header>

      {error && (
        <div className="card mt-4 flex items-center gap-2 border-[rgb(var(--danger)/0.35)] p-3 text-sm text-[rgb(var(--danger))]">
          <CategoryIcon name="shield" size={16} />
          <span className="flex-1">{error}</span>
          <button onClick={load} className="font-semibold underline">{t('common.retry')}</button>
        </div>
      )}
      {saved && (
        <div className="card mt-4 flex items-center gap-2 border-[rgb(var(--ok)/0.35)] p-3 text-sm text-[rgb(var(--ok))]">
          <CategoryIcon name="check" size={16} />
          {t('common.save')}
        </div>
      )}

      <PushToggle />

      {loading ? (
        <div className="card mt-5 flex items-center justify-center gap-2 px-5 py-10 text-sm text-[rgb(var(--fg-muted))]">
          <Spinner size={18} />
          {t('common.loading')}
        </div>
      ) : (
        <div className="card mt-5 overflow-x-auto p-4">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[rgb(var(--line))]">
                <th className="py-2.5 text-start font-semibold text-[rgb(var(--fg-muted))]">{t('notifications.title')}</th>
                {CHANNELS.map((c) => (
                  <th key={c} className="px-2 py-2.5 text-center font-semibold text-[rgb(var(--fg-muted))]">
                    {t(`notifications.${c === 'in_app' ? 'inApp' : c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {prefs.map((p) => (
                <tr key={p.event_type} className="border-b border-[rgb(var(--line))]">
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
                        className="h-4 w-4 align-middle accent-[rgb(var(--brand-500))]"
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
            className="btn btn-primary btn-block mt-5"
          >
            {saving ? <Spinner size={18} /> : <CategoryIcon name="check" size={18} />}
            {t('common.save')}
          </button>
        </div>
      )}
    </div>
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
      <div className="card mt-5 p-4 text-sm">
        <p className="font-bold">{t('push.deviceTitle')}</p>
        <p className="mt-1 text-xs text-[rgb(var(--fg-subtle))]">
          {state === 'disabled' ? t('push.notConfigured') : t('push.unsupported')}
        </p>
      </div>
    );
  }

  const on = state === 'granted';
  return (
    <div className="card mt-5 flex flex-wrap items-center justify-between gap-3 p-4">
      <div>
        <p className="text-sm font-bold">{t('push.deviceTitle')}</p>
        <p className="mt-0.5 text-xs text-[rgb(var(--fg-subtle))]">
          {state === 'denied' ? t('push.denied') : t('push.deviceHint')}
        </p>
        {error && <p className="mt-1 text-xs text-[rgb(var(--warn))]">{t('push.failed')}</p>}
      </div>
      <button
        type="button"
        onClick={() => void (on ? unsubscribe() : subscribe())}
        disabled={busy || state === 'denied'}
        className={`btn ${on ? 'btn-secondary' : 'btn-primary'}`}
      >
        {busy ? <Spinner size={18} /> : <CategoryIcon name="bell" size={18} />}
        {busy ? t('common.loading') : on ? t('push.turnOff') : t('push.turnOn')}
      </button>
    </div>
  );
}

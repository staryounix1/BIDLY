'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import {
  listNotifications, markAllRead, markRead, notificationHref, notificationText,
  type AppNotification,
} from '@/lib/notifications-api';
import { useRealtime } from '@/lib/realtime-client';

/**
 * Notification centre.
 *
 * Lists the user's notifications newest-first, with an unread filter and a
 * mark-all action. A `notification:new` event prepends the row live, so the
 * page never needs a manual refresh. Preferences live on their own screen.
 */
export default function NotificationsPage() {
  return (
    <RequireAuth>
      <Centre />
    </RequireAuth>
  );
}

function Centre() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [items, setItems] = useState<AppNotification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listNotifications(filter === 'unread'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('notifications.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [filter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const onNotification = useCallback(() => {
    void load();
  }, [load]);
  useRealtime({}, { onNotification });

  async function onOpen(n: AppNotification) {
    if (!n.is_read) {
      try {
        await markRead(n.id);
        setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
      } catch {
        /* navigation is the priority */
      }
    }
    const href = notificationHref(n, locale);
    if (href) {
      if (n.reference_type === 'JOB_STATUS_CHANGED' && n.reference_id) {
        router.push(`/${locale}/provider/jobs/${n.reference_id}`);
      } else {
        router.push(href);
      }
    }
  }

  async function onMarkAll() {
    setBusy(true);
    try {
      await markAllRead();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  const unread = items.filter((n) => !n.is_read).length;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('notifications.title')}</h1>
          <p className="mt-1 text-sm opacity-70">{t('notifications.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/${locale}/notifications/preferences`}
            className="rounded-lg border border-black/15 px-3 py-1.5 text-sm dark:border-white/20"
          >
            {t('notifications.preferences')}
          </Link>
          <button
            onClick={onMarkAll}
            disabled={busy || unread === 0}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
          >
            {t('notifications.markAllRead')}
          </button>
        </div>
      </header>

      <div className="mt-5 flex gap-2 text-sm">
        {(['all', 'unread'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={
              filter === f
                ? 'rounded-full bg-slate-900 px-3 py-1 font-medium text-white dark:bg-white dark:text-slate-900'
                : 'rounded-full border border-black/15 px-3 py-1 dark:border-white/20'
            }
          >
            {f === 'all' ? t('notifications.all') : `${t('notifications.unreadOnly')}${unread ? ` (${unread})` : ''}`}
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}{' '}
          <button onClick={load} className="underline">{t('common.retry')}</button>
        </p>
      )}

      {loading ? (
        <p className="mt-6 opacity-60">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-black/15 p-10 text-center dark:border-white/15">
          <p className="opacity-70">{t('notifications.empty')}</p>
          <p className="mt-1 text-sm opacity-60">{t('notifications.emptyHint')}</p>
        </div>
      ) : (
        <ul className="mt-6 space-y-2">
          {items.map((n) => {
            const { title, body } = notificationText(n, locale);
            return (
              <li key={n.id}>
                <button
                  onClick={() => void onOpen(n)}
                  className={
                    'w-full rounded-xl border p-4 text-start transition-colors ' +
                    (n.is_read
                      ? 'border-black/10 opacity-70 dark:border-white/10'
                      : 'border-slate-400/60 bg-slate-50 dark:border-slate-500/50 dark:bg-slate-800/40')
                  }
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium">{title}</span>
                    {!n.is_read && (
                      <span className="shrink-0 rounded-full bg-rose-600 px-2 py-0.5 text-[10px] font-bold text-white">
                        {t('notifications.new')}
                      </span>
                    )}
                  </div>
                  {body && <p className="mt-1 text-sm opacity-70">{body}</p>}
                  <p className="mt-1 text-xs opacity-50">
                    {new Date(n.created_at).toLocaleString(locale)}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

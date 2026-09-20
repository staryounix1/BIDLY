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
import { CategoryIcon } from '@/lib/icons';
import { EmptyState, Spinner } from '@/lib/ui';

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
    <div className="app-shell container-page py-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{t('notifications.title')}</h1>
          <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('notifications.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/${locale}/notifications/preferences`} className="btn btn-secondary !py-2 !text-sm">
            <CategoryIcon name="bell" size={15} />
            {t('notifications.preferences')}
          </Link>
          <button
            onClick={onMarkAll}
            disabled={busy || unread === 0}
            className="btn btn-secondary !py-2 !text-sm"
          >
            <CategoryIcon name="check" size={15} />
            {t('notifications.markAllRead')}
          </button>
        </div>
      </header>

      <div className="mt-5 flex gap-2 text-sm">
        {(['all', 'unread'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={filter === f ? 'chip chip-brand' : 'chip chip-neutral'}
          >
            {f === 'all' ? t('notifications.all') : `${t('notifications.unreadOnly')}${unread ? ` (${unread})` : ''}`}
          </button>
        ))}
      </div>

      {error && (
        <div className="card mt-4 flex items-center gap-2 border-[rgb(var(--danger)/0.35)] p-3 text-sm text-[rgb(var(--danger))]">
          <CategoryIcon name="shield" size={16} />
          <span className="flex-1">{error}</span>
          <button onClick={load} className="font-semibold underline">{t('common.retry')}</button>
        </div>
      )}

      {loading ? (
        <div className="card mt-5 flex items-center justify-center gap-2 px-5 py-10 text-sm text-[rgb(var(--fg-muted))]">
          <Spinner size={18} />
          {t('common.loading')}
        </div>
      ) : items.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            title={t('notifications.empty')}
            hint={t('notifications.emptyHint')}
            icon={<CategoryIcon name="bell" size={26} />}
          />
        </div>
      ) : (
        <ul className="mt-5 space-y-2">
          {items.map((n, i) => {
            const { title, body } = notificationText(n, locale);
            return (
              <li key={n.id} className="slide-in" style={{ animationDelay: `${i * 35}ms` }}>
                <button
                  onClick={() => void onOpen(n)}
                  className={
                    'card card-tap w-full p-4 text-start ' +
                    (n.is_read
                      ? 'opacity-70'
                      : 'border-[rgb(var(--brand-500)/0.45)] bg-[rgb(var(--brand-500)/0.07)]')
                  }
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-bold">{title}</span>
                    {!n.is_read && (
                      <span className="chip chip-brand shrink-0">
                        <span className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--brand-600))]" />
                        {t('notifications.new')}
                      </span>
                    )}
                  </div>
                  {body && <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{body}</p>}
                  <p className="tnum mt-1 text-xs text-[rgb(var(--fg-subtle))]">
                    {new Date(n.created_at).toLocaleString(locale)}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

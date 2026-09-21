'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useI18n } from './i18n-provider';
import { useAuth } from './auth-provider';
import { useRealtime, fetchUnreadCount } from './realtime-client';
import { CategoryIcon } from './icons';
import { useEffect } from 'react';

/**
 * Header bell showing the live count of unread notifications.
 *
 * The number comes from the REST endpoint on mount and is incremented by the
 * realtime stream, so the badge stays correct without polling. Used in the
 * shared header for signed-in users only.
 */
export function NotificationBell() {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const [count, setCount] = useState(0);

  const refresh = useCallback(() => {
    // Re-read the count rather than incrementing a local one: the server owns
    // the number, and an approval or a read elsewhere must not drift it.
    fetchUnreadCount()
      .then(setCount)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!user) return;
    refresh();
  }, [user, refresh]);

  useRealtime({}, { onNotification: refresh });

  if (!user) return null;

  return (
    <Link
      href={`/${locale}/notifications`}
      className="btn btn-secondary relative h-10 w-10 !p-0"
      aria-label={t('notifications.title')}
    >
      <CategoryIcon name="bell" size={18} />
      {count > 0 && (
        <span className="absolute -end-1 -top-1 min-w-4 rounded-full bg-[rgb(var(--danger))] px-1 text-center text-[10px] font-bold leading-4 text-white">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}

'use client';

import Link from 'next/link';
import { useCallback, useState } from 'react';
import { useI18n } from './i18n-provider';
import { useAuth } from './auth-provider';
import { useRealtime, fetchUnreadCount } from './realtime-client';
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

  useEffect(() => {
    let active = true;
    if (!user) return;
    fetchUnreadCount()
      .then((n) => { if (active) setCount(n); })
      .catch(() => {});
    return () => { active = false; };
  }, [user]);

  const onNotification = useCallback(() => setCount((c) => c + 1), []);
  useRealtime({}, { onNotification });

  if (!user) return null;

  return (
    <Link
      href={`/${locale}/notifications`}
      className="relative opacity-70 hover:opacity-100"
      aria-label={t('notifications.title')}
    >
      <span aria-hidden>🔔</span>
      {count > 0 && (
        <span className="absolute -right-2 -top-2 min-w-4 rounded-full bg-rose-600 px-1 text-center text-[10px] font-bold leading-4 text-white">
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  );
}

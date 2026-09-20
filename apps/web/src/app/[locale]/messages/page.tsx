'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { listConversations, markConversationRead, type Conversation } from '@/lib/chat-api';
import { CategoryIcon } from '@/lib/icons';
import { Avatar, EmptyState, Spinner } from '@/lib/ui';

/**
 * Messages inbox.
 *
 * One row per counterpart, ordered by the most recent message, with an unread
 * badge. Opening a row marks it read and goes to the thread.
 */
export default function MessagesPage() {
  return (
    <RequireAuth>
      <Inbox />
    </RequireAuth>
  );
}

function Inbox() {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listConversations());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('chat.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function open(c: Conversation) {
    if (c.unread_count > 0) {
      try {
        await markConversationRead(c.id);
      } catch {
        /* the thread view clears it too */
      }
    }
  }

  return (
    <div className="app-shell container-page py-5">
      <header>
        <h1 className="text-2xl font-extrabold tracking-tight">{t('chat.title')}</h1>
        <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('chat.subtitle')}</p>
      </header>

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
            title={t('chat.empty')}
            hint={t('chat.emptyHint')}
            icon={<CategoryIcon name="chat" size={26} />}
          />
        </div>
      ) : (
        <ul className="card mt-5 divide-y divide-[rgb(var(--line))] overflow-hidden">
          {items.map((c, i) => (
            <li key={c.id} className="slide-in" style={{ animationDelay: `${i * 35}ms` }}>
              <Link
                href={`/${locale}/messages/${c.id}`}
                onClick={() => void open(c)}
                className="flex items-center gap-3 p-4 transition-colors hover:bg-[rgb(var(--surface-3))]"
              >
                <Avatar name={c.counterpart_name} size={44} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-bold">{c.counterpart_name ?? c.counterpart_id.slice(0, 8)}</span>
                    {c.last_message_at && (
                      <span className="tnum shrink-0 text-xs text-[rgb(var(--fg-subtle))]">
                        {new Date(c.last_message_at).toLocaleDateString(locale)}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-sm text-[rgb(var(--fg-muted))]">
                    {c.last_message_preview ?? t('chat.noMessages')}
                  </span>
                </span>
                {c.unread_count > 0 && (
                  <span className="tnum shrink-0 rounded-full bg-[rgb(var(--brand-500))] px-2 py-0.5 text-xs font-bold text-[rgb(var(--brand-ink))]">
                    {c.unread_count}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

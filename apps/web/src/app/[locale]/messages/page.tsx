'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { listConversations, markConversationRead, type Conversation } from '@/lib/chat-api';

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
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header>
        <h1 className="text-2xl font-bold">{t('chat.title')}</h1>
        <p className="mt-1 text-sm opacity-70">{t('chat.subtitle')}</p>
      </header>

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
          <p className="opacity-70">{t('chat.empty')}</p>
          <p className="mt-1 text-sm opacity-60">{t('chat.emptyHint')}</p>
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-black/10 rounded-2xl border border-black/10 dark:divide-white/10 dark:border-white/15">
          {items.map((c) => (
            <li key={c.id}>
              <Link
                href={`/${locale}/messages/${c.id}`}
                onClick={() => void open(c)}
                className="flex items-center gap-3 p-4 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-200 font-semibold dark:bg-slate-700">
                  {(c.counterpart_name ?? '?').slice(0, 1).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">{c.counterpart_name ?? c.counterpart_id.slice(0, 8)}</span>
                    {c.last_message_at && (
                      <span className="shrink-0 text-xs opacity-50">
                        {new Date(c.last_message_at).toLocaleDateString(locale)}
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block truncate text-sm opacity-60">
                    {c.last_message_preview ?? t('chat.noMessages')}
                  </span>
                </span>
                {c.unread_count > 0 && (
                  <span className="shrink-0 rounded-full bg-rose-600 px-2 py-0.5 text-xs font-bold text-white">
                    {c.unread_count}
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

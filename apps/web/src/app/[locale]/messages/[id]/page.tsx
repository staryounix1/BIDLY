'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { useAuth } from '@/lib/auth-provider';
import { ApiError } from '@/lib/auth-api';
import {
  listConversations, listMessages, markConversationRead, newClientId, sendMessage,
  type ChatMessage, type Conversation,
} from '@/lib/chat-api';
import { useRealtime } from '@/lib/realtime-client';

/**
 * Conversation thread.
 *
 * Loads the history, then keeps it live: a `message:new` event for this
 * conversation appends the bubble immediately, and messages this user sends
 * appear optimistically before the server round-trip. Unread is cleared on
 * open and whenever an inbound message arrives while the thread is visible.
 */
export default function ThreadPage() {
  return (
    <RequireAuth>
      <Thread />
    </RequireAuth>
  );
}

function Thread() {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const conversationId = params.id;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pending, setPending] = useState<Array<{ clientId: string; body: string }>>([]);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [msgs, convos] = await Promise.all([listMessages(conversationId), listConversations()]);
      setMessages(msgs);
      setConversation(convos.find((c) => c.id === conversationId) ?? null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        router.replace(`/${locale}/messages`);
        return;
      }
      setError(err instanceof ApiError ? err.message : t('chat.errorLoad'));
    } finally {
      setLoading(false);
    }
  }, [conversationId, locale, router, t]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    markConversationRead(conversationId).catch(() => {});
  }, [conversationId]);

  const onMessage = useCallback(
    (data: Record<string, unknown>) => {
      if (data.conversationId !== conversationId) return;
      const id = (data.messageId ?? data.id) as string | undefined;
      if (!id) return;
      const senderId = (data.sender_id ?? data.senderId) as string | undefined;
      const incoming = { ...data, id, sender_id: senderId } as unknown as ChatMessage;
      setMessages((prev) => (prev.some((m) => m.id === id) ? prev : [...prev, incoming]));
      if (senderId !== user?.id) markConversationRead(conversationId).catch(() => {});
    },
    [conversationId, user?.id],
  );

  const { connected } = useRealtime({ conversationId }, { onMessage });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, pending.length]);

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    const body = draft.trim();
    if (!body || sending) return;
    const clientId = newClientId();
    setDraft('');
    setPending((p) => [...p, { clientId, body }]);
    setSending(true);
    try {
      const saved = await sendMessage(conversationId, body, clientId);
      setMessages((prev) => (prev.some((m) => m.id === saved.id) ? prev : [...prev, saved]));
      setPending((p) => p.filter((x) => x.clientId !== clientId));
    } catch (err) {
      setPending((p) => p.filter((x) => x.clientId !== clientId));
      setError(err instanceof ApiError ? err.message : t('chat.errorSend'));
      setDraft(body);
    } finally {
      setSending(false);
    }
  }

  const grouped = useMemo(() => messages, [messages]);

  return (
    <main className="mx-auto flex h-[calc(100dvh-57px)] max-w-3xl flex-col px-4">
      <header className="flex items-center justify-between gap-3 border-b border-black/10 py-3 dark:border-white/10">
        <div className="min-w-0">
          <button onClick={() => router.push(`/${locale}/messages`)} className="text-sm opacity-60 hover:opacity-100">
            ← {t('chat.conversations')}
          </button>
          <h1 className="truncate font-semibold">
            {conversation?.counterpart_name ?? t('chat.conversation')}
          </h1>
        </div>
        <span className="shrink-0 text-xs opacity-60">
          <span className={connected ? 'text-emerald-600' : 'text-amber-600'}>●</span>{' '}
          {connected ? t('chat.connected') : t('chat.reconnecting')}
        </span>
      </header>

      {error && (
        <p className="my-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}{' '}
          <button onClick={load} className="underline">{t('common.retry')}</button>
        </p>
      )}

      <div className="flex-1 overflow-y-auto py-4">
        {loading ? (
          <p className="text-center opacity-60">{t('common.loading')}</p>
        ) : grouped.length === 0 && pending.length === 0 ? (
          <div className="mt-10 text-center opacity-70">
            <p>{t('chat.noMessages')}</p>
            <p className="mt-1 text-sm opacity-60">{t('chat.noMessagesHint')}</p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {grouped.map((m) => (
              <Bubble key={m.id} message={m} mine={m.sender_id === user?.id} locale={locale} t={t} />
            ))}
            {pending.map((p) => (
              <li key={p.clientId} className="flex justify-end">
                <span className="max-w-[75%] rounded-2xl rounded-br-sm bg-slate-900/70 px-3.5 py-2 text-sm text-white">
                  {p.body}
                  <span className="ms-2 text-[10px] opacity-70">{t('chat.sending')}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={onSend} className="flex items-end gap-2 border-t border-black/10 py-3 dark:border-white/10">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void onSend(e);
            }
          }}
          rows={1}
          placeholder={t('chat.placeholder')}
          className="max-h-32 flex-1 resize-none rounded-xl border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-slate-500 dark:border-white/20"
        />
        <button
          type="submit"
          disabled={sending || draft.trim().length === 0}
          className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40 dark:bg-white dark:text-slate-900"
        >
          {t('chat.send')}
        </button>
      </form>
    </main>
  );
}

function Bubble({
  message, mine, locale, t,
}: {
  message: ChatMessage;
  mine: boolean;
  locale: string;
  t: (key: string) => string;
}) {
  return (
    <li className={mine ? 'flex justify-end' : 'flex justify-start'}>
      <span
        className={
          mine
            ? 'max-w-[75%] rounded-2xl rounded-br-sm bg-slate-900 px-3.5 py-2 text-sm text-white'
            : 'max-w-[75%] rounded-2xl rounded-bl-sm bg-black/[0.06] px-3.5 py-2 text-sm dark:bg-white/10'
        }
      >
          {message.body ?? `[${message.kind}]`}
        <span className={`ms-2 text-[10px] ${mine ? 'opacity-60' : 'opacity-50'}`}>
          {new Date(message.created_at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
          {mine ? ` · ${message.read_at ? t('chat.read') : t('chat.delivered')}` : ''}
        </span>
      </span>
    </li>
  );
}

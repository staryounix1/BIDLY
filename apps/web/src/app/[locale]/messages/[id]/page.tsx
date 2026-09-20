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
import { CategoryIcon } from '@/lib/icons';
import { Avatar, Spinner } from '@/lib/ui';

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
    <div className="app-shell flex h-[calc(100dvh-57px)] flex-col px-4">
      <header className="flex items-center justify-between gap-3 border-b border-[rgb(var(--line))] py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            onClick={() => router.push(`/${locale}/messages`)}
            aria-label={t('chat.conversations')}
            className="btn btn-ghost !p-2"
          >
            <CategoryIcon name="arrow" size={18} className="rtl:rotate-180" />
          </button>
          <Avatar name={conversation?.counterpart_name} size={36} />
          <div className="min-w-0">
            <h1 className="truncate font-bold">
              {conversation?.counterpart_name ?? t('chat.conversation')}
            </h1>
            <span className="flex items-center gap-1 text-xs text-[rgb(var(--fg-subtle))]">
              <span className={connected ? 'text-[rgb(var(--ok))]' : 'text-[rgb(var(--warn))]'}>●</span>
              {connected ? t('chat.connected') : t('chat.reconnecting')}
            </span>
          </div>
        </div>
      </header>

      {error && (
        <div className="card my-2 flex items-center gap-2 border-[rgb(var(--danger)/0.35)] p-3 text-sm text-[rgb(var(--danger))]">
          <CategoryIcon name="shield" size={16} />
          <span className="flex-1">{error}</span>
          <button onClick={load} className="font-semibold underline">{t('common.retry')}</button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto py-4">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-[rgb(var(--fg-muted))]">
            <Spinner size={18} />
            {t('common.loading')}
          </div>
        ) : grouped.length === 0 && pending.length === 0 ? (
          <div className="mt-10 text-center text-[rgb(var(--fg-muted))]">
            <p className="font-bold">{t('chat.noMessages')}</p>
            <p className="mt-1 text-sm text-[rgb(var(--fg-subtle))]">{t('chat.noMessagesHint')}</p>
          </div>
        ) : (
          <ul className="space-y-1.5">
            {grouped.map((m) => (
              <Bubble key={m.id} message={m} mine={m.sender_id === user?.id} locale={locale} t={t} />
            ))}
            {pending.map((p) => (
              <li key={p.clientId} className="flex justify-end">
                <span className="max-w-[75%] rounded-2xl rounded-ee-sm bg-[rgb(var(--brand-500))] px-3.5 py-2 text-sm text-[rgb(var(--brand-ink))] opacity-70">
                  {p.body}
                  <span className="ms-2 text-[10px] opacity-70">{t('chat.sending')}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={onSend} className="flex items-end gap-2 border-t border-[rgb(var(--line))] py-3">
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
          className="input max-h-32 flex-1 resize-none"
        />
        <button
          type="submit"
          disabled={sending || draft.trim().length === 0}
          aria-label={t('chat.send')}
          className="btn btn-primary !p-3.5"
        >
          {sending ? <Spinner size={18} /> : <CategoryIcon name="arrow" size={18} className="rtl:rotate-180" />}
        </button>
      </form>
    </div>
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
            ? 'max-w-[75%] rounded-2xl rounded-ee-sm bg-[rgb(var(--brand-500))] px-3.5 py-2 text-sm font-medium text-[rgb(var(--brand-ink))]'
            : 'max-w-[75%] rounded-2xl rounded-es-sm bg-[rgb(var(--surface-3))] px-3.5 py-2 text-sm'
        }
      >
          {message.body ?? `[${message.kind}]`}
        <span className={`ms-2 text-[10px] ${mine ? 'opacity-70' : 'text-[rgb(var(--fg-subtle))]'}`}>
          {new Date(message.created_at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
          {mine ? ` · ${message.read_at ? t('chat.read') : t('chat.delivered')}` : ''}
        </span>
      </span>
    </li>
  );
}

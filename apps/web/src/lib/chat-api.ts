import { api } from './auth-api';

/**
 * Chat API — conversations and messages between a customer and a provider.
 *
 * A conversation is created from the request/job context with a counterpart,
 * then both sides read and post messages. Sending carries a client id so a
 * retry after a flaky connection is idempotent, and reading is a separate call
 * that clears the unread badge.
 */

export interface Conversation {
  id: string;
  participant_a: string;
  participant_b: string;
  counterpart_id: string;
  counterpart_name: string | null;
  last_message_at: string | null;
  last_message_preview: string | null;
  unread_count: number;
  status: string;
  created_at: string;
}

export type MessageKind = 'TEXT' | 'IMAGE' | 'FILE' | 'LOCATION' | 'OFFER_REFERENCE';

export interface ChatMessage {
  id: string;
  conversation_id: string;
  sender_id: string;
  kind: MessageKind;
  body: string | null;
  attachment_url: string | null;
  lat: number | null;
  lng: number | null;
  read_at: string | null;
  created_at: string;
}

export interface ConversationPage {
  items: Conversation[];
  meta?: { total?: number; unread?: number };
}

export async function listConversations(): Promise<Conversation[]> {
  const res = await api.get<Conversation[]>('/conversations?limit=100');
  return res.data;
}

export async function openConversation(counterpartId: string): Promise<Conversation> {
  const res = await api.post<Conversation>('/conversations', { counterpartId });
  return res.data;
}

export async function listMessages(conversationId: string): Promise<ChatMessage[]> {
  const res = await api.get<{ messages: ChatMessage[] }>(`/conversations/${conversationId}/messages?limit=100`);
  return res.data.messages;
}

export async function sendMessage(
  conversationId: string,
  body: string,
  clientId: string,
  kind: MessageKind = 'TEXT',
): Promise<ChatMessage> {
  const res = await api.post<ChatMessage>(`/conversations/${conversationId}/messages`, { body, clientId, kind });
  return res.data;
}

export async function markConversationRead(conversationId: string): Promise<void> {
  await api.post(`/conversations/${conversationId}/read`, {});
}

export function newClientId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

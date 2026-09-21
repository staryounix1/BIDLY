import { api } from './auth-api';

/**
 * Notifications API — the in-app notification centre.
 *
 * Notifications are produced by the backend outbox from the same domain events
 * that drive realtime, so the list, the unread badge and the SSE push all
 * agree. Text arrives pre-localised (ar/fr/en) alongside the event data.
 */

export interface AppNotification {
  id: string;
  type: string;
  title_en: string;
  title_fr: string;
  title_ar: string;
  body_en: string | null;
  body_fr: string | null;
  body_ar: string | null;
  data: Record<string, unknown> | null;
  channel: string;
  is_read: boolean;
  read_at: string | null;
  reference_type: string | null;
  reference_id: string | null;
  created_at: string;
}

export interface NotificationPreferences {
  event_type: string;
  in_app: boolean;
  email: boolean;
  sms: boolean;
  push: boolean;
}

export async function listNotifications(unreadOnly = false): Promise<AppNotification[]> {
  const res = await api.get<AppNotification[]>(`/notifications?limit=100${unreadOnly ? '&unreadOnly=true' : ''}`);
  return res.data;
}

export async function unreadCount(): Promise<number> {
  const res = await api.get<{ unread: number }>('/notifications/unread-count');
  return res.data.unread;
}

export async function markRead(id: string): Promise<void> {
  await api.post(`/notifications/${id}/read`, {});
}

export async function markAllRead(): Promise<void> {
  await api.post('/notifications/read-all', {});
}

export async function getPreferences(): Promise<NotificationPreferences[]> {
  const res = await api.get<NotificationPreferences[]>('/notifications/preferences');
  return res.data;
}

/**
 * Preferences are stored per event type with one boolean per channel, but the
 * API updates a single cell at a time. `savePreferences` diffs the edited rows
 * against the server copy and sends only the cells that actually changed.
 */
export async function savePreferences(next: NotificationPreferences[]): Promise<void> {
  const original = await getPreferences();
  const before = new Map(original.map((p) => [p.event_type, p]));
  const calls: Array<Promise<unknown>> = [];
  for (const row of next) {
    const prev = before.get(row.event_type);
    for (const [channel, column] of CHANNELS) {
      if (prev && Boolean(prev[column]) === Boolean(row[column])) continue;
      calls.push(api.put('/notifications/preferences', { channel, category: row.event_type, enabled: Boolean(row[column]) }));
    }
  }
  await Promise.all(calls);
}

export const CHANNELS: Array<[string, keyof NotificationPreferences]> = [
  ['IN_APP', 'in_app'],
  ['EMAIL', 'email'],
  ['SMS', 'sms'],
  ['PUSH', 'push'],
];

export function notificationText(n: AppNotification, locale: string): { title: string; body: string } {
  const key = locale === 'ar' ? 'ar' : locale === 'fr' ? 'fr' : 'en';
  const title = (n[`title_${key}`] as string) || n.title_en || n.type;
  const body = (n[`body_${key}`] as string) || n.body_en || '';
  return { title, body };
}

/** Where a notification should take the user when clicked. */
export function notificationHref(n: AppNotification, locale: string): string | null {
  const id = (n.reference_id as string) || (n.data?.aggregateId as string) || null;
  const kind = n.reference_type || n.type;
  switch (kind) {
    case 'REQUEST':
    case 'REQUEST_PUBLISHED':
    case 'REQUEST_STATUS_CHANGED':
    case 'OFFER_RECEIVED':
    case 'OFFER_ACCEPTED':
    case 'OFFER_REJECTED':
    case 'OFFER_WITHDRAWN':
      return id ? `/${locale}/requests/${id}` : null;
    case 'JOB':
    case 'JOB_STATUS_CHANGED':
      return id ? `/${locale}/jobs/${id}` : null;
    case 'MESSAGE':
    case 'MESSAGE_NEW': {
      const conversationId = n.data?.conversationId as string | undefined;
      return conversationId ? `/${locale}/messages/${conversationId}` : `/${locale}/messages`;
    }
    // Activation notifications exist to lift the gate. There is no page to
    // navigate to — the gate is everywhere — so the action is a reload, which
    // re-reads `/me` and lets the account into the product. Handled by the
    // notifications page rather than expressed as a route.
    case 'USER':
    case 'ACCOUNT_ACTIVATED':
    case 'IDENTITY_REJECTED':
      return null;
    default:
      return null;
  }
}

/** Notification types whose tap should reload the app rather than navigate. */
export function isActivationNotification(n: AppNotification): boolean {
  return n.type === 'ACCOUNT_ACTIVATED' || n.type === 'IDENTITY_REJECTED';
}

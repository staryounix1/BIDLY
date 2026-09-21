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

/** Translation key for a notification body, e.g. `notif.jobStatus.body`. */
const BODY_KEY: Record<string, string> = {
  REQUEST_PUBLISHED: 'notif.requestPublished.body',
  REQUEST_STATUS_CHANGED: 'notif.requestStatus.body',
  OFFER_RECEIVED: 'notif.offerReceived.body',
  OFFER_ACCEPTED: 'notif.offerAccepted.body',
  OFFER_REJECTED: 'notif.offerRejected.body',
  OFFER_WITHDRAWN: 'notif.offerWithdrawn.body',
  JOB_STATUS_CHANGED: 'notif.jobStatus.body',
  MESSAGE_NEW: 'notif.messageNew.body',
};

const TITLE_KEY: Record<string, string> = {
  REQUEST_PUBLISHED: 'notif.requestPublished.title',
  REQUEST_STATUS_CHANGED: 'notif.requestStatus.title',
  OFFER_RECEIVED: 'notif.offerReceived.title',
  OFFER_ACCEPTED: 'notif.offerAccepted.title',
  OFFER_REJECTED: 'notif.offerRejected.title',
  OFFER_WITHDRAWN: 'notif.offerWithdrawn.title',
  JOB_STATUS_CHANGED: 'notif.jobStatus.title',
  MESSAGE_NEW: 'notif.messageNew.title',
};

/** `JOB_STATUS_CHANGED (CONFIRMED)` and similar legacy rows. */
const LEGACY_KEY = /^(notif\.[a-zA-Z.]+)\s*(?:\(([A-Z_]+)\))?$/;

/**
 * `t` is passed in rather than imported so this stays a pure helper the tests
 * can drive; the notification centre already holds an i18n handle.
 */
export function notificationText(
  n: AppNotification,
  locale: string,
  t?: (key: string, vars?: Record<string, string | number>) => string,
): { title: string; body: string } {
  const key = locale === 'ar' ? 'ar' : locale === 'fr' ? 'fr' : 'en';
  const rawTitle = (n[`title_${key}`] as string) || n.title_en || '';
  const rawBody = (n[`body_${key}`] as string) || n.body_en || '';

  const status =
    (typeof n.data?.status === 'string' ? n.data.status : '') ||
    (rawBody.match(LEGACY_KEY)?.[2] ?? '');

  // Titles are usually a real value (job code, "Offer 220.00 MAD"); only fall
  // back to a translation when the backend stored a key.
  let title = rawTitle;
  const titleLegacy = rawTitle.match(LEGACY_KEY);
  if (t) {
    if (titleLegacy || !rawTitle) title = t(TITLE_KEY[n.type] ?? 'notifications.title', { status });
    else if (status) title = `${rawTitle} · ${t(`status.${status}`)}`;
  } else if (!rawTitle) {
    title = n.type;
  }

  let body = rawBody;
  if (t) {
    // A stored key (new or legacy) is not prose: rebuild the sentence locally.
    const isKey = LEGACY_KEY.test(rawBody);
    if (isKey || !rawBody) {
      const bodyKey = BODY_KEY[n.type];
      // Only primitives can be interpolated; drop ids/objects.
      const vars: Record<string, string | number> = { status, jobCode: rawTitle };
      for (const [k, v] of Object.entries(n.data ?? {})) {
        if (typeof v === 'string' || typeof v === 'number') vars[k] = v;
      }
      body = bodyKey ? t(bodyKey, vars) : '';
    }
  }
  return { title, body };
}

/** Where a notification should take the user when clicked. */
export function notificationHref(n: AppNotification, locale: string): string | null {
  // `reference_type` is the *aggregate* (OFFER / JOB / REQUEST / USER) while
  // `type` is the specific event. Route on the event: an `OFFER_ACCEPTED`
  // notification has `reference_type: 'OFFER'` and its `reference_id` is the
  // offer, so keying off the aggregate sent the customer to a 404.
  const kind = n.type || n.reference_type;
  const aggregateId = n.data?.aggregateId as string | undefined;
  const jobId = (n.data?.jobId as string | undefined) || null;
  const id = (n.reference_id as string) || aggregateId || null;
  switch (kind) {
    case 'REQUEST':
    case 'REQUEST_PUBLISHED':
    case 'REQUEST_STATUS_CHANGED':
    case 'REQUEST_CANCELLED':
    case 'OFFER_RECEIVED':
    case 'OFFER_WITHDRAWN':
      return id ? `/${locale}/requests/${id}` : null;
    // Accepting an offer confirms a job. `reference_id` here is the *offer*, so
    // prefer the job id from the payload; fall back to the request.
    case 'OFFER_ACCEPTED':
      if (jobId) return `/${locale}/jobs/${jobId}`;
      return id ? `/${locale}/requests/${id}` : null;
    // A declined offer leaves the request searching — there is no job yet, and
    // the customer belongs back on the request to watch for other offers.
    case 'OFFER_REJECTED': {
      const requestId = (n.data?.requestId as string | undefined) || null;
      return requestId ? `/${locale}/requests/${requestId}` : null;
    }
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

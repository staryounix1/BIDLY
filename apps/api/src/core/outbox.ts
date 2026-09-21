import type { PoolClient } from 'pg';
import { clientQuery, queryMany, queryOne, transaction } from '../db/pool.js';
import { createChildLogger } from './logger.js';
import { createNotificationAdapters } from './providers.js';
import { publishToUser, publish, requestRoom, jobRoom, conversationRoom, type RealtimeEvent } from './realtime.js';

const log = createChildLogger({ component: 'outbox' });

// One adapter set per process. `createPushProvider()` throws when
// PUSH_PROVIDER=webpush without VAPID keys, which is the failure a
// misconfigured deployment should see immediately at boot, not at send time.
const adapters = createNotificationAdapters();

/**
 * Transactional outbox (doc 13 §13.3).
 *
 * A domain action writes one row here inside its own transaction, so a side
 * effect can never be lost to a crash between "business row committed" and
 * "notification sent". The worker below drains it: it writes the in-app
 * notification row and fans the event out over realtime, then marks the event
 * processed.
 *
 * This module is the single producer of realtime events. Routes only record
 * what happened; they never talk to the hub or to the notifications table
 * directly, which keeps delivery rules in one place.
 */

export const OUTBOX_TOPICS = {
  REQUEST_PUBLISHED: 'request.published',
  REQUEST_STATUS_CHANGED: 'request.status_changed',
  REQUEST_CANCELLED: 'request.cancelled',
  OFFER_CREATED: 'offer.created',
  OFFER_ACCEPTED: 'offer.accepted',
  OFFER_REJECTED: 'offer.rejected',
  OFFER_WITHDRAWN: 'offer.withdrawn',
  JOB_STATUS_CHANGED: 'job.status_changed',
  MESSAGE_SENT: 'message.sent',
} as const;

export type OutboxTopic = (typeof OUTBOX_TOPICS)[keyof typeof OUTBOX_TOPICS];

export interface OutboxInput {
  topic: OutboxTopic;
  aggregateType: 'REQUEST' | 'OFFER' | 'JOB' | 'MESSAGE' | 'CONVERSATION';
  aggregateId: string;
  payload: Record<string, unknown>;
}

/**
 * Record an event. Pass the transaction client when inside a transaction so
 * the row commits with the change it describes; omit it for a standalone write.
 */
export async function enqueue(input: OutboxInput, client?: PoolClient): Promise<void> {
  const sql = `insert into outbox_events (topic, aggregate_type, aggregate_id, payload)
               values ($1,$2,$3,$4::jsonb)`;
  const params = [input.topic, input.aggregateType, input.aggregateId, JSON.stringify(input.payload)];
  if (client) {
    await clientQuery(client).query(sql, params);
  } else {
    await transaction(async (c) => {
      await clientQuery(c).query(sql, params);
    });
  }
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

export interface OutboxEventRow {
  id: string;
  topic: string;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/**
 * Every event becomes one or more (recipient, notification) pairs and zero or
 * more realtime publishes. Recipients are resolved from the payload's
 * `recipients` field — the route that recorded the event already knew who was
 * involved, and re-deriving it here would risk notifying the wrong user.
 */
export interface NotificationDraft {
  userId: string;
  type: string;
  titleKey: string;
  bodyKey: string;
  data: Record<string, unknown>;
  dedupeKey?: string;
}

interface Recipient {
  userId: string;
  /** Optional per-recipient role so the same event reads correctly for each side. */
  role?: 'CUSTOMER' | 'PROVIDER' | 'ADMIN';
}

function recipientsOf(payload: Record<string, unknown>): Recipient[] {
  const raw = payload.recipients;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const r of raw) {
    const userId = typeof r === 'string' ? r : (r as { userId?: string })?.userId;
    if (typeof userId !== 'string' || seen.has(userId)) continue;
    seen.add(userId);
    out.push({
      userId,
      role: (typeof r === 'object' && r ? (r as Recipient).role : undefined),
    });
  }
  return out;
}

const TITLES: Record<string, { type: string; title: string; body: string }> = {
  [OUTBOX_TOPICS.REQUEST_PUBLISHED]: {
    type: 'REQUEST_PUBLISHED',
    title: 'notif.requestPublished.title',
    body: 'notif.requestPublished.body',
  },
  [OUTBOX_TOPICS.REQUEST_STATUS_CHANGED]: {
    type: 'REQUEST_STATUS_CHANGED',
    title: 'notif.requestStatus.title',
    body: 'notif.requestStatus.body',
  },
  [OUTBOX_TOPICS.REQUEST_CANCELLED]: {
    type: 'REQUEST_CANCELLED',
    title: 'notif.requestCancelled.title',
    body: 'notif.requestCancelled.body',
  },
  [OUTBOX_TOPICS.OFFER_CREATED]: {
    type: 'OFFER_RECEIVED',
    title: 'notif.offerReceived.title',
    body: 'notif.offerReceived.body',
  },
  [OUTBOX_TOPICS.OFFER_ACCEPTED]: {
    type: 'OFFER_ACCEPTED',
    title: 'notif.offerAccepted.title',
    body: 'notif.offerAccepted.body',
  },
  [OUTBOX_TOPICS.OFFER_REJECTED]: {
    type: 'OFFER_REJECTED',
    title: 'notif.offerRejected.title',
    body: 'notif.offerRejected.body',
  },
  [OUTBOX_TOPICS.OFFER_WITHDRAWN]: {
    type: 'OFFER_WITHDRAWN',
    title: 'notif.offerWithdrawn.title',
    body: 'notif.offerWithdrawn.body',
  },
  [OUTBOX_TOPICS.JOB_STATUS_CHANGED]: {
    type: 'JOB_STATUS_CHANGED',
    title: 'notif.jobStatus.title',
    body: 'notif.jobStatus.body',
  },
  [OUTBOX_TOPICS.MESSAGE_SENT]: {
    type: 'MESSAGE_NEW',
    title: 'notif.messageNew.title',
    body: 'notif.messageNew.body',
  },
};

function draftFor(event: OutboxEventRow, recipient: Recipient): NotificationDraft | null {
  const template = TITLES[event.topic];
  if (!template) return null;
  const status = typeof event.payload.status === 'string' ? event.payload.status : '';
  return {
    userId: recipient.userId,
    type: template.type,
    titleKey: template.title,
    bodyKey: template.body,
    data: {
      ...event.payload,
      topic: event.topic,
      aggregateType: event.aggregate_type,
      aggregateId: event.aggregate_id,
      locale: event.payload.locale ?? null,
    },
    dedupeKey: `${event.topic}:${event.aggregate_id}:${recipient.userId}:${status}`,
  };
}

/** Localised columns, so the notification centre renders without a second call. */
function localise(draft: NotificationDraft, payload: Record<string, unknown>) {
  const title = String(payload.title ?? payload.requestTitle ?? payload.jobCode ?? '');
  const body = String(payload.body ?? payload.preview ?? payload.message ?? '');
  const status = payload.status ? String(payload.status) : '';
  // The UI owns the wording: it has `notif.*` translations and knows the locale.
  // Never persist a translation key as if it were prose — store the event type
  // plus its status and let the notification centre render the sentence.
  const fallbackBody = status ? `${draft.type} (${status})` : draft.type;
  return {
    title_en: title || draft.titleKey,
    title_fr: title || draft.titleKey,
    title_ar: title || draft.titleKey,
    body_en: body || fallbackBody,
    body_fr: body || fallbackBody,
    body_ar: body || fallbackBody,
  };
}

/**
 * Map one outbox row to realtime publishes. Realtime is a projection of the
 * same event: the personal room always fires, plus the request/job/
 * conversation room so an open screen updates without a refetch.
 */
function realtimeFor(event: OutboxEventRow, payload: Record<string, unknown>): Array<{ room: string; event: RealtimeEvent }> {
  const out: Array<{ room: string; event: RealtimeEvent }> = [];
  const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
  const jobId = typeof payload.jobId === 'string' ? payload.jobId : null;
  const conversationId = typeof payload.conversationId === 'string' ? payload.conversationId : null;

  switch (event.topic) {
    case OUTBOX_TOPICS.OFFER_CREATED:
      if (requestId) out.push({ room: requestRoom(requestId), event: 'offer:created' });
      break;
    case OUTBOX_TOPICS.OFFER_ACCEPTED:
    case OUTBOX_TOPICS.OFFER_REJECTED:
    case OUTBOX_TOPICS.OFFER_WITHDRAWN:
      if (requestId) out.push({ room: requestRoom(requestId), event: 'offer:updated' });
      break;
    case OUTBOX_TOPICS.REQUEST_STATUS_CHANGED:
    case OUTBOX_TOPICS.REQUEST_CANCELLED:
      if (requestId) out.push({ room: requestRoom(requestId), event: 'request:updated' });
      break;
    case OUTBOX_TOPICS.REQUEST_PUBLISHED:
      if (requestId) out.push({ room: requestRoom(requestId), event: 'request:updated' });
      break;
    case OUTBOX_TOPICS.JOB_STATUS_CHANGED:
      if (jobId) out.push({ room: jobRoom(jobId), event: 'job:status' });
      break;
    case OUTBOX_TOPICS.MESSAGE_SENT:
      if (conversationId) out.push({ room: conversationRoom(conversationId), event: 'message:new' });
      break;
    default:
      break;
  }
  return out;
}

export interface DrainResult {
  processed: number;
  notifications: number;
  realtime: number;
  failed: number;
}

/**
 * Claim and process a batch of pending events.
 *
 * Claiming uses `for update skip locked` so two worker instances can run
 * safely, and each row is processed in its own transaction: one poison message
 * cannot roll back the batch. A row that exceeds `max_attempts` moves to DEAD
 * instead of retrying forever.
 */
export async function drainOutbox(batchSize = 25, workerId = 'worker-1'): Promise<DrainResult> {
  const result: DrainResult = { processed: 0, notifications: 0, realtime: 0, failed: 0 };

  const claimed = await transaction(async (client) => {
    const c = clientQuery(client);
    return c.many<OutboxEventRow>(
      `with claimed as (
         select id from outbox_events
         where status = 'PENDING' and available_at <= now()
         order by created_at
         limit $1
         for update skip locked
       )
       update outbox_events o
       set status = 'PROCESSING', locked_at = now(), locked_by = $2, attempts = o.attempts + 1
       from claimed
       where o.id = claimed.id
       returning o.id, o.topic, o.aggregate_type, o.aggregate_id, o.payload, o.attempts, o.max_attempts`,
      [batchSize, workerId],
    );
  });

  for (const event of claimed) {
    try {
      const recipients = recipientsOf(event.payload);
      let created = 0;
      let pushed = 0;

      for (const recipient of recipients) {
        const draft = draftFor(event, recipient);
        if (!draft) continue;
        const loc = localise(draft, event.payload);
        const inserted = await queryOne<{ id: string }>(
          `insert into notifications (user_id, type, title_en, title_fr, title_ar,
                                      body_en, body_fr, body_ar, data, channel, status,
                                      reference_type, reference_id, dedupe_key)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'IN_APP','SENT',$10,$11,$12)
           on conflict (user_id, dedupe_key) where dedupe_key is not null do nothing
           returning id`,
          [
            draft.userId, draft.type, loc.title_en, loc.title_fr, loc.title_ar,
            loc.body_en, loc.body_fr, loc.body_ar, JSON.stringify(draft.data),
            event.aggregate_type, event.aggregate_id, draft.dedupeKey,
          ],
        );
        if (!inserted) continue; // deduped: already delivered
        created++;
        pushed += publishToUser(draft.userId, 'notification:new', { id: inserted.id, ...draft.data });
        // Web Push is best-effort and must never fail the event: a phone that
        // is offline or has revoked permission is the normal case, not an error.
        await deliverPush(draft, loc).catch(() => undefined);
      }

      for (const { room, event: rtEvent } of realtimeFor(event, event.payload)) {
        pushed += publishToUserRoom(room, rtEvent, { ...event.payload, topic: event.topic });
      }

      await queryOne(
        `update outbox_events set status = 'PROCESSED', processed_at = now(), error = null where id = $1`,
        [event.id],
      );
      result.processed++;
      result.notifications += created;
      result.realtime += pushed;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const dead = event.attempts >= event.max_attempts;
      await queryOne(
        `update outbox_events
         set status = $2, error = $3, available_at = now() + interval '5 seconds'
         where id = $1`,
        [event.id, dead ? 'DEAD' : 'PENDING', message.slice(0, 500)],
      );
      result.failed++;
      log.warn({ outboxId: event.id, topic: event.topic, dead, err: message }, 'outbox.event_failed');
    }
  }

  return result;
}

/** Publish an already-computed event into a room (thin alias, keeps imports tidy). */
function publishToUserRoom(room: string, event: RealtimeEvent, data: unknown): number {
  // A room publish reaches every subscriber of that room, which is exactly the
  // set of users allowed to see the related entity — the SSE route only lets a
  // user join a room after verifying membership in the database.
  return publish(room, event, data);
}

/**
 * Send a Web Push to every active device the recipient has registered.
 *
 * A 404/410 from the push service means the browser dropped the subscription,
 * so that device row is deactivated rather than retried forever — otherwise a
 * stale token would be attempted on every future notification.
 */
async function deliverPush(
  draft: NotificationDraft,
  loc: { title_en: string; title_fr: string; title_ar: string; body_en: string; body_fr: string; body_ar: string },
): Promise<void> {
  const devices = await queryMany<{ id: string; push_token: string; locale: string | null }>(
    `select id, push_token, locale from devices
     where user_id = $1 and is_active and push_token is not null`,
    [draft.userId],
  );
  if (devices.length === 0) return;

  const forLocale = (locale: string | null) => {
    const subject = locale === 'ar' ? loc.title_ar : locale === 'fr' ? loc.title_fr : loc.title_en;
    const message = locale === 'ar' ? loc.body_ar : locale === 'fr' ? loc.body_fr : loc.body_en;
    return { subject, message };
  };

  for (const device of devices) {
    const { subject, message } = forLocale(device.locale);
    try {
      await adapters.push.send(device.push_token, subject, message, {
        ...(draft.data ?? {}),
        url: typeof draft.data?.url === 'string' ? draft.data.url : '/',
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (/\b(404|410)\b/.test(text)) {
        await queryOne('update devices set is_active = false, updated_at = now() where id = $1', [device.id]);
        log.info({ deviceId: device.id }, 'push.subscription_expired');
      } else {
        log.warn({ deviceId: device.id, err: text.slice(0, 200) }, 'push.send_failed');
      }
    }
  }
}

/** Count of events still waiting — surfaced for tests and ops. */
export async function pendingOutboxCount(): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `select count(*)::text as count from outbox_events where status = 'PENDING'`,
  );
  return Number(row?.count ?? 0);
}

/** Read a batch of events without processing them (tests, debugging). */
export async function listOutbox(limit = 50): Promise<OutboxEventRow[]> {
  return queryMany<OutboxEventRow>(
    `select id, topic, aggregate_type, aggregate_id, payload, attempts, max_attempts
     from outbox_events order by created_at desc limit $1`,
    [limit],
  );
}

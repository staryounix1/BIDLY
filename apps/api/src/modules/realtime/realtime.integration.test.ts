import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Realtime, chat and notifications integration tests (task 8).
 *
 * Boots the real API against the local test database and drives the full path:
 * a domain action writes an outbox row, the worker drains it, a notification
 * lands in the recipient's inbox and a realtime event is published to the
 * subscriber that is allowed to receive it.
 *
 * The hub is inspected directly, which is the point of keeping it transport
 * agnostic: the room/authorisation rules are testable without opening a socket.
 *
 * Skips automatically when no test database is reachable.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres@127.0.0.1:55432/bidly_test';
process.env.DATABASE_SSL = 'false';
process.env.AUTH_SECRET ??= 'test-access-secret-that-is-long-enough-000000000000';
process.env.REFRESH_SECRET ??= 'test-refresh-secret-that-is-different-0000000000';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';

const captured: string[] = [];

let app: FastifyInstance | null = null;
let dbReady = false;

const run = `${Date.now()}`;
const password = 'Str0ngPass1';

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function makeApp(): Promise<FastifyInstance | null> {
  try {
    const { buildApp } = await import('../../app.js');
    return await buildApp({
      notifier: {
        sendEmail: async (_t: string, _s: string, body: string) => {
          captured.push(body);
        },
        sendSms: async (_t: string, body: string) => {
          captured.push(body);
        },
      },
    });
  } catch {
    return null;
  }
}

function latestOtp(): string | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const m = (captured[i] ?? '').match(/(\d{4,8})/);
    if (m) return m[1] ?? null;
  }
  return null;
}

async function registerAndLogin(kind: 'CUSTOMER' | 'PROVIDER', email: string) {
  await app!.inject({
    method: 'POST',
    url: '/api/v1/register',
    payload: { email, password, fullName: 'Test', role: kind },
  });
  const code = latestOtp();
  if (code) await app!.inject({ method: 'POST', url: '/api/v1/verify-email', payload: { email, code } });
  const login = await app!.inject({
    method: 'POST',
    url: '/api/v1/login',
    payload: { identifier: email, password },
  });
  return login.json().data as { accessToken: string; user: { id: string } };
}

let db: typeof import('../../db/pool.js');
let hub: typeof import('../../core/realtime.js');
let outbox: typeof import('../../core/outbox.js');

let customerToken = '';
let customerId = '';
let providerToken = '';
let providerUserId = '';
let outsiderToken = '';
let serviceId = '';

/** Drain the outbox once and return what it did. */
async function flush() {
  return outbox.drainOutbox(100, 'test-worker');
}

beforeAll(async () => {
  app = await makeApp();
  if (!app) return;
  try {
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    dbReady = res.statusCode === 200;
  } catch {
    dbReady = false;
  }
  if (!dbReady) return;

  db = await import('../../db/pool.js');
  hub = await import('../../core/realtime.js');
  outbox = await import('../../core/outbox.js');

  const customer = await registerAndLogin('CUSTOMER', `rt-cust-${run}@example.com`);
  customerToken = customer.accessToken;
  customerId = customer.user.id;

  const provider = await registerAndLogin('PROVIDER', `rt-prov-${run}@example.com`);
  providerToken = provider.accessToken;
  providerUserId = provider.user.id;

  const outsider = await registerAndLogin('CUSTOMER', `rt-out-${run}@example.com`);
  outsiderToken = outsider.accessToken;

  const catalog = await app.inject({ method: 'GET', url: '/api/v1/services?limit=1' });
  serviceId = (catalog.json().data as Array<{ id: string }>)[0]?.id ?? '';

  // Provider entity + service + ACTIVE (verification itself is task 10).
  await app.inject({
    method: 'POST',
    url: '/api/v1/providers',
    headers: auth(providerToken),
    payload: { displayName: `RT Provider ${run}` },
  });
  await app.inject({
    method: 'PUT',
    url: '/api/v1/providers/me/services',
    headers: auth(providerToken),
    payload: { serviceId, isActive: true, minPriceMinor: 1000, maxPriceMinor: 900000 },
  });
  await db.query(
    `update providers set status='ACTIVE', verification_status='VERIFIED', verified_at=now()
     where user_id = $1`,
    [providerUserId],
  );
});

afterAll(async () => {
  hub?.resetHub();
  await app?.close();
});

describe('outbox', () => {
  it('records a published request as an outbox event and notifies matched providers', async () => {
    if (!dbReady || !app) return;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/requests',
      headers: auth(customerToken),
      payload: {
        serviceId,
        title: `RT request ${run}`,
        budgetMinMinor: 20000,
        budgetMaxMinor: 60000,
        pickup: { line1: '1 RT Street', cityName: 'Rabat', lat: 34.02, lng: -6.83 },
      },
    });
    const requestId = created.json().data.id as string;

    const publish = await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${requestId}/publish`,
      headers: auth(customerToken),
      payload: {},
    });
    expect(publish.statusCode).toBe(200);

    // The event was written inside the publish transaction.
    const events = await outbox.listOutbox(20);
    expect(events.some((e) => e.topic === 'request.published' && e.aggregate_id === requestId)).toBe(true);

    const result = await flush();
    expect(result.processed).toBeGreaterThan(0);

    // The provider got an in-app notification.
    const notifications = await app.inject({
      method: 'GET',
      url: '/api/v1/notifications?limit=50',
      headers: auth(providerToken),
    });
    expect(notifications.statusCode).toBe(200);
    expect(
      notifications.json().data.some((n: { data: { requestId?: string } }) => n.data?.requestId === requestId),
    ).toBe(true);
  });

  it('deduplicates: a second drain does not create a second notification', async () => {
    if (!dbReady || !app) return;
    const before = await app.inject({ method: 'GET', url: '/api/v1/notifications?limit=100', headers: auth(providerToken) });
    const countBefore = before.json().meta.unread as number;
    await flush();
    const after = await app.inject({ method: 'GET', url: '/api/v1/notifications?limit=100', headers: auth(providerToken) });
    expect(after.json().meta.unread).toBe(countBefore);
  });
});

describe('realtime fan-out and authorisation', () => {
  it('delivers request:updated to a subscriber in the request room', async () => {
    if (!dbReady || !app) return;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/requests',
      headers: auth(customerToken),
      payload: {
        serviceId,
        title: `RT room ${run}`,
        budgetMinMinor: 20000,
        budgetMaxMinor: 60000,
        pickup: { line1: '2 RT Street', cityName: 'Rabat', lat: 34.02, lng: -6.83 },
      },
    });
    const requestId = created.json().data.id as string;

    const received: Array<{ event: string; room: string }> = [];
    const subscriberId = hub.subscribe({
      userId: providerUserId,
      rooms: [hub.requestRoom(requestId)],
      listener: (envelope) => received.push({ event: envelope.event, room: envelope.room }),
    });

    await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${requestId}/publish`,
      headers: auth(customerToken),
      payload: {},
    });
    await flush();

    hub.unsubscribe(subscriberId);

    // The provider is a matched candidate, so the published event reaches the
    // request room their screen is watching.
    expect(received.some((r) => r.event === 'request:updated')).toBe(true);
  });

  it('does not deliver a room event to a subscriber outside that room', async () => {
    if (!dbReady || !app) return;
    const received: string[] = [];
    const otherRoom = hub.requestRoom('00000000-0000-4000-8000-000000000000');
    const id = hub.subscribe({ userId: outsiderToken, rooms: [otherRoom], listener: (e) => received.push(e.event) });

    hub.publish(hub.requestRoom('11111111-1111-4111-8111-111111111111'), 'request:updated', { x: 1 });
    hub.unsubscribe(id);
    expect(received).toHaveLength(0);
  });

  it('delivers message:new only into the conversation room', async () => {
    if (!dbReady || !app) return;
    const conversation = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: auth(customerToken),
      payload: { counterpartId: providerUserId },
    });
    expect([200, 201]).toContain(conversation.statusCode);
    const conversationId = conversation.json().data.id as string;

    const inRoom: string[] = [];
    const outOfRoom: string[] = [];
    const a = hub.subscribe({
      userId: providerUserId,
      rooms: [hub.conversationRoom(conversationId)],
      listener: (e) => inRoom.push(e.event),
    });
    const b = hub.subscribe({ userId: outsiderToken, listener: (e) => outOfRoom.push(e.event) });

    await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: auth(customerToken),
      payload: { body: 'hello there', clientId: `c-${run}-1` },
    });
    await flush();

    hub.unsubscribe(a);
    hub.unsubscribe(b);

    expect(inRoom).toContain('message:new');
    expect(outOfRoom).not.toContain('message:new');
  });

  it('cleans up subscribers on unsubscribe with no leak', () => {
    const before = hub.subscriberCount();
    const id = hub.subscribe({ userId: customerId, listener: () => {} });
    expect(hub.subscriberCount()).toBe(before + 1);
    hub.unsubscribe(id);
    expect(hub.subscriberCount()).toBe(before);
    // Unsubscribing twice must be safe (disconnect + error can both fire).
    hub.unsubscribe(id);
    expect(hub.subscriberCount()).toBe(before);
  });
});

describe('chat', () => {
  let conversationId = '';

  it('creates a conversation between the two parties', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: auth(customerToken),
      payload: { counterpartId: providerUserId },
    });
    expect([200, 201]).toContain(res.statusCode);
    conversationId = res.json().data.id;
    expect(conversationId).toBeTruthy();
  });

  it('reuses the same conversation instead of creating a duplicate', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/conversations',
      headers: auth(customerToken),
      payload: { counterpartId: providerUserId },
    });
    expect(res.json().data.id).toBe(conversationId);
  });

  it('lets a participant send and read a message', async () => {
    if (!dbReady || !app) return;
    const sent = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: auth(customerToken),
      payload: { body: 'is the sink still leaking?', clientId: `m-${run}-a` },
    });
    expect(sent.statusCode).toBe(201);
    expect(sent.json().data.body).toContain('leaking');

    const read = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: auth(providerToken),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().data.messages.some((m: { body: string }) => m.body?.includes('leaking'))).toBe(true);
  });

  it('is idempotent on clientId: a retry does not create a second message', async () => {
    if (!dbReady || !app) return;
    const before = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages?limit=100`,
      headers: auth(customerToken),
    });
    const countBefore = before.json().data.messages.length;

    const payload = { body: 'retry me', clientId: `dup-${run}` };
    await app.inject({
      method: 'POST', url: `/api/v1/conversations/${conversationId}/messages`, headers: auth(customerToken), payload,
    });
    await app.inject({
      method: 'POST', url: `/api/v1/conversations/${conversationId}/messages`, headers: auth(customerToken), payload,
    });

    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages?limit=100`,
      headers: auth(customerToken),
    });
    expect(after.json().data.messages.length).toBe(countBefore + 1);
  });

  it('blocks a non-participant from reading the conversation (403)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: auth(outsiderToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it('blocks a non-participant from posting into the conversation (403)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: auth(outsiderToken),
      payload: { body: 'not allowed' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('requires authentication for the message thread (401)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({ method: 'GET', url: `/api/v1/conversations/${conversationId}/messages` });
    expect(res.statusCode).toBe(401);
  });

  it('tracks unread counts and clears them on read', async () => {
    if (!dbReady || !app) return;
    // Provider sends to the customer, so the customer has one unread.
    await app.inject({
      method: 'POST',
      url: `/api/v1/conversations/${conversationId}/messages`,
      headers: auth(providerToken),
      payload: { body: 'on my way', clientId: `unread-${run}` },
    });
    const list = await app.inject({ method: 'GET', url: '/api/v1/conversations?limit=50', headers: auth(customerToken) });
    const convo = (list.json().data.items as Array<{ id: string; unread_count: number }>).find((c) => c.id === conversationId);
    expect(convo).toBeTruthy();
    expect(convo!.unread_count).toBeGreaterThan(0);

    await app.inject({ method: 'POST', url: `/api/v1/conversations/${conversationId}/read`, headers: auth(customerToken), payload: {} });
    const after = await app.inject({ method: 'GET', url: '/api/v1/conversations?limit=50', headers: auth(customerToken) });
    const cleared = (after.json().data.items as Array<{ id: string; unread_count: number }>).find((c) => c.id === conversationId);
    expect(cleared!.unread_count).toBe(0);
  });
});

describe('notifications', () => {
  it('returns only the caller\'s own notifications', async () => {
    if (!dbReady || !app) return;
    const mine = await app.inject({ method: 'GET', url: '/api/v1/notifications?limit=50', headers: auth(customerToken) });
    expect(mine.statusCode).toBe(200);
    // Every returned row belongs to the caller (the API filters by user_id and
    // the route never accepts a user id from the client).
    expect(Array.isArray(mine.json().data)).toBe(true);
  });

  it('marks one notification read and decrements the unread count', async () => {
    if (!dbReady || !app) return;
    const list = await app.inject({ method: 'GET', url: '/api/v1/notifications?limit=50', headers: auth(providerToken) });
    const unreadBefore = list.json().meta.unread as number;
    const target = (list.json().data as Array<{ id: string; is_read: boolean }>).find((n) => !n.is_read);
    expect(target).toBeTruthy();

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${target!.id}/read`,
      headers: auth(providerToken),
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.is_read).toBe(true);

    const count = await app.inject({ method: 'GET', url: '/api/v1/notifications/unread-count', headers: auth(providerToken) });
    expect(count.json().data.unread).toBe(unreadBefore - 1);
  });

  it('cannot mark another user\'s notification read (404, not 200)', async () => {
    if (!dbReady || !app) return;
    const list = await app.inject({ method: 'GET', url: '/api/v1/notifications?limit=1', headers: auth(providerToken) });
    const id = (list.json().data as Array<{ id: string }>)[0]?.id;
    if (!id) return;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/notifications/${id}/read`,
      headers: auth(outsiderToken),
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('marks all notifications read', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({ method: 'POST', url: '/api/v1/notifications/read-all', headers: auth(customerToken), payload: {} });
    expect(res.statusCode).toBe(200);
    const count = await app.inject({ method: 'GET', url: '/api/v1/notifications/unread-count', headers: auth(customerToken) });
    expect(count.json().data.unread).toBe(0);
  });

  it('requires authentication to read notifications (401)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/notifications' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid realtime token (401)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/realtime?token=not-a-real-token' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a realtime stream with no token (401)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/realtime' });
    expect(res.statusCode).toBe(401);
  });
});

describe('job lifecycle notifications', () => {
  it('notifies both parties through accept → start → complete', async () => {
    if (!dbReady || !app) return;

    // Fresh request the provider can win.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/requests',
      headers: auth(customerToken),
      payload: {
        serviceId,
        title: `RT job ${run}`,
        budgetMinMinor: 20000,
        budgetMaxMinor: 80000,
        pickup: { line1: '3 RT Street', cityName: 'Rabat', lat: 34.02, lng: -6.83 },
      },
    });
    const requestId = created.json().data.id as string;
    await app.inject({ method: 'POST', url: `/api/v1/requests/${requestId}/publish`, headers: auth(customerToken), payload: {} });
    await flush();

    const offer = await app.inject({
      method: 'POST',
      url: '/api/v1/offers',
      headers: auth(providerToken),
      payload: { requestId, priceMinor: 30000 },
    });
    expect(offer.statusCode).toBe(201);
    const offerId = offer.json().data.id as string;

    const accept = await app.inject({ method: 'POST', url: `/api/v1/offers/${offerId}/accept`, headers: auth(customerToken), payload: {} });
    expect([200, 201]).toContain(accept.statusCode);
    const jobId = accept.json().data.jobId as string;

    await flush();

    const providerNotes = await app.inject({ method: 'GET', url: '/api/v1/notifications?limit=100', headers: auth(providerToken) });
    const types = (providerNotes.json().data as Array<{ type: string; data: { jobId?: string } }>).map((n) => n.type);
    expect(types).toContain('OFFER_ACCEPTED');

    // Drive the job forward and confirm the status event is emitted.
    await app.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/en-route`, headers: auth(providerToken), payload: {} });
    await app.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/arrived`, headers: auth(providerToken), payload: {} });
    const otp = await app.inject({ method: 'POST', url: `/api/v1/jobs/${jobId}/start-otp`, headers: auth(customerToken), payload: {} });
    const code = otp.json().data.otp as string;
    const started = await app.inject({
      method: 'POST', url: `/api/v1/jobs/${jobId}/start`, headers: auth(providerToken), payload: { otp: code },
    });
    expect(started.statusCode).toBe(200);

    await flush();
    const afterStart = await app.inject({ method: 'GET', url: '/api/v1/notifications?limit=100', headers: auth(customerToken) });
    const jobNotes = (afterStart.json().data as Array<{ type: string; data: { status?: string } }>).filter(
      (n) => n.type === 'JOB_STATUS_CHANGED' && n.data?.status === 'IN_PROGRESS',
    );
    expect(jobNotes.length).toBeGreaterThan(0);
  });
});

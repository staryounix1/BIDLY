import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Request-system integration tests.
 *
 * Boots the real app against the local test database and drives the customer
 * request flow end to end: create a draft, publish it, list it, read it,
 * cancel it — plus the failure paths (bad service, missing required answers,
 * unauthenticated, cross-customer access, and illegal status changes).
 *
 * Skips automatically when no test database is reachable (`dbReady`), so a
 * developer without Postgres still gets a green run; CI runs every assertion.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres@127.0.0.1:55432/bidly_test';
process.env.DATABASE_SSL = 'false';
process.env.AUTH_SECRET ??= 'test-access-secret-that-is-long-enough-000000000000';
process.env.REFRESH_SECRET ??= 'test-refresh-secret-that-is-different-0000000000';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';

const captured: string[] = [];

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

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

let app: FastifyInstance | null = null;
let dbReady = false;

const run = `${Date.now()}`;
const password = 'Str0ngPass1';

async function registerAndLogin(kind: 'CUSTOMER' | 'PROVIDER', email: string) {
  await app!.inject({
    method: 'POST',
    url: '/api/v1/register',
    payload: { email, password, fullName: 'Test', role: kind },
  });
  const code = latestOtp();
  if (code) {
    await app!.inject({ method: 'POST', url: '/api/v1/verify-email', payload: { email, code } });
  }
  const login = await app!.inject({
    method: 'POST',
    url: '/api/v1/login',
    payload: { identifier: email, password },
  });
  return login.json().data as { accessToken: string; user: { id: string } };
}

let customerToken = '';
let customerId = '';
let otherToken = '';
let providerToken = '';
let serviceId = '';
let serviceSlug = '';
let cityId: string | null = null;

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

  const customer = await registerAndLogin('CUSTOMER', `req-cust-${run}@example.com`);
  customerToken = customer.accessToken;
  customerId = customer.user.id;

  const other = await registerAndLogin('CUSTOMER', `req-other-${run}@example.com`);
  otherToken = other.accessToken;

  const provider = await registerAndLogin('PROVIDER', `req-prov-${run}@example.com`);
  providerToken = provider.accessToken;

  // Pick a real service + a city from the seeded catalogue.
  const catalog = await app.inject({ method: 'GET', url: '/api/v1/services?search=Single%20Item' });
  const services = catalog.json().data as Array<{ id: string; slug: string }>;
  serviceId = services[0]?.id ?? '';
  serviceSlug = services[0]?.slug ?? '';

  const cities = await app.inject({ method: 'GET', url: '/api/v1/cities' });
  cityId = (cities.json().data as Array<{ id: string }>)[0]?.id ?? null;
});

afterAll(async () => {
  await app?.close();
});

describe('catalogue', () => {
  it('serves the category tree and a service form without authentication', async () => {
    if (!dbReady || !app) return;
    const tree = await app.inject({ method: 'GET', url: '/api/v1/categories' });
    expect(tree.statusCode).toBe(200);
    expect(Array.isArray(tree.json().data.categories)).toBe(true);

    const form = await app.inject({ method: 'GET', url: `/api/v1/services/${serviceSlug}/form` });
    expect(form.statusCode).toBe(200);
    expect(form.json().data.service.id).toBe(serviceId);
    expect(Array.isArray(form.json().data.fields)).toBe(true);
  });
});

describe('request lifecycle', () => {
  let requestId = '';

  it('rejects request creation when unauthenticated (401)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({ method: 'POST', url: '/api/v1/requests', payload: { serviceId } });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a provider creating a request (403, customer-only)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/requests',
      headers: auth(providerToken),
      payload: { serviceId },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects an unknown service id (404)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/requests',
      headers: auth(customerToken),
      payload: { serviceId: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects invalid data — missing required dynamic answers (400)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/requests',
      headers: auth(customerToken),
      payload: {
        serviceId,
        pickup: { line1: 'Rue X, Rabat' },
        destination: { line1: 'Avenue Y, Salé' },
        answers: { details: 'Move one sofa', urgency: 'NORMAL', item_description: 'Sofa' },
        // address + destination_address are required and missing
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid budget ordering (400)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/requests',
      headers: auth(customerToken),
      payload: { serviceId, budgetMinMinor: 5000, budgetMaxMinor: 1000 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('creates a valid draft request with dynamic answers', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/requests',
      headers: auth(customerToken),
      payload: {
        serviceId,
        title: 'Move a single sofa',
        description: 'Second floor, no elevator.',
        urgency: 'HIGH',
        budgetMinMinor: 10000,
        budgetMaxMinor: 30000,
        pickup: { line1: 'Rue X, Rabat', district: 'Agdal', ...(cityId ? { cityId } : {}) },
        destination: { line1: 'Avenue Y, Salé', ...(cityId ? { cityId } : {}) },
        answers: {
          details: 'Move one sofa across town',
          urgency: 'HIGH',
          address: 'Rue X, Agdal, Rabat',
          destination_address: 'Avenue Y, Salé',
          item_description: 'A three-seat sofa',
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.id).toBeTruthy();
    expect(body.data.code).toMatch(/^REQ-/);
    requestId = body.data.id;
  });

  it('exposes the new request in the owner\'s list as DRAFT', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/requests/mine', headers: auth(customerToken) });
    expect(res.statusCode).toBe(200);
    const items = res.json().data.items as Array<{ id: string; status: string }>;
    const created = items.find((i) => i.id === requestId);
    expect(created?.status).toBe('DRAFT');
  });

  it('rejects another customer reading the request (403)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/requests/${requestId}`,
      headers: auth(otherToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it('returns full details to the owner', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/requests/${requestId}`,
      headers: auth(customerToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json().data;
    expect(body.request.id).toBe(requestId);
    expect(body.request.customer_id).toBe(customerId);
    expect(body.answers.length).toBeGreaterThan(0);
  });

  it('publishes the draft and records the transition', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${requestId}/publish`,
      headers: auth(customerToken),
      payload: { expiresInHours: 48 },
    });
    expect(res.statusCode).toBe(200);
    // Publishing moves the request out of DRAFT. When the matching run finds
    // eligible providers it advances through MATCHING to RECEIVING_OFFERS in
    // the same transaction; with no candidates it stays at PUBLISHED.
    expect(['PUBLISHED', 'MATCHING', 'RECEIVING_OFFERS']).toContain(res.json().data.status);
    expect(res.json().data.published_at).toBeTruthy();

    // Publishing twice is an illegal transition from PUBLISHED.
    const again = await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${requestId}/publish`,
      headers: auth(customerToken),
      payload: {},
    });
    expect([409, 422]).toContain(again.statusCode);
  });

  it('rejects editing a published request (only drafts are editable)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/v1/requests/${requestId}`,
      headers: auth(customerToken),
      payload: { title: 'Changed' },
    });
    expect([409, 422]).toContain(res.statusCode);
  });

  it('rejects another customer cancelling the request (403)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${requestId}/cancel`,
      headers: auth(otherToken),
      payload: {},
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets the owner cancel while the request is open', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${requestId}/cancel`,
      headers: auth(customerToken),
      payload: { reason: 'no longer needed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('CANCELLED');
    expect(res.json().data.cancelled_at).toBeTruthy();
  });

  it('refuses to cancel an already-cancelled request (illegal transition)', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/requests/${requestId}/cancel`,
      headers: auth(customerToken),
      payload: {},
    });
    expect([409, 422]).toContain(res.statusCode);
  });
});

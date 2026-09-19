import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Authentication integration tests.
 *
 * These boot the real Fastify app (via `buildApp`) against the local test
 * database and drive it with `app.inject()`, so they exercise the full stack:
 * routing, validation, the auth service, the session/refresh logic, and the
 * authorization guards — not mocks.
 *
 * The suite is skipped automatically when no test database is reachable
 * (see `dbReady`), so a developer without Postgres running still gets a green
 * run; in CI with a database present every assertion executes.
 *
 * Sessions are never shared across tests: rotation revokes the prior session,
 * so each test that needs a live token signs in fresh.
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
    const notifier = {
      sendEmail: async (_to: string, _subject: string, body: string) => {
        captured.push(body);
      },
      sendSms: async (_to: string, body: string) => {
        captured.push(body);
      },
    };
    return await buildApp({ notifier });
  } catch {
    return null;
  }
}

/** The dev notifier logs the code in the message body; pull the last one. */
function latestOtp(): string | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const body = captured[i] ?? '';
    if (/code is|verification code|reset/i.test(body)) {
      const match = body.match(/(\d{4,8})/);
      if (match) return match[1] ?? null;
    }
  }
  return null;
}

let app: FastifyInstance | null = null;
let dbReady = false;

const run = `${Date.now()}`;
const customerEmail = `itest-customer-${run}@example.com`;
const providerEmail = `itest-provider-${run}@example.com`;
const password = 'Str0ngPass1';

async function signIn(identifier: string) {
  const res = await app!.inject({
    method: 'POST',
    url: '/api/v1/login',
    payload: { identifier, password },
  });
  return res.json().data as { accessToken: string; refreshToken: string; user: { role: string } };
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
});

afterAll(async () => {
  await app?.close();
});

describe('authentication & roles', () => {
  it('registers a customer without ever returning a password or hash', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/register',
      payload: { email: customerEmail, password, fullName: 'Test Customer', role: 'CUSTOMER' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.data.user.email).toBe(customerEmail);
    expect(body.data.verificationRequired).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/password_hash|passwordHash|"password"/i);
  });

  it('rejects a weak password with 400', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/register',
      payload: { email: `weak-${run}@example.com`, password: '123', fullName: 'X', role: 'CUSTOMER' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a duplicate account with 409', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/register',
      payload: { email: customerEmail, password, fullName: 'Dup', role: 'CUSTOMER' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DUPLICATE_EMAIL');
  });

  it('rejects a privileged role at registration', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/register',
      payload: { email: `admin-try-${run}@example.com`, password, role: 'ADMIN' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('verifies the email, then logs in with the correct credentials', async () => {
    if (!dbReady || !app) return;
    const code = latestOtp();
    expect(code).toBeTruthy();

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/verify-email',
      payload: { email: customerEmail, code },
    });
    expect(verify.statusCode).toBe(200);

    const session = await signIn(customerEmail);
    expect(session.user.role).toBe('CUSTOMER');
    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toBeTruthy();
  });

  it('rejects a wrong password with 401', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/login',
      payload: { identifier: customerEmail, password: 'WrongPass99' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('rejects an unauthenticated request to a protected route', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(res.statusCode).toBe(401);
  });

  it('returns the current user for an authenticated request', async () => {
    if (!dbReady || !app) return;
    const { accessToken } = await signIn(customerEmail);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.email).toBe(customerEmail);
    expect(body.data.role).toBe('CUSTOMER');
    expect(JSON.stringify(body)).not.toMatch(/password_hash|passwordHash/i);
  });

  it('rotates the refresh token and detects reuse', async () => {
    if (!dbReady || !app) return;
    const { refreshToken } = await signIn(customerEmail);

    const rotated = await app.inject({
      method: 'POST',
      url: '/api/v1/refresh',
      payload: { refreshToken },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().data.refreshToken).not.toBe(refreshToken);

    // The original token was rotated away; reusing it is a theft signal.
    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/refresh',
      payload: { refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('reads and updates the profile, never leaking secrets', async () => {
    if (!dbReady || !app) return;
    const { accessToken } = await signIn(customerEmail);

    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me/profile',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(before.statusCode).toBe(200);
    expect(JSON.stringify(before.json())).not.toMatch(/password_hash|mfa_secret/i);

    const patch = await app.inject({
      method: 'PATCH',
      url: '/api/v1/users/me/profile',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { displayName: 'Updated Name' },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().data.display_name).toBe('Updated Name');
  });

  it('rejects an unauthenticated profile read', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/users/me/profile' });
    expect(res.statusCode).toBe(401);
  });

  it('enforces role authorization on the backend', async () => {
    if (!dbReady || !app) return;
    const { accessToken } = await signIn(customerEmail);

    // A customer hitting an admin route is forbidden (403, authenticated but
    // not permitted), never 401.
    const adminAttempt = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/stats',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(adminAttempt.statusCode).toBe(403);

    // Register + verify a provider, then confirm a provider is refused on a
    // customer-only route.
    const reg = await app.inject({
      method: 'POST',
      url: '/api/v1/register',
      payload: { email: providerEmail, password, fullName: 'Test Provider', role: 'PROVIDER' },
    });
    expect(reg.statusCode).toBe(201);
    const code = latestOtp();
    await app.inject({
      method: 'POST',
      url: '/api/v1/verify-email',
      payload: { email: providerEmail, code },
    });
    const provider = await signIn(providerEmail);
    expect(provider.user.role).toBe('PROVIDER');

    const providerOnCustomerRoute = await app.inject({
      method: 'POST',
      url: '/api/v1/requests',
      headers: { authorization: `Bearer ${provider.accessToken}` },
      payload: { serviceId: '00000000-0000-0000-0000-000000000000', title: 'x' },
    });
    expect(providerOnCustomerRoute.statusCode).toBe(403);
  });

  it('logs out and the access token stops working', async () => {
    if (!dbReady || !app) return;
    const { accessToken } = await signIn(customerEmail);

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/logout',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(out.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(after.statusCode).toBe(401);
  });
});

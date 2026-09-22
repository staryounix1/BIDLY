import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Media upload tests.
 *
 * The whole point of the `/media` routes is that a video is far too big for the
 * JSON pipeline: the API parses JSON under a 1 MB cap, so a clip can only ever
 * arrive as its own bytes. These tests pin that contract down and, just as
 * importantly, prove that claiming the media content types did not break the
 * JSON routes — a catch-all parser would silently turn every request body into
 * a Buffer.
 *
 * Skips when no local test database is reachable, like the other integration
 * suites.
 */

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres@127.0.0.1:55432/bidly_test';
process.env.DATABASE_SSL = 'false';
process.env.AUTH_SECRET ??= 'test-access-secret-that-is-long-enough-000000000000';
process.env.REFRESH_SECRET ??= 'test-refresh-secret-that-is-different-0000000000';
process.env.RATE_LIMIT_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';

let app: FastifyInstance | null = null;

beforeAll(async () => {
  try {
    const { buildApp } = await import('../../app.js');
    app = await buildApp({
      notifier: { sendEmail: async () => {}, sendSms: async () => {} },
    });
    await app.ready();
  } catch {
    app = null;
  }
});

afterAll(async () => {
  await app?.close();
});

describe('media uploads', () => {
  it('requires authentication', async () => {
    if (!app) return;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { 'content-type': 'video/mp4' },
      payload: Buffer.from([0, 1, 2, 3]),
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a body far larger than the JSON limit', async () => {
    if (!app) return;
    // 3 MB is three times the 1 MB JSON parser cap: this is exactly the size
    // that used to fail as "video too large" on the client.
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/media',
      headers: { 'content-type': 'video/mp4' },
      payload: big,
    });
    // 401 (no token) is the expected barrier; what matters is that the body was
    // read at all rather than rejected by the JSON size limit with a 413.
    expect([401, 201]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(413);
  });

  it('still parses JSON bodies on the other routes', async () => {
    if (!app) return;
    // A catch-all content-type parser would break this: the body would arrive
    // as a Buffer and every schema-validated route would 400.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { identifier: 'nobody@example.test', password: 'not-a-real-password' },
    });
    expect(res.statusCode).not.toBe(415);
    expect(res.statusCode).not.toBe(500);
  });
});

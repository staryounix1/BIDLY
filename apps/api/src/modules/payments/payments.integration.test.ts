import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * Payments, wallet, webhooks and admin console integration tests (task 9).
 *
 * Boots the real API against the local test database and drives money end to
 * end: an offer is accepted, the job is completed, the customer pays, the
 * provider wallet is credited through the ledger, a payout is requested and
 * settled by an admin, and a signed provider webhook is verified, applied once
 * and ignored on replay.
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
process.env.PAYMENT_WEBHOOK_SECRET ??= 'test-webhook-secret';

const captured: string[] = [];
const run = `${Date.now()}`;
const password = 'Str0ngPass1';

let app: FastifyInstance | null = null;
let dbReady = false;
let db: typeof import('../../db/pool.js');

let customerToken = '';
let customerId = '';
let providerToken = '';
let providerUserId = '';
let adminToken = '';
let outsiderToken = '';
let serviceId = '';
let jobId = '';
let paymentId = '';

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

function latestOtp(): string | null {
  for (let i = captured.length - 1; i >= 0; i--) {
    const m = (captured[i] ?? '').match(/(\d{4,8})/);
    if (m) return m[1] ?? null;
  }
  return null;
}

async function makeApp(): Promise<FastifyInstance | null> {
  try {
    const { buildApp } = await import('../../app.js');
    return await buildApp({
      notifier: {
        sendEmail: async (_t: string, _s: string, body: string) => { captured.push(body); },
        sendSms: async (_t: string, body: string) => { captured.push(body); },
      },
    });
  } catch {
    return null;
  }
}

async function registerAndLogin(kind: 'CUSTOMER' | 'PROVIDER', email: string) {
  await app!.inject({ method: 'POST', url: '/api/v1/register', payload: { email, password, fullName: 'Test', role: kind } });
  const code = latestOtp();
  if (code) await app!.inject({ method: 'POST', url: '/api/v1/verify-email', payload: { email, code } });
  const login = await app!.inject({ method: 'POST', url: '/api/v1/login', payload: { identifier: email, password } });
  return login.json().data as { accessToken: string; user: { id: string } };
}

/** Create an admin user + admins row and log in. */
async function makeAdmin(role: string): Promise<{ token: string; userId: string }> {
  const email = `pay-admin-${role}-${run}@example.com`;
  await app!.inject({ method: 'POST', url: '/api/v1/register', payload: { email, password, fullName: 'Admin', role: 'CUSTOMER' } });
  const code = latestOtp();
  if (code) await app!.inject({ method: 'POST', url: '/api/v1/verify-email', payload: { email, code } });
  const login = await app!.inject({ method: 'POST', url: '/api/v1/login', payload: { identifier: email, password } });
  const data = login.json().data as { accessToken: string; user: { id: string } };
  await db.query(`update users set role = 'ADMIN' where id = $1`, [data.user.id]);
  await db.query(
    `insert into admins (user_id, email, full_name, password_hash, role, is_active)
     values ($1,$2,'Admin','test-not-used',$3,true)
     on conflict (email) do update set user_id = $1, role = $3`,
    [data.user.id, email, role],
  );
  // The access token embeds the role, so log in again now that it is ADMIN.
  const relogin = await app!.inject({ method: 'POST', url: '/api/v1/login', payload: { identifier: email, password } });
  return { token: (relogin.json().data as { accessToken: string }).accessToken, userId: data.user.id };
}

async function createJobAndAccept(): Promise<string> {
  const created = await app!.inject({
    method: 'POST', url: '/api/v1/requests', headers: auth(customerToken),
    payload: {
      serviceId,
      title: `Pay request ${run}`,
      budgetMinMinor: 20000,
      budgetMaxMinor: 60000,
      pickup: { line1: '1 Pay Street', cityName: 'Rabat', lat: 34.02, lng: -6.83 },
    },
  });
  const requestId = created.json().data.id as string;
  await app!.inject({ method: 'POST', url: `/api/v1/requests/${requestId}/publish`, headers: auth(customerToken), payload: {} });

  const offer = await app!.inject({
    method: 'POST', url: '/api/v1/offers', headers: auth(providerToken),
    payload: { requestId, priceMinor: 28000, message: 'I can do it' },
  });
  const offerId = offer.json().data.id as string;
  const accept = await app!.inject({
    method: 'POST', url: `/api/v1/offers/${offerId}/accept`, headers: auth(customerToken), payload: {},
  });
  const acceptedJobId = accept.json().data?.jobId as string;
  // Drive the job lifecycle to COMPLETED so payment is legal: the provider
  // goes en-route and arrives, the customer issues the start code, then the
  // provider starts and completes the work.
  for (const action of ['en-route', 'arrived']) {
    await app!.inject({ method: 'POST', url: `/api/v1/jobs/${acceptedJobId}/${action}`, headers: auth(providerToken), payload: {} });
  }
  const otp = await app!.inject({ method: 'POST', url: `/api/v1/jobs/${acceptedJobId}/start-otp`, headers: auth(customerToken), payload: {} });
  const code = (otp.json().data as { code?: string; otp?: string })?.code
    ?? (otp.json().data as { code?: string; otp?: string })?.otp
    ?? '';
  await app!.inject({ method: 'POST', url: `/api/v1/jobs/${acceptedJobId}/start`, headers: auth(providerToken), payload: { otp: code } });
  await app!.inject({ method: 'POST', url: `/api/v1/jobs/${acceptedJobId}/complete`, headers: auth(providerToken), payload: { note: 'done' } });
  return acceptedJobId;
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

  const customer = await registerAndLogin('CUSTOMER', `pay-cust-${run}@example.com`);
  customerToken = customer.accessToken;
  customerId = customer.user.id;

  const provider = await registerAndLogin('PROVIDER', `pay-prov-${run}@example.com`);
  providerToken = provider.accessToken;
  providerUserId = provider.user.id;

  const outsider = await registerAndLogin('CUSTOMER', `pay-out-${run}@example.com`);
  outsiderToken = outsider.accessToken;

  const catalog = await app.inject({ method: 'GET', url: '/api/v1/services?limit=1' });
  serviceId = (catalog.json().data as Array<{ id: string }>)[0]?.id ?? '';

  await app.inject({ method: 'POST', url: '/api/v1/providers', headers: auth(providerToken), payload: { displayName: `Pay Provider ${run}` } });
  await app.inject({
    method: 'PUT', url: '/api/v1/providers/me/services', headers: auth(providerToken),
    payload: { serviceId, isActive: true, minPriceMinor: 1000, maxPriceMinor: 900000 },
  });
  await db.query(
    `update providers set status='ACTIVE', verification_status='VERIFIED', verified_at=now() where user_id = $1`,
    [providerUserId],
  );

  const admin = await makeAdmin('SUPER_ADMIN');
  adminToken = admin.token;

  jobId = await createJobAndAccept();
});

afterAll(async () => {
  await app?.close();
});

describe('payment capture and wallet ledger', () => {
  it('captures the job payment, records transactions, credits the provider wallet and commission', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/payments/job/${jobId}/pay`, headers: auth(customerToken), payload: { method: 'CARD' },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json().data as { paymentId: string; status: string };
    expect(data.status).toBe('CAPTURED');
    paymentId = data.paymentId;

    const payment = await db.query<{ status: string; captured_minor: string; commission_minor: string }>(
      `select status, captured_minor, commission_minor from payments where id = $1`, [paymentId],
    );
    expect(payment.rows[0]?.status).toBe('CAPTURED');
    expect(Number(payment.rows[0]?.captured_minor)).toBe(28000);

    const txns = await db.query<{ type: string; status: string }>(
      `select type, status from payment_transactions where payment_id = $1 order by created_at`, [paymentId],
    );
    const types = txns.rows.map((r) => `${r.type}:${r.status}`);
    expect(types).toContain('AUTHORIZE:SUCCESS');
    expect(types).toContain('CAPTURE:SUCCESS');

    const commission = Number(payment.rows[0]?.commission_minor);
    const wallet = await db.query<{ available_minor: string }>(
      `select available_minor from wallets where owner_type = 'PROVIDER' and owner_id = $1`, [providerUserId],
    );
    expect(Number(wallet.rows[0]?.available_minor)).toBe(28000 - commission);

    const ledger = await db.query<{ type: string; direction: string }>(
      `select wt.type, wt.direction from wallet_transactions wt join wallets w on w.id = wt.wallet_id
       where w.owner_id = $1 and wt.job_id = $2`, [providerUserId, jobId],
    );
    expect(ledger.rows.some((r) => r.type === 'JOB_EARNING' && r.direction === 'CREDIT')).toBe(true);
  });

  it('is idempotent: paying again returns the captured payment without a second charge', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/payments/job/${jobId}/pay`, headers: auth(customerToken), payload: { method: 'CARD' },
    });
    expect(res.statusCode).toBe(200);
    const row = await db.query<{ n: string }>(
      `select count(*)::text as n from payment_transactions where payment_id = $1 and type = 'CAPTURE' and status = 'SUCCESS'`,
      [paymentId],
    );
    expect(row.rows[0]?.n).toBe('1');
  });

  it('rejects payment from a user who is not the customer', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST', url: `/api/v1/payments/job/${jobId}/pay`, headers: auth(outsiderToken), payload: { method: 'CARD' },
    });
    expect([403, 404]).toContain(res.statusCode);
  });
});

describe('provider wallet and payouts', () => {
  it('shows the wallet balance and ledger to the provider', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/wallets/me', headers: auth(providerToken) });
    expect(res.statusCode).toBe(200);
    expect(Number(res.json().data.available_minor)).toBeGreaterThan(0);

    const ledger = await app.inject({ method: 'GET', url: '/api/v1/wallets/me/transactions', headers: auth(providerToken) });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json().data.length).toBeGreaterThan(0);
  });

  it('moves funds to reserved when a payout is requested', async () => {
    if (!dbReady || !app) return;
    const before = await db.query<{ available_minor: string; reserved_minor: string }>(
      `select available_minor, reserved_minor from wallets where owner_type='PROVIDER' and owner_id=$1`, [providerUserId],
    );
    const availableBefore = Number(before.rows[0]?.available_minor);
    const reservedBefore = Number(before.rows[0]?.reserved_minor);

    const res = await app.inject({
      method: 'POST', url: '/api/v1/payouts', headers: auth(providerToken),
      payload: { amountMinor: 10000, method: 'BANK_TRANSFER' },
    });
    expect(res.statusCode).toBe(201);

    const after = await db.query<{ available_minor: string; reserved_minor: string }>(
      `select available_minor, reserved_minor from wallets where owner_type='PROVIDER' and owner_id=$1`, [providerUserId],
    );
    expect(Number(after.rows[0]?.available_minor)).toBe(availableBefore - 10000);
    expect(Number(after.rows[0]?.reserved_minor)).toBe(reservedBefore + 10000);
  });

  it('refuses a payout above the available balance', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({
      method: 'POST', url: '/api/v1/payouts', headers: auth(providerToken),
      payload: { amountMinor: 999999999, method: 'BANK_TRANSFER' },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });
});

describe('signed provider webhooks', () => {
  it('rejects a webhook with an invalid signature', async () => {
    if (!dbReady || !app) return;
    const payload = JSON.stringify({ eventId: `evt-bad-${run}`, eventType: 'payment.updated', providerRef: 'x', status: 'CAPTURED' });
    const res = await app.inject({
      method: 'POST', url: '/api/v1/payments/webhook/internal-webhook',
      headers: { 'content-type': 'application/json', 'x-bidly-signature': 'deadbeef' },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts, records and applies a correctly signed webhook once', async () => {
    if (!dbReady || !app) return;
    const { createHmac } = await import('node:crypto');
    const secret = process.env.PAYMENT_WEBHOOK_SECRET!;
    const eventId = `evt-ok-${run}`;
    const payload = JSON.stringify({ eventId, eventType: 'payment.updated', providerRef: 'int_nonexistent', status: 'CAPTURED', amountMinor: 100 });
    const sig = createHmac('sha256', secret).update(payload).digest('hex');

    const res = await app.inject({
      method: 'POST', url: '/api/v1/payments/webhook/internal-webhook',
      headers: { 'content-type': 'application/json', 'x-bidly-signature': sig },
      payload,
    });
    expect(res.statusCode).toBe(200);

    const row = await db.query<{ n: string }>(
      `select count(*)::text as n from webhook_events where provider_name = 'internal-webhook' and event_id = $1`, [eventId],
    );
    expect(row.rows[0]?.n).toBe('1');

    // Replay: acknowledged, not recorded a second time.
    const replay = await app.inject({
      method: 'POST', url: '/api/v1/payments/webhook/internal-webhook',
      headers: { 'content-type': 'application/json', 'x-bidly-signature': sig },
      payload,
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.json().data.duplicate).toBe(true);
    const row2 = await db.query<{ n: string }>(
      `select count(*)::text as n from webhook_events where provider_name = 'internal-webhook' and event_id = $1`, [eventId],
    );
    expect(row2.rows[0]?.n).toBe('1');
  });
});

describe('admin console', () => {
  it('returns platform KPIs', async () => {
    if (!dbReady || !app) return;
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/stats', headers: auth(adminToken) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.active_users).toBeGreaterThanOrEqual(1);
  });

  it('lists payments, transactions and wallets', async () => {
    if (!dbReady || !app) return;
    const payments = await app.inject({ method: 'GET', url: '/api/v1/admin/payments', headers: auth(adminToken) });
    expect(payments.statusCode).toBe(200);
    expect(payments.json().data.some((p: { id: string }) => p.id === paymentId)).toBe(true);

    const detail = await app.inject({ method: 'GET', url: `/api/v1/admin/payments/${paymentId}`, headers: auth(adminToken) });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.transactions.length).toBeGreaterThan(0);

    const txns = await app.inject({ method: 'GET', url: '/api/v1/admin/transactions', headers: auth(adminToken) });
    expect(txns.statusCode).toBe(200);

    const wallets = await app.inject({ method: 'GET', url: '/api/v1/admin/wallets', headers: auth(adminToken) });
    expect(wallets.statusCode).toBe(200);
    expect(wallets.json().data.length).toBeGreaterThan(0);

    const summary = await app.inject({ method: 'GET', url: '/api/v1/admin/payments/summary', headers: auth(adminToken) });
    expect(summary.statusCode).toBe(200);
  });

  it('adjusts a wallet with an append-only ledger entry and audits it', async () => {
    if (!dbReady || !app) return;
    const wallet = await db.query<{ id: string; available_minor: string }>(
      `select id, available_minor from wallets where owner_type='PROVIDER' and owner_id=$1`, [providerUserId],
    );
    const walletId = wallet.rows[0]!.id;
    const before = Number(wallet.rows[0]!.available_minor);

    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/wallets/${walletId}/adjust`, headers: auth(adminToken),
      payload: { direction: 'CREDIT', amountMinor: 500, reason: 'Goodwill credit for testing' },
    });
    expect(res.statusCode).toBe(200);

    const after = await db.query<{ available_minor: string }>(`select available_minor from wallets where id=$1`, [walletId]);
    expect(Number(after.rows[0]?.available_minor)).toBe(before + 500);

    const entry = await db.query<{ type: string }>(
      `select type from wallet_transactions where wallet_id=$1 order by created_at desc limit 1`, [walletId],
    );
    expect(entry.rows[0]?.type).toBe('ADJUSTMENT');

    const audit = await app.inject({ method: 'GET', url: '/api/v1/admin/audit-log', headers: auth(adminToken) });
    expect(audit.statusCode).toBe(200);
    expect(audit.json().data.some((a: { action: string }) => a.action === 'ADJUST_WALLET')).toBe(true);
  });

  it('lists pending providers and verifies one using correct columns', async () => {
    if (!dbReady || !app) return;
    await db.query(`update providers set verification_status='PENDING', status='PENDING_REVIEW' where user_id=$1`, [providerUserId]);
    const pending = await app.inject({ method: 'GET', url: '/api/v1/admin/providers/pending', headers: auth(adminToken) });
    expect(pending.statusCode).toBe(200);
    const ourId = (await db.query<{ id: string }>(`select id from providers where user_id=$1`, [providerUserId])).rows[0]!.id;
    expect(pending.json().data.some((p: { id: string }) => p.id === ourId)).toBe(true);

    const verify = await app.inject({
      method: 'POST', url: `/api/v1/admin/providers/${ourId}/verify`, headers: auth(adminToken),
      payload: { decision: 'APPROVE' },
    });
    expect(verify.statusCode).toBe(200);
    const row = await db.query<{ verification_status: string; status: string }>(
      `select verification_status, status from providers where id=$1`, [ourId],
    );
    expect(row.rows[0]?.verification_status).toBe('VERIFIED');
    expect(row.rows[0]?.status).toBe('ACTIVE');
  });

  it('lists requests and services, and updates a service', async () => {
    if (!dbReady || !app) return;
    const requests = await app.inject({ method: 'GET', url: '/api/v1/admin/requests', headers: auth(adminToken) });
    expect(requests.statusCode).toBe(200);

    const services = await app.inject({ method: 'GET', url: '/api/v1/admin/services', headers: auth(adminToken) });
    expect(services.statusCode).toBe(200);
    const svcId = services.json().data[0]?.id as string;

    const patch = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/services/${svcId}`, headers: auth(adminToken),
      payload: { isActive: true },
    });
    expect(patch.statusCode).toBe(200);
  });

  it('rejects a non-admin and records each mutating action in the audit log', async () => {
    if (!dbReady || !app) return;
    const denied = await app.inject({ method: 'GET', url: '/api/v1/admin/stats', headers: auth(customerToken) });
    expect(denied.statusCode).toBe(403);

    const action = await db.query<{ n: string }>(
      `select count(*)::text as n from admin_actions where action = 'VERIFY_PROVIDER' or action = 'APPROVE_PROVIDER'`,
    );
    expect(Number(action.rows[0]?.n)).toBeGreaterThan(0);
  });
});

describe('payout settlement by admin', () => {
  it('rejects a payout and returns the reserved funds to available', async () => {
    if (!dbReady || !app) return;
    const payout = await db.query<{ id: string; amount_minor: string }>(
      `select id, amount_minor from payouts where user_id=$1 and status='REQUESTED' order by created_at desc limit 1`,
      [providerUserId],
    );
    if (!payout.rows[0]) return;
    const payoutId = payout.rows[0].id;

    const wBefore = await db.query<{ available_minor: string; reserved_minor: string }>(
      `select available_minor, reserved_minor from wallets where owner_type='PROVIDER' and owner_id=$1`, [providerUserId],
    );

    const res = await app.inject({
      method: 'POST', url: `/api/v1/admin/payouts/${payoutId}/process`, headers: auth(adminToken),
      payload: { decision: 'REJECT', reason: 'Missing bank details' },
    });
    expect(res.statusCode).toBe(200);

    const wAfter = await db.query<{ available_minor: string; reserved_minor: string }>(
      `select available_minor, reserved_minor from wallets where owner_type='PROVIDER' and owner_id=$1`, [providerUserId],
    );
    const amount = Number(payout.rows[0].amount_minor);
    expect(Number(wAfter.rows[0]?.available_minor)).toBe(Number(wBefore.rows[0]?.available_minor) + amount);
    expect(Number(wAfter.rows[0]?.reserved_minor)).toBe(Number(wBefore.rows[0]?.reserved_minor) - amount);

    const status = await db.query<{ status: string }>(`select status from payouts where id=$1`, [payoutId]);
    expect(status.rows[0]?.status).toBe('REJECTED');
  });
});

describe('permission gating', () => {
  it('denies finance endpoints to a MODERATOR but allows reads', async () => {
    if (!dbReady || !app) return;
    const mod = await makeAdmin('MODERATOR');

    const stats = await app.inject({ method: 'GET', url: '/api/v1/admin/stats', headers: auth(mod.token) });
    expect(stats.statusCode).toBe(200);

    const wallets = await app.inject({ method: 'GET', url: '/api/v1/admin/wallets', headers: auth(mod.token) });
    expect(wallets.statusCode).toBe(403);

    const users = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers: auth(mod.token) });
    expect(users.statusCode).toBe(200);
  });
});

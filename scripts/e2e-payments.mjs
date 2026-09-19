#!/usr/bin/env node
/**
 * Payments, wallet, webhooks and admin console live E2E (task 9).
 *
 * Drives money end to end over real HTTP against a running API and
 * PostgreSQL: register → job completed → pay → wallet ledger → payout request
 * → admin settle → signed webhook apply/replay → admin console + RBAC.
 *
 * Run:
 *   node scripts/e2e-payments.mjs [baseUrl]
 */

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

const ORIGIN = process.argv[2] ?? 'http://127.0.0.1:4000';
const BASE = ORIGIN + '/api/v1';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function req(method, path, { token, body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

function codeFor(email) {
  for (const path of ['/tmp/bcode/api9.log', '/tmp/bcode/api8.log', '/tmp/bcode/api.log']) {
    try {
      const log = readFileSync(path, 'utf8');
      const lines = log.split('\n').filter((l) => l.includes(email));
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/code is (\d+)/);
        if (m) return m[1];
      }
    } catch { /* no log */ }
  }
  return process.env.E2E_OTP ?? null;
}

const stamp = Date.now();
const password = 'Str0ngPass1';

async function register(role, email) {
  await req('POST', '/register', { body: { email, password, fullName: 'E2E9', role } });
  await new Promise((r) => setTimeout(r, 400));
  const code = codeFor(email);
  if (code) await req('POST', '/verify-email', { body: { email, code } });
  const login = await req('POST', '/login', { body: { identifier: email, password } });
  const token = login.body?.data?.accessToken ?? '';
  const me = await req('GET', '/me', { token });
  return { token, id: me.body?.data?.id };
}

let adminCurlAvailable = true;

async function run() {
  console.log(`\nBIDLY task 9 E2E → ${ORIGIN}\n`);

  const ready = await fetch(ORIGIN + '/health/ready').catch(() => null);
  check('API is ready', ready?.status === 200);
  if (ready?.status !== 200) return finish();

  const customer = await register('CUSTOMER', `e2e9-cust-${stamp}@example.com`);
  const provider = await register('PROVIDER', `e2e9-prov-${stamp}@example.com`);
  check('register + login (customer, provider)', Boolean(customer.token && provider.token));
  if (!customer.token || !provider.token) return finish();

  const catalog = await req('GET', '/services?limit=1');
  const serviceId = catalog.body?.data?.[0]?.id;

  // Provider entity + service + ACTIVE (verification runs through the admin console).
  await req('POST', '/providers', { token: provider.token, body: { displayName: `E2E9 Provider ${stamp}` } });
  await req('PUT', '/providers/me/services', {
    token: provider.token,
    body: { serviceId, isActive: true, minPriceMinor: 1000, maxPriceMinor: 900000 },
  });

  // Promote an admin via SQL is not available here; use the seeded admin if present.
  const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'admin@bidly.test';
  const adminLogin = await req('POST', '/login', { body: { identifier: adminEmail, password: process.env.E2E_ADMIN_PASSWORD ?? 'BidlyDev!2026' } });
  const adminToken = adminLogin.body?.data?.accessToken ?? '';
  check('admin login', Boolean(adminToken));
  if (!adminToken) return finish();

  // The provider must be ACTIVE to offer; verify through the admin console.
  const pending = await req('GET', '/admin/providers/pending', { token: adminToken });
  const providerId = pending.body?.data?.find((p) => p.owner_email === `e2e9-prov-${stamp}@example.com`)?.id;
  check('admin lists pending providers (correct columns)', pending.status === 200 && Array.isArray(pending.body?.data), `status ${pending.status}`);
  if (providerId) {
    const verify = await req('POST', `/admin/providers/${providerId}/verify`, { token: adminToken, body: { decision: 'APPROVE' } });
    check('admin verifies a provider', verify.status === 200, `status ${verify.status}`);
  }

  // Request → publish → offer → accept → job → complete.
  const created = await req('POST', '/requests', {
    token: customer.token,
    body: {
      serviceId, title: `E2E9 request ${stamp}`, budgetMinMinor: 20000, budgetMaxMinor: 60000,
      pickup: { line1: '1 E2E9 Street', cityName: 'Rabat', lat: 34.02, lng: -6.83 },
    },
  });
  const requestId = created.body?.data?.id;
  const publish = await req('POST', `/requests/${requestId}/publish`, { token: customer.token, body: {} });
  check('request published', publish.status === 200, `status ${publish.status}`);

  const offer = await req('POST', '/offers', { token: provider.token, body: { requestId, priceMinor: 28000, message: 'E2E9 offer' } });
  const offerId = offer.body?.data?.id;
  const accept = await req('POST', `/offers/${offerId}/accept`, { token: customer.token, body: {} });
  const jobId = accept.body?.data?.jobId;
  check('offer accepted → job created', accept.status === 201 && Boolean(jobId), `status ${accept.status}`);

  await req('POST', `/jobs/${jobId}/en-route`, { token: provider.token, body: {} });
  await req('POST', `/jobs/${jobId}/arrived`, { token: provider.token, body: {} });
  const otp = await req('POST', `/jobs/${jobId}/start-otp`, { token: customer.token, body: {} });
  const code = otp.body?.data?.otp;
  await req('POST', `/jobs/${jobId}/start`, { token: provider.token, body: { otp: code } });
  const done = await req('POST', `/jobs/${jobId}/complete`, { token: provider.token, body: { note: 'E2E9 done' } });
  check('job driven to COMPLETED', done.status === 200, `status ${done.status}`);

  // --- customer pays ---------------------------------------------------
  const pay = await req('POST', `/payments/job/${jobId}/pay`, { token: customer.token, body: { method: 'CARD' } });
  check('customer pays the job (CAPTURED)', pay.body?.data?.status === 'CAPTURED', `status ${pay.status} ${JSON.stringify(pay.body?.data)}`);
  const paymentId = pay.body?.data?.paymentId;

  const payAgain = await req('POST', `/payments/job/${jobId}/pay`, { token: customer.token, body: { method: 'CARD' } });
  check('paying is idempotent (alreadyPaid)', payAgain.body?.data?.alreadyPaid === true, JSON.stringify(payAgain.body?.data));

  const detail = await req('GET', `/admin/payments/${paymentId}`, { token: adminToken });
  const txns = detail.body?.data?.transactions ?? [];
  check('payment recorded AUTHORIZE + CAPTURE transactions',
    txns.some((t) => t.type === 'AUTHORIZE' && t.status === 'SUCCESS') && txns.some((t) => t.type === 'CAPTURE' && t.status === 'SUCCESS'),
    `status ${detail.status}`);

  // --- provider wallet -------------------------------------------------
  const wallet = await req('GET', '/wallets/me', { token: provider.token });
  const available = Number(wallet.body?.data?.available_minor ?? 0);
  check('provider wallet credited from the ledger', wallet.status === 200 && available > 0, `available ${available}`);

  const ledger = await req('GET', '/wallets/me/transactions', { token: provider.token });
  const earn = (ledger.body?.data ?? []).find((e) => e.type === 'JOB_EARNING');
  check('ledger has a JOB_EARNING credit', Boolean(earn) && earn.direction === 'CREDIT');

  const payout = await req('POST', '/payouts', { token: provider.token, body: { amountMinor: 10000, method: 'BANK_TRANSFER' } });
  check('payout requested (funds reserved)', payout.status === 201, `status ${payout.status}`);
  const payoutId = payout.body?.data?.id;
  const walletAfter = await req('GET', '/wallets/me', { token: provider.token });
  check('requesting a payout moves funds to reserved',
    Number(walletAfter.body?.data?.reserved_minor ?? 0) >= 10000,
    `reserved ${walletAfter.body?.data?.reserved_minor}`);

  const reject = await req('POST', `/admin/payouts/${payoutId}/process`, { token: adminToken, body: { decision: 'REJECT', reason: 'E2E9 missing bank details' } });
  check('admin processes a payout', reject.status === 200, `status ${reject.status}`);
  const walletBack = await req('GET', '/wallets/me', { token: provider.token });
  check('rejected payout returns reserved funds to available',
    Number(walletBack.body?.data?.available_minor ?? 0) === available,
    `available ${walletBack.body?.data?.available_minor} vs ${available}`);

  // --- webhooks --------------------------------------------------------
  const secret = process.env.PAYMENT_WEBHOOK_SECRET ?? 'test-webhook-secret';
  const badRes = await fetch(`${BASE}/payments/webhook/internal-webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bidly-signature': 'deadbeef' },
    body: JSON.stringify({ eventId: `e2e9-bad-${stamp}`, eventType: 'payment.updated', status: 'CAPTURED' }),
  });
  check('webhook rejects a bad signature', badRes.status === 401, `status ${badRes.status}`);

  const eventId = `e2e9-ok-${stamp}`;
  const payload = JSON.stringify({ eventId, eventType: 'payment.updated', providerRef: `int_${paymentId?.replace(/-/g, '').slice(0, 20)}`, status: 'CAPTURED', amountMinor: 28000 });
  const sig = createHmac('sha256', secret).update(payload).digest('hex');
  const okRes = await fetch(`${BASE}/payments/webhook/internal-webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bidly-signature': sig },
    body: payload,
  });
  check('webhook accepts a valid signature', okRes.status === 200, `status ${okRes.status}`);
  const replayRes = await fetch(`${BASE}/payments/webhook/internal-webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bidly-signature': sig },
    body: payload,
  });
  const replayBody = await replayRes.json().catch(() => ({}));
  check('webhook deduplicates a replay', replayBody?.data?.duplicate === true, JSON.stringify(replayBody));

  // --- admin console ---------------------------------------------------
  const stats = await req('GET', '/admin/stats', { token: adminToken });
  check('admin KPIs', stats.status === 200 && typeof stats.body?.data?.active_users === 'number', `status ${stats.status}`);

  const payments = await req('GET', '/admin/payments', { token: adminToken });
  check('admin payments list contains the payment',
    payments.status === 200 && payments.body?.data?.some((p) => p.id === paymentId), `status ${payments.status}`);

  const summary = await req('GET', '/admin/payments/summary', { token: adminToken });
  check('admin payment summary', summary.status === 200 && summary.body?.data != null, `status ${summary.status}`);

  const wallets = await req('GET', '/admin/wallets', { token: adminToken });
  check('admin wallets list', wallets.status === 200 && Array.isArray(wallets.body?.data), `status ${wallets.status}`);
  const walletId = wallets.body?.data?.find((w) => w.owner_email === `e2e9-prov-${stamp}@example.com`)?.id;

  if (walletId) {
    const adjust = await req('POST', `/admin/wallets/${walletId}/adjust`, {
      token: adminToken, body: { direction: 'CREDIT', amountMinor: 500, reason: 'E2E9 goodwill credit' },
    });
    check('admin adjusts a wallet (ledger-backed)', adjust.status === 200, `status ${adjust.status}`);
    const wledger = await req('GET', `/admin/wallets/${walletId}/ledger`, { token: adminToken });
    check('wallet ledger shows the ADJUSTMENT', wledger.body?.data?.entries?.some((e) => e.type === 'ADJUSTMENT'));
  } else {
    check('admin adjusts a wallet (ledger-backed)', false, 'wallet not found');
    check('wallet ledger shows the ADJUSTMENT', false, 'wallet not found');
  }

  const audit = await req('GET', '/admin/audit-log', { token: adminToken });
  check('admin audit log has a recorded action',
    audit.status === 200 && audit.body?.data?.some((a) => ['ADJUST_WALLET', 'APPROVE_PROVIDER', 'PAYOUT_REJECT'].includes(a.action)),
    `status ${audit.status}`);

  const requests = await req('GET', '/admin/requests', { token: adminToken });
  check('admin requests list', requests.status === 200 && Array.isArray(requests.body?.data), `status ${requests.status}`);

  const services = await req('GET', '/admin/services', { token: adminToken });
  const svcId = services.body?.data?.[0]?.id;
  check('admin services list', services.status === 200 && Array.isArray(services.body?.data), `status ${services.status}`);
  if (svcId) {
    const patch = await req('PATCH', `/admin/services/${svcId}`, { token: adminToken, body: { isActive: true } });
    check('admin updates a service', patch.status === 200, `status ${patch.status}`);
  }

  const denied = await req('GET', '/admin/stats', { token: customer.token });
  check('non-admin is denied the console', denied.status === 403, `status ${denied.status}`);

  return finish();
}

function finish() {
  console.log(`\n${pass} passed, ${fail} failed${failures.length ? ' — ' + failures.join(', ') : ''}\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  finish();
});

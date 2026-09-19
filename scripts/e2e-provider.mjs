#!/usr/bin/env node
/**
 * Provider interface live E2E (task 7).
 *
 * Drives every requirement against a real running API server and PostgreSQL,
 * over HTTP, exactly as the browser would. Run:
 *   node scripts/e2e-provider.mjs [baseUrl]
 */

const BASE = (process.argv[2] ?? 'http://127.0.0.1:4000') + '/api/v1';

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
  try {
    json = await res.json();
  } catch {
    /* 204 */
  }
  return { status: res.status, body: json };
}

const stamp = Date.now();
const password = 'Str0ngPass1';

// Dev mode logs the verification code instead of sending mail; read it back so
// the script can complete signup without an inbox.
import { readFileSync } from 'node:fs';

function codeFor(email) {
  for (const path of ['/tmp/bcode/api2.log', '/tmp/bcode/api.log']) {
    try {
      const log = readFileSync(path, 'utf8');
      const lines = log.split('\n').filter((l) => l.includes(email));
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/code is (\d+)/);
        if (m) return m[1];
      }
    } catch {
      /* log not present */
    }
  }
  return null;
}

async function register(kind, email) {
  await req('POST', '/register', { body: { email, password, fullName: 'E2E', role: kind } });
  await new Promise((r) => setTimeout(r, 300));
  const code = codeFor(email) ?? process.env.E2E_OTP;
  if (code) await req('POST', '/verify-email', { body: { email, code } });
  const login = await req('POST', '/login', { body: { identifier: email, password } });
  return login.body?.data?.accessToken ?? '';
}

async function main() {
  console.log(`\nBIDLY provider interface E2E → ${BASE}\n`);

  const health = await fetch(BASE.replace(/\/api\/v1$/, '') + '/health/ready');
  check('API is reachable', health.status === 200, `status ${health.status}`);

  const provEmail = `e2e-prov-${stamp}@example.com`;
  const custEmail = `e2e-cust-${stamp}@example.com`;
  const otherEmail = `e2e-other-${stamp}@example.com`;

  const provToken = await register('PROVIDER', provEmail);
  const otherToken = await register('PROVIDER', otherEmail);
  const custToken = await register('CUSTOMER', custEmail);
  check('provider can log in', provToken.length > 0);
  check('customer can log in', custToken.length > 0);

  // 1 + 9 — profile
  const before = await req('GET', '/providers/me', { token: provToken });
  check('provider has no profile yet (404)', before.status === 404);
  const created = await req('POST', '/providers', {
    token: provToken,
    body: { displayName: `E2E Plumbing ${stamp}`, bio: 'e2e', serviceRadiusKm: 20 },
  });
  check('provider profile created', created.status === 201, `status ${created.status}`);

  const svc = await req('GET', '/services?limit=1', { token: provToken });
  const serviceId = svc.body?.data?.[0]?.id;
  check('catalogue service available', Boolean(serviceId));

  const addSvc = await req('PUT', '/providers/me/services', {
    token: provToken,
    body: { serviceId, isActive: true, minPriceMinor: 1000, maxPriceMinor: 900000 },
  });
  check('provider activates a service', [200, 201].includes(addSvc.status), `status ${addSvc.status}`);

  // 9 — coverage area
  const area = await req('POST', '/providers/me/areas', { token: provToken, body: { radiusKm: 25 } });
  check('provider adds a coverage area', area.status === 201, `status ${area.status}`);

  // 2 — availability
  const on = await req('PATCH', '/providers/me', { token: provToken, body: { isOnline: true, isAvailable: true } });
  check('provider goes online', on.body?.data?.is_online === true);
  const reread = await req('GET', '/providers/me', { token: provToken });
  check('online flag persisted in the database', reread.body?.data?.is_online === true);
  const slot = await req('PUT', '/providers/me/availability', {
    token: provToken,
    body: { weekday: 2, startTime: '08:00', endTime: '17:00', period: 'DAY' },
  });
  check('weekly availability slot saved', [200, 201].includes(slot.status), `status ${slot.status}`);

  // 12 — authorization
  const custFeed = await req('GET', '/requests/feed', { token: custToken });
  check('customer blocked from provider feed (403)', custFeed.status === 403, `status ${custFeed.status}`);
  const custOffers = await req('GET', '/offers/mine', { token: custToken });
  check('customer blocked from provider offers (403)', custOffers.status === 403, `status ${custOffers.status}`);
  const anon = await req('GET', '/requests/feed');
  check('feed requires authentication (401)', anon.status === 401, `status ${anon.status}`);

  // Feed needs an ACTIVE provider; activation is an admin step (task 10).
  console.log('  (activating provider via DB fixture — admin verification is task 10)');
  const { execSync } = await import('node:child_process');
  try {
    execSync(
      `psql "postgresql://postgres@127.0.0.1:55432/bidly_test" -c "update providers set status='ACTIVE', verification_status='VERIFIED', verified_at=now() where user_id=(select id from users where email='${provEmail}')"`,
      { stdio: 'ignore' },
    );
  } catch {
    /* psql may be absent; the offer test below reports the consequence */
  }

  // 3 + 4 — request feed + detail
  const create = await req('POST', '/requests', {
    token: custToken,
    body: {
      serviceId,
      title: `E2E job ${stamp}`,
      description: 'e2e provider flow',
      budgetMinMinor: 20000,
      budgetMaxMinor: 60000,
      pickup: { line1: '9 E2E Ave', cityName: 'Rabat', lat: 34.02, lng: -6.83 },
    },
  });
  const requestId = create.body?.data?.id;
  check('customer creates a request', Boolean(requestId), JSON.stringify(create.body?.error ?? {}).slice(0, 120));
  await req('POST', `/requests/${requestId}/publish`, { token: custToken, body: {} });

  const feed = await req('GET', '/requests/feed?limit=50', { token: provToken });
  const inFeed = (feed.body?.data?.items ?? []).some((r) => r.id === requestId);
  check('eligible request appears in the provider feed', inFeed);
  const detail = await req('GET', `/requests/${requestId}`, { token: provToken });
  check('provider opens the request detail', detail.status === 200, `status ${detail.status}`);

  // 5 — offer + duplicate prevention
  const offer = await req('POST', '/offers', {
    token: provToken,
    body: { requestId, priceMinor: 30000, message: 'today', etaMinutes: 30 },
  });
  const offerId = offer.body?.data?.id;
  check('provider submits an offer', offer.status === 201, `status ${offer.status}`);
  const dup = await req('POST', '/offers', { token: provToken, body: { requestId, priceMinor: 31000 } });
  check('duplicate offer rejected (409)', dup.status === 409, `status ${dup.status}`);
  const mineOffers = await req('GET', '/offers/mine?limit=50', { token: provToken });
  check('provider sees their own offer', (mineOffers.body?.data?.items ?? []).some((o) => o.id === offerId));
  const feedAfter = await req('GET', '/requests/feed?limit=50', { token: provToken });
  check(
    'offered request leaves the feed',
    !(feedAfter.body?.data?.items ?? []).some((r) => r.id === requestId),
  );

  // cross-provider isolation: the other provider cannot see this offer
  const otherOffers = await req('GET', '/offers/mine?limit=50', { token: otherToken });
  check(
    'another provider cannot see this offer',
    !(otherOffers.body?.data?.items ?? []).some((o) => o.id === offerId),
  );

  // 6 — assignment
  const accept = await req('POST', `/offers/${offerId}/accept`, { token: custToken, body: {} });
  const jobId = accept.body?.data?.jobId;
  check('customer accepts; job created and provider assigned', Boolean(jobId), `status ${accept.status}`);

  // 8 — history
  const jobs = await req('GET', '/jobs/mine?role=provider&limit=50', { token: provToken });
  const job = (jobs.body?.data?.items ?? []).find((j) => j.id === jobId);
  check('assigned job appears in provider history', Boolean(job));
  check('job status is CONFIRMED after assignment', job?.status === 'CONFIRMED', `status ${job?.status}`);
  const otherJobs = await req('GET', '/jobs/mine?role=provider&limit=50', { token: otherToken });
  check(
    'another provider cannot see this job',
    !(otherJobs.body?.data?.items ?? []).some((j) => j.id === jobId),
  );

  // 7 — status transitions
  const enRoute = await req('POST', `/jobs/${jobId}/en-route`, { token: provToken, body: {} });
  check('transition CONFIRMED → PROVIDER_EN_ROUTE', enRoute.body?.data?.status === 'PROVIDER_EN_ROUTE');
  const arrived = await req('POST', `/jobs/${jobId}/arrived`, { token: provToken, body: {} });
  check('transition EN_ROUTE → PROVIDER_ARRIVED', arrived.body?.data?.status === 'PROVIDER_ARRIVED');
  const custArrived = await req('POST', `/jobs/${jobId}/arrived`, { token: custToken, body: {} });
  check('customer cannot drive provider transitions (403)', custArrived.status === 403, `status ${custArrived.status}`);
  const otp = await req('POST', `/jobs/${jobId}/start-otp`, { token: custToken, body: {} });
  const code = otp.body?.data?.otp;
  check('customer issues a start code', typeof code === 'string' && code.length >= 4);
  const badStart = await req('POST', `/jobs/${jobId}/start`, { token: provToken, body: { otp: '000000' } });
  check('wrong start code rejected', badStart.status >= 400, `status ${badStart.status}`);
  const started = await req('POST', `/jobs/${jobId}/start`, { token: provToken, body: { otp: code } });
  check('transition ARRIVED → IN_PROGRESS with the real code', started.body?.data?.status === 'IN_PROGRESS');
  const completed = await req('POST', `/jobs/${jobId}/complete`, { token: provToken, body: { note: 'e2e done' } });
  check('transition IN_PROGRESS → COMPLETED', completed.body?.data?.status === 'COMPLETED');
  const backToWork = await req('POST', `/jobs/${jobId}/start`, { token: provToken, body: { otp: code } });
  check('illegal transition from COMPLETED rejected', backToWork.status >= 400, `status ${backToWork.status}`);

  // 9 — documents
  const doc = await req('POST', '/providers/me/documents', {
    token: provToken,
    body: { type: 'IDENTITY', fileUrl: 'https://example.com/id.png' },
  });
  check('provider submits a verification document', doc.status === 201, `status ${doc.status}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('E2E crashed:', err);
  process.exit(1);
});

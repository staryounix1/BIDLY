/**
 * Live E2E for the map work: map coordinates on a request, provider location
 * publishing, the nearby search, and the Web Push public key.
 *
 * Run against a real server + real Postgres:
 *   node scripts/e2e-map.mjs http://127.0.0.1:4100
 */
import { readFileSync } from 'node:fs';

const BASE = (process.argv[2] ?? 'http://127.0.0.1:4100').replace(/\/$/, '');
const API = `${BASE}/api/v1`;
const LOG = '/tmp/bcode/api-map.log';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
};

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body (e.g. 204) */
  }
  return { status: res.status, json, text };
}

/** The API logs the dev verification code; read it back instead of emailing. */
function codeFor(email) {
  const log = readFileSync(LOG, 'utf8');
  const lines = log.split('\n').filter((l) => l.includes(email) && l.includes('code is'));
  const last = lines[lines.length - 1] ?? '';
  const m = last.match(/code is (\d{6})/);
  return m?.[1] ?? null;
}

const stamp = Date.now();
const customerEmail = `map-cust-${stamp}@bidly.test`;
const providerEmail = `map-prov-${stamp}@bidly.test`;
// Phones are unique across the whole table, so derive them from the run stamp
// instead of hardcoding — otherwise the second run collides with the first.
const suffix = String(stamp).slice(-8);
const customerPhone = `+2126${suffix}1`;
const providerPhone = `+2126${suffix}2`;
const PASSWORD = 'BidlyDev!2026';
const CASABLANCA = { lat: 33.5731, lng: -7.5898 };

async function register(email, role, fullName, phone) {
  const r = await call('POST', '/register', {
    body: { email, password: PASSWORD, fullName, phone, role, locale: 'ar' },
  });
  if (r.status !== 201 && r.status !== 200) return { error: r.text.slice(0, 200) };
  const code = codeFor(email);
  if (code) await call('POST', '/verify-email', { body: { email, code } });
  const login = await call('POST', '/login', { body: { identifier: email, password: PASSWORD } });
  return { token: login.json?.data?.accessToken, userId: login.json?.data?.user?.id };
}

console.log('BIDLY map / geo E2E');
console.log('---');

// 1. Web Push public key
{
  const r = await call('GET', '/push/public-key');
  ok('push public key is served', r.status === 200 && typeof r.json?.data?.publicKey === 'string');
  ok('push reports enabled for webpush', r.json?.data?.enabled === true);
}

// 2. Accounts
const customer = await register(customerEmail, 'CUSTOMER', 'Map Customer', customerPhone);
ok('customer registered and logged in', !!customer.token, JSON.stringify(customer).slice(0, 200));

const provider = await register(providerEmail, 'PROVIDER', 'Map Provider', providerPhone);
ok('provider registered and logged in', !!provider.token, JSON.stringify(provider).slice(0, 200));

if (!customer.token || !provider.token) {
  console.log('\nABORT: could not create accounts');
  process.exit(1);
}

// 3. Provider profile + ONLINE. Activation (status ACTIVE) is an admin
//    verification step, so the fixture flips it directly in SQL — the same
//    approach the other suites use.
{
  const r = await call('POST', '/providers', {
    token: provider.token,
    body: { displayName: 'Map Provider', serviceRadiusKm: 30 },
  });
  ok('provider profile created', r.status === 201 || r.status === 200, r.text.slice(0, 200));

  const patch = await call('PATCH', '/providers/me', {
    token: provider.token,
    body: { isOnline: true, isAvailable: true, serviceRadiusKm: 30 },
  });
  ok('provider set online', patch.status === 200, patch.text.slice(0, 200));
}

// The nearby query only returns ACTIVE providers; act as the admin would.
{
  const { execSync } = await import('node:child_process');
  execSync(
    `psql "postgresql://postgres@127.0.0.1:55432/bidly_test" -q -c "update providers set status='ACTIVE' where user_id='${provider.userId}'"`,
    { stdio: 'ignore' },
  );
  const me = await call('GET', '/providers/me', { token: provider.token });
  ok('provider is ACTIVE for the nearby search', me.json?.data?.status === 'ACTIVE',
    `status=${me.json?.data?.status}`);
}

// 4. Provider publishes a location
let providerId = null;
{
  const me = await call('GET', '/providers/me', { token: provider.token });
  providerId = me.json?.data?.id ?? null;
  ok('provider id resolved', !!providerId);

  const loc = await call('POST', '/providers/me/location', {
    token: provider.token,
    body: { lat: CASABLANCA.lat + 0.01, lng: CASABLANCA.lng + 0.01, accuracyM: 12 },
  });
  ok('provider published a location', loc.status === 201, loc.text.slice(0, 200));

  const read = await call('GET', `/providers/${providerId}/location`);
  ok('location is readable back', read.status === 200 && read.json?.data?.lat != null, read.text.slice(0, 200));
}

// 5. Second ping supersedes the first (is_current stays unique)
{
  const first = await call('GET', `/providers/${providerId}/location`);
  const before = first.json?.data?.lat;
  await call('POST', '/providers/me/location', {
    token: provider.token,
    body: { lat: CASABLANCA.lat + 0.02, lng: CASABLANCA.lng + 0.02 },
  });
  const second = await call('GET', `/providers/${providerId}/location`);
  const after = second.json?.data?.lat;
  ok('second ping replaces the current location', before != null && after != null && after !== before,
    `${before} -> ${after}`);
}

// 6. Nearby search finds the provider
{
  const r = await call('GET', `/providers/nearby?lat=${CASABLANCA.lat}&lng=${CASABLANCA.lng}&radiusKm=25`);
  ok('nearby search succeeds', r.status === 200, r.text.slice(0, 200));
  const list = r.json?.data?.providers ?? [];
  ok('nearby search returns the provider', list.some((p) => p.id === providerId),
    `got ${list.length} providers`);
  const found = list.find((p) => p.id === providerId);
  ok('nearby result carries a distance', found != null && Number.isFinite(Number(found.distance_km)),
    JSON.stringify(found).slice(0, 200));
  ok('nearby result carries coordinates', found != null && found.lat != null && found.lng != null);
}

// 7. A far-away search excludes them
{
  const r = await call('GET', '/providers/nearby?lat=48.8566&lng=2.3522&radiusKm=5');
  const list = r.json?.data?.providers ?? [];
  ok('distant search excludes the provider', !list.some((p) => p.id === providerId));
}

// 8. Nearby requires coordinates
{
  const r = await call('GET', '/providers/nearby');
  ok('nearby rejects a missing point', r.status === 400, `status ${r.status}`);
  const bad = await call('GET', '/providers/nearby?lat=999&lng=0');
  ok('nearby rejects an out-of-range latitude', bad.status === 400, `status ${bad.status}`);
}

// 9. Request carries map coordinates through create + detail
{
  // `GET /services` returns a bare array in `data`.
  const svc = await call('GET', '/services?limit=50');
  const all = Array.isArray(svc.json?.data) ? svc.json.data : (svc.json?.data?.services ?? []);
  const service = all.find((s) => s.requires_location) ?? all[0];
  ok('a service is available to request', !!service, `got ${all.length} services`);

  // Fill the service's own dynamic form so the request passes validation.
  const form = await call('GET', `/services/${service.slug}/form`);
  const fields = form.json?.data?.fields ?? [];
  const answers = {};
  for (const f of fields) {
    if (!f.is_required) continue;
    answers[f.key] = f.key === 'address' ? 'Boulevard Zerktouni, Maarif' : 'a'.repeat(20);
  }

  const created = await call('POST', '/requests', {
    token: customer.token,
    body: {
      serviceId: service.id,
      title: 'Map coordinate test',
      answers,
      urgency: 'NORMAL',
      pickup: {
        line1: 'Boulevard Zerktouni',
        district: 'Maarif',
        lat: CASABLANCA.lat,
        lng: CASABLANCA.lng,
      },
    },
  });
  ok('request created with coordinates', created.status === 201, created.text.slice(0, 250));

  const id = created.json?.data?.id;
  if (id) {
    const detail = await call('GET', `/requests/${id}`, { token: customer.token });
    const req = detail.json?.data?.request;
    ok('request detail returns pickup_lat', Number(req?.pickup_lat) === CASABLANCA.lat,
      `lat=${req?.pickup_lat}`);
    ok('request detail returns pickup_lng', Number(req?.pickup_lng) === CASABLANCA.lng,
      `lng=${req?.pickup_lng}`);

    const pub = await call('POST', `/requests/${id}/publish`, { token: customer.token, body: {} });
    ok('request publishes (matching starts)', pub.status === 200, pub.text.slice(0, 200));
  }
}

// 10. Device registration + removal (the push subscription path)
{
  const sub = JSON.stringify({
    endpoint: 'https://fcm.googleapis.com/fcm/send/fake-endpoint-for-test',
    keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) },
  });
  const reg = await call('POST', '/users/me/devices', {
    token: customer.token,
    body: { pushToken: sub, platform: 'WEB' },
  });
  ok('device subscription stored', reg.status === 201, reg.text.slice(0, 200));
  ok('a long serialised subscription is accepted', !!reg.json?.data?.id);

  const del = await call('POST', '/users/me/devices/remove', {
    token: customer.token,
    body: { pushToken: sub },
  });
  ok('device can be unsubscribed', del.status === 200 && del.json?.data?.removed === true,
    del.text.slice(0, 200));
}

console.log('---');
console.log(`passed ${pass}, failed ${fail}`);
process.exit(fail === 0 ? 0 : 1);

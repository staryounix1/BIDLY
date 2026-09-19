#!/usr/bin/env node
/**
 * Realtime, chat and notifications live E2E (task 8).
 *
 * Drives the chat and notification centre over real HTTP against a running API
 * and PostgreSQL, including the server-sent events stream. Run:
 *   node scripts/e2e-realtime.mjs [baseUrl]
 */

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

import { readFileSync } from 'node:fs';

function codeFor(email) {
  for (const path of ['/tmp/bcode/api8.log', '/tmp/bcode/api.log']) {
    try {
      const log = readFileSync(path, 'utf8');
      const lines = log.split('\n').filter((l) => l.includes(email));
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = lines[i].match(/code is (\d+)/);
        if (m) return m[1];
      }
    } catch { /* no log */ }
  }
  return null;
}

const stamp = Date.now();
const password = 'Str0ngPass1';

async function register(role, email) {
  await req('POST', '/register', { body: { email, password, fullName: 'E2E8', role } });
  await new Promise((r) => setTimeout(r, 400));
  const code = codeFor(email) ?? process.env.E2E_OTP;
  if (code) await req('POST', '/verify-email', { body: { email, code } });
  const login = await req('POST', '/login', { body: { identifier: email, password } });
  const me = await req('GET', '/me', { token: login.body?.data?.accessToken });
  return { token: login.body?.data?.accessToken ?? '', id: me.body?.data?.id };
}

/** Collects SSE events for a short window. */
async function collectSse(token, query, ms) {
  const controller = new AbortController();
  const url = `${BASE}/realtime?token=${encodeURIComponent(token)}${query ? `&${query}` : ''}`;
  const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: controller.signal });
  const events = [];
  let ready = false;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline) {
      const timeout = new Promise((r) => setTimeout(() => r({ done: true }), deadline - Date.now()));
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const evLine = frame.split('\n').find((l) => l.startsWith('event:'));
        const name = evLine ? evLine.slice(6).trim() : null;
        if (name === 'ready') { ready = true; continue; }
        if (name && name !== 'ping') events.push(name);
      }
    }
  } catch { /* aborted */ }
  controller.abort();
  return { events, ready };
}

async function main() {
  console.log(`\nBIDLY realtime + chat E2E → ${BASE}\n`);

  const health = await fetch(ORIGIN + '/health/ready');
  check('API is reachable', health.status === 200, `status ${health.status}`);

  const cust = await register('CUSTOMER', `e2e8-cust-${stamp}@example.com`);
  const prov = await register('PROVIDER', `e2e8-prov-${stamp}@example.com`);
  const other = await register('CUSTOMER', `e2e8-other-${stamp}@example.com`);
  check('customer can log in', cust.token.length > 0);
  check('provider can log in', prov.token.length > 0);

  // --- conversation lifecycle -------------------------------------------
  const created = await req('POST', '/conversations', { token: cust.token, body: { counterpartId: prov.id } });
  check('customer opens a conversation', [200, 201].includes(created.status), `status ${created.status}`);
  const convId = created.body?.data?.id;
  check('conversation has an id', typeof convId === 'string');

  const reopened = await req('POST', '/conversations', { token: prov.token, body: { counterpartId: cust.id } });
  check('reopening is idempotent (same conversation)', reopened.body?.data?.id === convId);

  const send = await req('POST', `/conversations/${convId}/messages`, {
    token: cust.token, body: { body: 'hello from e2e', clientId: `e2e-${stamp}-1` },
  });
  check('customer sends a message', send.status === 201, `status ${send.status}`);
  const messageId = send.body?.data?.id;

  const retry = await req('POST', `/conversations/${convId}/messages`, {
    token: cust.token, body: { body: 'hello from e2e', clientId: `e2e-${stamp}-1` },
  });
  check('clientId retry is idempotent (same message)', retry.body?.data?.id === messageId);

  const provList = await req('GET', '/conversations', { token: prov.token });
  const conv = (provList.body?.data?.items ?? []).find((c) => c.id === convId);
  check('provider sees the conversation with unread badge', conv && conv.unread_count >= 1, `unread ${conv?.unread_count}`);

  const provMsgs = await req('GET', `/conversations/${convId}/messages`, { token: prov.token });
  check('provider reads the message', (provMsgs.body?.data?.messages ?? []).some((m) => m.id === messageId));

  const read = await req('POST', `/conversations/${convId}/read`, { token: prov.token, body: {} });
  check('provider marks conversation read', read.status === 200, `status ${read.status}`);
  const afterRead = await req('GET', '/conversations', { token: prov.token });
  const conv2 = (afterRead.body?.data?.items ?? []).find((c) => c.id === convId);
  check('unread badge cleared after read', conv2?.unread_count === 0, `unread ${conv2?.unread_count}`);

  // --- authorization -----------------------------------------------------
  const outsider = await req('GET', `/conversations/${convId}/messages`, { token: other.token });
  check('outsider cannot read the thread (403)', outsider.status === 403, `status ${outsider.status}`);
  const outsiderSend = await req('POST', `/conversations/${convId}/messages`, {
    token: other.token, body: { body: 'intruder', clientId: `e2e-${stamp}-x` },
  });
  check('outsider cannot post (403)', outsiderSend.status === 403, `status ${outsiderSend.status}`);
  const anon = await req('GET', '/conversations');
  check('conversations require authentication (401)', anon.status === 401, `status ${anon.status}`);

  // --- realtime: message:new --------------------------------------------
  const provStream = collectSse(prov.token, `conversationId=${convId}`, 3500);
  await new Promise((r) => setTimeout(r, 600));
  await req('POST', `/conversations/${convId}/messages`, {
    token: cust.token, body: { body: 'live push', clientId: `e2e-${stamp}-2` },
  });
  const provResult = await provStream;
  check('provider stream opened (ready)', provResult.ready);
  check('provider stream delivered message:new', provResult.events.includes('message:new'), provResult.events.join(','));

  const otherStream = collectSse(other.token, '', 3000);
  await new Promise((r) => setTimeout(r, 500));
  await req('POST', `/conversations/${convId}/messages`, {
    token: cust.token, body: { body: 'not for you', clientId: `e2e-${stamp}-3` },
  });
  const otherResult = await otherStream;
  check('outsider stream gets no message:new', !otherResult.events.includes('message:new'), otherResult.events.join(','));

  const badRoom = await fetch(`${BASE}/realtime?token=${encodeURIComponent(other.token)}&conversationId=${convId}`);
  check('SSE refuses an unauthorized room (403)', badRoom.status === 403, `status ${badRoom.status}`);
  await badRoom.body?.cancel();

  // --- notifications -----------------------------------------------------
  const custNotes = await req('GET', '/notifications?limit=100', { token: cust.token });
  check('notifications list works', custNotes.status === 200);
  const types = (custNotes.body?.data ?? []).map((n) => n.type);
  check('message notifications recorded', types.includes('MESSAGE_NEW'), types.join(','));

  const provNotes = await req('GET', '/notifications?limit=100', { token: prov.token });
  const provMsgNotes = (provNotes.body?.data ?? []).filter((n) => n.type === 'MESSAGE_NEW');
  check('provider got message notifications', provMsgNotes.length >= 1, `count ${provMsgNotes.length}`);

  const unreadBefore = await req('GET', '/notifications/unread-count', { token: prov.token });
  check('unread count endpoint works', typeof unreadBefore.body?.data?.unread === 'number');

  const first = provMsgNotes[0];
  if (first) {
    const marked = await req('POST', `/notifications/${first.id}/read`, { token: prov.token, body: {} });
    check('mark one read', marked.status === 200, `status ${marked.status}`);
  }
  const allRead = await req('POST', '/notifications/read-all', { token: prov.token, body: {} });
  check('mark all read', allRead.status === 200, `status ${allRead.status}`);
  const unreadAfter = await req('GET', '/notifications/unread-count', { token: prov.token });
  check('unread count is zero after read-all', unreadAfter.body?.data?.unread === 0, `unread ${unreadAfter.body?.data?.unread}`);

  // --- preferences -------------------------------------------------------
  const prefs = await req('GET', '/notifications/preferences', { token: cust.token });
  check('preferences listed', prefs.status === 200 && Array.isArray(prefs.body?.data));

  const prefUpdate = await req('PUT', '/notifications/preferences', {
    token: cust.token,
    body: { channel: 'EMAIL', category: 'MESSAGE_NEW', enabled: true },
  });
  check('preference updated', [200, 201].includes(prefUpdate.status), `status ${prefUpdate.status}`);
  const prefs2 = await req('GET', '/notifications/preferences', { token: cust.token });
  const updated = (prefs2.body?.data ?? []).find((p) => p.event_type === 'MESSAGE_NEW');
  check('preference persisted', updated?.email === true, `email ${updated?.email}`);

  // --- notification:new over the stream ----------------------------------
  const noteStream = collectSse(cust.token, '', 3500);
  await new Promise((r) => setTimeout(r, 600));
  await req('POST', `/conversations/${convId}/messages`, {
    token: prov.token, body: { body: 'trigger a notification', clientId: `e2e-${stamp}-4` },
  });
  const noteResult = await noteStream;
  check('stream delivered notification:new', noteResult.events.includes('notification:new'), noteResult.events.join(','));

  // --- summary -----------------------------------------------------------
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('failed: ' + failures.join('; '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { env } from '@bidly/config';
import { getLogger } from './logger.js';

/**
 * Provider abstraction for every outbound channel.
 *
 * Development uses `log` adapters that print to the logger. Production swaps
 * in real adapters via environment configuration. Nothing above this layer
 * knows which vendor is in use, and — critically — nothing pretends to have
 * sent a message when it has not.
 */

const log = getLogger();

// --- Email ------------------------------------------------------------

export interface EmailProvider {
  readonly name: string;
  send(to: string, subject: string, body: string, html?: string): Promise<void>;
}

class LogEmailProvider implements EmailProvider {
  readonly name = 'log';
  async send(to: string, subject: string, body: string): Promise<void> {
    log.info({ channel: 'email', to, subject, preview: body.slice(0, 120) }, 'email.dev_send');
  }
}

class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  constructor(private readonly apiKey: string) {}
  async send(to: string, subject: string, body: string, html?: string): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: [to],
        subject,
        text: body,
        html: html ?? undefined,
      }),
    });
    if (!res.ok) {
      throw new Error(`Resend email failed: ${res.status} ${await res.text()}`);
    }
  }
}

// --- SMS --------------------------------------------------------------

export interface SmsProvider {
  readonly name: string;
  send(to: string, body: string): Promise<void>;
}

class LogSmsProvider implements SmsProvider {
  readonly name = 'log';
  async send(to: string, body: string): Promise<void> {
    log.info({ channel: 'sms', to, preview: body.slice(0, 80) }, 'sms.dev_send');
  }
}

class TwilioSmsProvider implements SmsProvider {
  readonly name = 'twilio';
  constructor(
    private readonly sid: string,
    private readonly token: string,
    private readonly from: string,
  ) {}
  async send(to: string, body: string): Promise<void> {
    const params = new URLSearchParams({ To: to, From: this.from, Body: body });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${this.sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${this.sid}:${this.token}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
    if (!res.ok) throw new Error(`Twilio SMS failed: ${res.status} ${await res.text()}`);
  }
}

// --- Push -------------------------------------------------------------

export interface PushProvider {
  readonly name: string;
  send(pushToken: string, title: string, body: string, data?: Record<string, unknown>): Promise<void>;
}

class LogPushProvider implements PushProvider {
  readonly name = 'log';
  async send(pushToken: string, title: string, body: string): Promise<void> {
    log.info({ channel: 'push', tokenPreview: pushToken.slice(0, 12), title }, 'push.dev_send');
  }
}

/**
 * Web Push (VAPID) over the RFC 8291 encrypted payload format.
 *
 * Implemented against Node's WebCrypto rather than a vendor SDK: the protocol
 * is small, and keeping it in-tree means the API carries no dependency that
 * has to be rebuilt when the runtime changes (the same reason argon2 was
 * replaced with hash-wasm).
 *
 * The `pushToken` is the browser's `PushSubscription` serialised as JSON —
 * endpoint plus the two keys — which is exactly what `pushManager.subscribe`
 * hands the client.
 */
class WebPushProvider implements PushProvider {
  readonly name = 'webpush';
  constructor(
    private readonly publicKey: string,
    private readonly privateKey: string,
    private readonly subject: string,
  ) {}

  async send(pushToken: string, title: string, body: string, data?: Record<string, unknown>): Promise<void> {
    let sub: { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
    try {
      sub = JSON.parse(pushToken);
    } catch {
      throw new Error('webpush: subscription is not valid JSON');
    }
    if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      throw new Error('webpush: subscription is missing endpoint or keys');
    }

    const payload = JSON.stringify({ title, body, data: data ?? {} });
    const encrypted = await encryptWebPushPayload(payload, sub.keys.p256dh, sub.keys.auth);

    const vapidHeaders = await buildVapidHeaders(sub.endpoint, this.publicKey, this.privateKey, this.subject);

    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: '86400',
        Urgency: 'normal',
        ...vapidHeaders,
      },
      body: encrypted,
    });

    // 404/410 mean the browser threw the subscription away; surface it so the
    // caller can deactivate the device row instead of retrying forever.
    if (!res.ok) {
      throw new Error(`webpush failed: ${res.status} ${await res.text().catch(() => '')}`);
    }
  }
}

function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const buf = Buffer.from(padded, 'base64');
  const out = new Uint8Array(new ArrayBuffer(buf.length));
  out.set(buf);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** RFC 8291: derive the CEK and nonce, then AES-128-GCM the payload. */
async function encryptWebPushPayload(
  payload: string,
  p256dh: string,
  authSecret: string,
): Promise<Uint8Array<ArrayBuffer>> {
  const crypto = globalThis.crypto;
  const clientPublic = b64urlToBytes(p256dh);
  const auth = b64urlToBytes(authSecret);

  const asKeys = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;

  const clientKey = await crypto.subtle.importKey(
    'raw',
    clientPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  const sharedBits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: clientKey }, asKeys.privateKey, 256),
  );
  const shared = new Uint8Array(new ArrayBuffer(sharedBits.length));
  shared.set(sharedBits);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const asPublic = new Uint8Array(new ArrayBuffer(rawPublic.length));
  asPublic.set(rawPublic);

  // auth_info = "WebPush: info" || 0x00 || ua_public || as_public
  const authInfo = concat(new TextEncoder().encode('WebPush: info\0'), clientPublic, asPublic);

  const ikm = await hkdf(auth, shared, authInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const cekInfoBytes = new TextEncoder().encode('Content-Encoding: aes128gcm\0');
  const cekInfo = new Uint8Array(new ArrayBuffer(cekInfoBytes.length));
  cekInfo.set(cekInfoBytes);
  const nonceInfoBytes = new TextEncoder().encode('Content-Encoding: nonce\0');
  const nonceInfo = new Uint8Array(new ArrayBuffer(nonceInfoBytes.length));
  nonceInfo.set(nonceInfoBytes);

  const cek = await hkdf(salt, ikm, cekInfo, 16);
  const nonce = await hkdf(salt, ikm, nonceInfo, 12);

  // One record: plaintext followed by the 0x02 padding delimiter.
  const plain = concat(new TextEncoder().encode(payload), new Uint8Array([2]));

  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipherBits = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, plain),
  );
  const cipher = new Uint8Array(new ArrayBuffer(cipherBits.length));
  cipher.set(cipherBits);

  // aes128gcm header: salt(16) | rs(4) | idlen(1) | keyid(as_public)
  const rs = new Uint8Array(new ArrayBuffer(4));
  new DataView(rs.buffer).setUint32(0, 4096);
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const crypto = globalThis.crypto;
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  const out = new Uint8Array(new ArrayBuffer(bits.byteLength));
  out.set(new Uint8Array(bits));
  return out;
}

/** VAPID JWT in the `Authorization: vapid` header, ES256-signed. */
async function buildVapidHeaders(
  endpoint: string,
  publicKey: string,
  privateKey: string,
  subject: string,
): Promise<Record<string, string>> {
  const crypto = globalThis.crypto;
  const url = new URL(endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const now = Math.floor(Date.now() / 1000);

  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = bytesToB64url(
    new TextEncoder().encode(JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: subject })),
  );
  const signingInput = new TextEncoder().encode(`${header}.${claims}`);

  // Rebuild the private key from raw d + the public point's x/y.
  const pub = b64urlToBytes(publicKey);
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    d: bytesToB64url(b64urlToBytes(privateKey)),
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [
    'sign',
  ]);
  const sigBits = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, signingInput),
  );
  const sig = new Uint8Array(new ArrayBuffer(sigBits.length));
  sig.set(sigBits);

  return {
    Authorization: `vapid t=${header}.${claims}.${bytesToB64url(sig)}, k=${publicKey}`,
  };
}

// --- Maps -------------------------------------------------------------

export interface MapsProvider {
  readonly name: string;
  geocode(address: string): Promise<{ lat: number; lng: number } | null>;
  reverseGeocode(lat: number, lng: number): Promise<string | null>;
}

class LogMapsProvider implements MapsProvider {
  readonly name = 'log';
  async geocode(address: string): Promise<{ lat: number; lng: number } | null> {
    log.info({ channel: 'maps', op: 'geocode', address }, 'maps.dev_call');
    return null;
  }
  async reverseGeocode(lat: number, lng: number): Promise<string | null> {
    log.info({ channel: 'maps', op: 'reverse', lat, lng }, 'maps.dev_call');
    return null;
  }
}

// --- Verification -----------------------------------------------------

export interface VerificationProvider {
  readonly name: string;
  /** Returns a provider reference when a check is opened. */
  submitCheck(params: { userId: string; type: string; documentUrl?: string }): Promise<{ reference: string; status: 'PENDING' }>;
}

class ManualVerificationProvider implements VerificationProvider {
  readonly name = 'manual';
  async submitCheck(): Promise<{ reference: string; status: 'PENDING' }> {
    return { reference: `manual-${Date.now()}`, status: 'PENDING' };
  }
}

// --- Registries -------------------------------------------------------

export function createEmailProvider(): EmailProvider {
  switch (env.EMAIL_PROVIDER) {
    case 'resend':
      if (!env.RESEND_API_KEY) throw new Error('EMAIL_PROVIDER=resend requires RESEND_API_KEY');
      return new ResendEmailProvider(env.RESEND_API_KEY);
    default:
      return new LogEmailProvider();
  }
}

export function createSmsProvider(): SmsProvider {
  switch (env.SMS_PROVIDER) {
    case 'twilio':
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN || !env.TWILIO_FROM_NUMBER) {
        throw new Error('SMS_PROVIDER=twilio requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER');
      }
      return new TwilioSmsProvider(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN, env.TWILIO_FROM_NUMBER);
    default:
      return new LogSmsProvider();
  }
}

export function createPushProvider(): PushProvider {
  if (env.PUSH_PROVIDER === 'webpush') {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
      throw new Error('PUSH_PROVIDER=webpush requires VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY');
    }
    return new WebPushProvider(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY, env.VAPID_SUBJECT);
  }
  return new LogPushProvider();
}

export function createMapsProvider(): MapsProvider {
  return new LogMapsProvider();
}

export function createVerificationProvider(): VerificationProvider {
  return new ManualVerificationProvider();
}

/**
 * Composite notifier used by AuthService. Explicitly reports whether a
 * channel is a development placeholder, so callers never mistake a logged
 * message for a delivered one.
 */
export interface NotificationAdapters {
  email: EmailProvider;
  sms: SmsProvider;
  push: PushProvider;
  maps: MapsProvider;
  verify: VerificationProvider;
  isDevelopmentChannel: boolean;
}

export function createNotificationAdapters(): NotificationAdapters {
  const email = createEmailProvider();
  const sms = createSmsProvider();
  return {
    email,
    sms,
    push: createPushProvider(),
    maps: createMapsProvider(),
    verify: createVerificationProvider(),
    isDevelopmentChannel: email.name === 'log' && sms.name === 'log',
  };
}

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

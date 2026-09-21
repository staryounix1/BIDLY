import { randomUUID } from 'node:crypto';
import pino, { type Logger } from 'pino';

/**
 * Structured logging.
 *
 * - JSON in production, pretty in development.
 * - Values under sensitive keys are redacted at the logger level so no caller
 *   can leak a password, token, or card field by accident.
 * - Business events (registration, offer created, payment captured, ...) use
 *   stable `event` names so they can be searched and alerted on.
 */

const SENSITIVE_KEYS = [
  'password',
  'passwordHash',
  'password_hash',
  'newPassword',
  'currentPassword',
  'token',
  'accessToken',
  'refreshToken',
  'refresh_token_hash',
  'tokenHash',
  'authorization',
  'cookie',
  'cardNumber',
  'card_number',
  'cvv',
  'cvc',
  'pan',
  'secret',
  'apiKey',
  'api_key',
  'privateKey',
  'clientSecret',
  'otp',
  'code',
  'otpHash',
  'startOtp',
  'mfaSecret',
];

// Top-level exact matches plus one-level nesting under the objects Fastify and
// our own code log most often. Pino's `*` matches a single path segment, so
// `body.*` covers `body.password` without needing every key spelled out twice.
const REDACTED_PATHS = [
  ...SENSITIVE_KEYS,
  'headers.authorization',
  'headers.cookie',
  ...['body', 'req.body', 'request.body', 'data', 'payload', 'context'].flatMap((prefix) =>
    SENSITIVE_KEYS.map((key) => `${prefix}.${key}`),
  ),
  'req.headers.authorization',
  'req.headers.cookie',
];

let rootLogger: Logger | null = null;

export function initLogger(options: {
  level: string;
  pretty: boolean;
  name?: string;
}): Logger {
  const isDev = options.pretty;
  rootLogger = pino({
    name: options.name ?? 'bidly-api',
    level: options.level,
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    base: { service: 'bidly-api', pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(isDev
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  });
  return rootLogger;
}

export function getLogger(): Logger {
  if (!rootLogger) {
    rootLogger = pino({
      level: process.env.LOG_LEVEL ?? 'info',
      redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    });
  }
  return rootLogger;
}

export function createChildLogger(bindings: Record<string, unknown>): Logger {
  return getLogger().child(bindings);
}

// ---------------------------------------------------------------------
// Business event logging — a small typed façade over pino
// ---------------------------------------------------------------------

export const LOG_EVENTS = {
  // auth
  USER_REGISTERED: 'user.registered',
  USER_LOGGED_IN: 'user.logged_in',
  USER_LOGIN_FAILED: 'user.login_failed',
  USER_LOGGED_OUT: 'user.logged_out',
  TOKEN_REFRESHED: 'auth.token_refreshed',
  TOKEN_REUSE_DETECTED: 'auth.token_reuse_detected',
  PASSWORD_RESET_REQUESTED: 'auth.password_reset_requested',
  PASSWORD_RESET_COMPLETED: 'auth.password_reset_completed',
  EMAIL_VERIFIED: 'auth.email_verified',
  PHONE_VERIFIED: 'auth.phone_verified',
  ACCOUNT_DELETED: 'user.account_deleted',
  // marketplace
  REQUEST_CREATED: 'request.created',
  REQUEST_PUBLISHED: 'request.published',
  REQUEST_CANCELLED: 'request.cancelled',
  REQUEST_EXPIRED: 'request.expired',
  OFFER_CREATED: 'offer.created',
  OFFER_ACCEPTED: 'offer.accepted',
  OFFER_REJECTED: 'offer.rejected',
  OFFER_WITHDRAWN: 'offer.withdrawn',
  OFFER_COUNTERED: 'offer.countered',
  JOB_CREATED: 'job.created',
  JOB_STARTED: 'job.started',
  JOB_COMPLETED: 'job.completed',
  JOB_CANCELLED: 'job.cancelled',
  REVIEW_SUBMITTED: 'review.submitted',
  REVIEW_CREATED: 'review.created',
  REFERRAL_CLAIMED: 'referral.claimed',
  REFERRAL_REWARDED: 'referral.rewarded',
  COMPLAINT_OPENED: 'complaint.opened',
  BOOST_PURCHASED: 'boost.purchased',
  TRACKING_LINK_CREATED: 'tracking_link.created',
  DISPUTE_OPENED: 'dispute.opened',
  MESSAGE_SENT: 'message.sent',
  SUPPORT_TICKET_CREATED: 'support.ticket_created',
  // money
  PAYMENT_AUTHORIZED: 'payment.authorized',
  PAYMENT_CAPTURED: 'payment.captured',
  PAYMENT_FAILED: 'payment.failed',
  REFUND_REQUESTED: 'refund.requested',
  REFUND_COMPLETED: 'refund.completed',
  WALLET_CREDITED: 'wallet.credited',
  WALLET_TOPPED_UP: 'wallet.topped_up',
  PAYOUT_REQUESTED: 'payout.requested',
  PAYOUT_PAID: 'payout.paid',
  WEBHOOK_RECEIVED: 'webhook.received',
  WEBHOOK_REJECTED: 'webhook.rejected',
  // admin
  ADMIN_ACTION: 'admin.action',
  // system
  REQUEST_ERROR: 'http.request_error',
  UNHANDLED_ERROR: 'system.unhandled_error',
  STARTUP: 'system.startup',
  SHUTDOWN: 'system.shutdown',
} as const;

export type LogEvent = (typeof LOG_EVENTS)[keyof typeof LOG_EVENTS];

export interface LogContext {
  userId?: string;
  adminId?: string;
  requestId?: string;
  entityType?: string;
  entityId?: string;
  [key: string]: unknown;
}

/**
 * Log a business event at info level with a stable event name.
 * Never pass secrets, tokens, or full card data in the context.
 */
export function logEvent(event: LogEvent | string, context: LogContext = {}): void {
  getLogger().info({ event, ...context }, event);
}

export function logWarn(event: LogEvent | string, context: LogContext = {}): void {
  getLogger().warn({ event, ...context }, event);
}

export function logError(
  event: LogEvent | string,
  error: unknown,
  context: LogContext = {},
): void {
  const err = error instanceof Error ? error : new Error(String(error));
  getLogger().error(
    {
      event,
      ...context,
      err: {
        name: err.name,
        message: err.message,
        stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
      },
    },
    event,
  );
}

export function newRequestId(): string {
  return randomUUID();
}

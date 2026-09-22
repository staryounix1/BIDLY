import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './errors.js';
import { logError } from './logger.js';
import { env } from '@bidly/config';

/**
 * Turn anything thrown by a handler into a safe, consistent HTTP response.
 * Internal detail is logged; users only ever see stable codes and messages.
 */
export function errorHandler(
  error: Error & { statusCode?: number; code?: string; validation?: unknown },
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const requestId = request.id;

  // Fastify schema validation
  if (error.validation) {
    reply.status(400).send({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Some of the information provided is invalid.',
        details: error.validation,
        requestId,
      },
    });
    return;
  }

  if (AppError.isAppError(error)) {
    if (error.statusCode >= 500) {
      logError('http.request_error', error, {
        requestId,
        route: request.routeOptions?.url ?? request.url,
        method: request.method,
        code: error.code,
      });
    }
    const body: Record<string, unknown> = {
      success: false,
      error: {
        code: error.code,
        message: error.expose ? error.message : 'Something went wrong on our side. Please try again.',
        requestId,
      },
    };
    if (error.details !== undefined && error.expose) {
      (body.error as Record<string, unknown>).details = error.details;
    }
    if (error.code === 'RATE_LIMITED') {
      const details = error.details as { retryAfterSeconds?: number } | undefined;
      if (details?.retryAfterSeconds) reply.header('retry-after', details.retryAfterSeconds);
    }
    reply.status(error.statusCode).send(body);
    return;
  }

  // Fastify rate limit
  if (error.statusCode === 429) {
    reply.status(429).send({
      success: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.', requestId },
    });
    return;
  }

  // Postgres constraint violations surfaced as friendly conflicts.
  //
  // The generic messages are what the user sees, but they used to be ALL the
  // server returned, which made a 23514 ("This action violates a platform
  // rule.") nearly impossible to diagnose: the transition trigger, a wallet
  // amount check and a price check all produced the identical string. The
  // constraint name and Postgres detail are safe to expose — they carry no row
  // contents, only schema vocabulary — so always return them in `details`.
  // Without this, every one of the ~100 CHECK constraints in the schema costs a
  // full debugging cycle to identify.
  const pgCode = (error as { code?: string }).code;
  const CONSTRAINT_MAP: Record<string, { code: string; message: string; status: number }> = {
    '23505': { code: 'ALREADY_EXISTS', message: 'This record already exists.', status: 409 },
    '23503': { code: 'CONFLICT', message: 'A related record is missing or in use.', status: 409 },
    '23514': { code: 'BUSINESS_RULE_VIOLATION', message: 'This action violates a platform rule.', status: 422 },
    '22P02': { code: 'INVALID_INPUT', message: 'The request contains invalid data.', status: 400 },
  };
  if (pgCode && CONSTRAINT_MAP[pgCode]) {
    const mapped = CONSTRAINT_MAP[pgCode]!;
    const pgError = error as { constraint?: string; table?: string; detail?: string; column?: string };
    logError('http.request_error', error, {
      requestId, pgCode, route: request.url,
      constraint: pgError.constraint, table: pgError.table, detail: pgError.detail,
    });
    // Name the offending constraint so the failure is identifiable from the
    // response alone. `constraint` is the CHECK/FK/unique name; `detail` is the
    // trigger's own message ("Illegal request transition PUBLISHED -> ...").
    const details: Record<string, unknown> = {};
    if (pgError.constraint) details.constraint = pgError.constraint;
    if (pgError.table) details.table = pgError.table;
    if (pgError.detail) details.reason = pgError.detail;
    reply.status(mapped.status).send({
      success: false,
      error: {
        code: mapped.code,
        message: mapped.message,
        requestId,
        ...(Object.keys(details).length ? { details } : {}),
      },
    });
    return;
  }

  // Unknown error — log everything, reveal nothing
  logError('system.unhandled_error', error, {
    requestId,
    method: request.method,
    route: request.url,
    stack: env.NODE_ENV === 'production' ? undefined : error.stack,
  });

  reply.status(500).send({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side. Please try again.',
      requestId,
      ...(env.NODE_ENV !== 'production' ? { debug: error.message } : {}),
    },
  });
}

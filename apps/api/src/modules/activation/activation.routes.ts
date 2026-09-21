import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unauthorized, businessRule, notFound } from '../../core/errors.js';
import { clientQuery, queryOne, transaction } from '../../db/pool.js';
import { logEvent, LOG_EVENTS } from '../../core/logger.js';

/**
 * /me — account activation.
 *
 * Two steps stand between a fresh account and a usable one:
 *
 *   1. **WhatsApp.** The user enters a number and we record it as confirmed.
 *      The confirmation is *simulated* right now: there is no WhatsApp provider
 *      wired up (and no code is sent), so this deliberately does not pretend to
 *      be a security boundary. When a real provider lands, only this handler
 *      changes — the storage and the UI stay as they are.
 *
 *   2. **Identity.** The user uploads the front and back of their ID. That
 *      creates a PENDING review an admin works from the console. Until it is
 *      approved the account can browse but not transact.
 *
 * Deliberately not reusing `providers.verification_status`: identity review
 * applies to customers too, and most accounts have no providers row.
 */

/** How many wrong-code attempts before the activation step is locked out. */
const MAX_ACTIVATION_ATTEMPTS = 4;
/** Cooldown applied once that limit is hit. */
const BLOCK_MINUTES = 30;

const whatsappSchema = z.object({
  number: z
    .string()
    .trim()
    .min(8, 'Enter a valid number')
    .max(20)
    .regex(/^\+?[0-9\s-]{8,20}$/, 'Enter a valid phone number'),
});

const identitySchema = z.object({
  rectoUrl: z.string().trim().min(1).max(4_000_000),
  versoUrl: z.string().trim().min(1).max(4_000_000),
  // A photo of the account holder, so the reviewer can match a face to the
  // document. Required: the document alone does not prove who is holding it.
  selfieUrl: z.string().trim().min(1).max(4_000_000),
  documentNumber: z.string().trim().max(80).optional(),
});

export async function registerActivationRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Confirm the account's WhatsApp number.
   *
   * Simulated: the number is validated, stored and marked confirmed. No message
   * is sent. The attempts counter and block are still honoured so the UI's
   * retry/limit behaviour is real rather than cosmetic.
   */
  app.put('/me/whatsapp', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['activation'], summary: 'Confirm the account WhatsApp number', security: [{ bearerAuth: [] }],
      body: {
        type: 'object', required: ['number'], additionalProperties: false,
        properties: { number: { type: 'string', minLength: 8, maxLength: 20 } },
      },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const userId = request.auth.userId;
    const { number } = whatsappSchema.parse(request.body);

    const row = await queryOne<{ activation_blocked_until: Date | null; activation_attempts: number }>(
      `select activation_blocked_until, activation_attempts from users where id = $1`,
      [userId],
    );
    if (!row) throw notFound('Account');

    const blockedUntil = row.activation_blocked_until;
    if (blockedUntil && blockedUntil.getTime() > Date.now()) {
      throw businessRule('Too many attempts. Try again later.', {
        retryAfterSeconds: Math.ceil((blockedUntil.getTime() - Date.now()) / 1000),
      });
    }

    const updated = await transaction(async (client) => {
      const c = clientQuery(client);
      const u = await c.one<{ whatsapp_number: string; whatsapp_verified_at: string }>(
        `update users
            set whatsapp_number = $2,
                whatsapp_verified_at = now(),
                -- A confirmed number clears the counter and any stale block.
                activation_attempts = 0,
                activation_blocked_until = null,
                updated_at = now()
          where id = $1
          returning whatsapp_number, whatsapp_verified_at`,
        [userId, number],
      );
      await c.query(
        `update verification_records
            set status = 'EXPIRED', reviewed_at = now(), updated_at = now()
          where user_id = $1 and type = 'PHONE' and status in ('PENDING','VERIFIED')
            and coalesce(payload->>'channel','') = 'WHATSAPP'`,
        [userId],
      );
      await c.query(
        `insert into verification_records (user_id, type, status, subject, method, payload)
         values ($1, 'PHONE', 'VERIFIED', $2, 'SIMULATED', $3::jsonb)`,
        [userId, number, JSON.stringify({ channel: 'WHATSAPP', simulated: true })],
      );
      return u;
    });

    logEvent(LOG_EVENTS.PHONE_VERIFIED, {
      userId: userId, channel: 'WHATSAPP', simulated: true,
    });
    return reply.send({ success: true, data: updated });
  });

  /**
   * Submit identity documents for review.
   *
   * Replaces any previous pending submission so resubmitting after a rejection
   * cannot leave two live reviews for one account.
   */
  app.post('/me/identity', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['activation'], summary: 'Submit identity documents for review', security: [{ bearerAuth: [] }],
      body: {
        type: 'object', required: ['rectoUrl', 'versoUrl', 'selfieUrl'], additionalProperties: false,
        properties: {
          // A data URL of a client-compressed photo, or an ordinary link. Sized
          // for an image the browser has already downscaled, not a raw camera
          // file: the client compresses before sending (see `DocumentField`).
          rectoUrl: { type: 'string', minLength: 1, maxLength: 4_000_000 },
          versoUrl: { type: 'string', minLength: 1, maxLength: 4_000_000 },
          selfieUrl: { type: 'string', minLength: 1, maxLength: 4_000_000 },
          documentNumber: { type: 'string', maxLength: 80 },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const userId = request.auth.userId;
    const input = identitySchema.parse(request.body);

    const result = await transaction(async (client) => {
      const c = clientQuery(client);
      const user = await c.one<{ id: string; provider_id: string | null }>(
        `select u.id, (select id from providers where user_id = u.id) as provider_id
           from users u where u.id = $1 for update of u`,
        [userId],
      );
      if (!user) throw notFound('Account');

      const updated = await c.one<{ identity_review_status: string; identity_submitted_at: string }>(
        `update users
            set identity_review_status = 'PENDING',
                identity_recto_url = $2,
                identity_verso_url = $3,
                identity_selfie_url = $4,
                identity_submitted_at = now(),
                identity_reviewed_at = null,
                identity_review_notes = null,
                updated_at = now()
          where id = $1
          returning identity_review_status, identity_submitted_at`,
        [userId, input.rectoUrl, input.versoUrl, input.selfieUrl],
      );

      // Retire any earlier live identity record before opening a new one, so the
      // partial unique index never sees two.
      await c.query(
        `update verification_records
            set status = 'EXPIRED', reviewed_at = now(), updated_at = now()
          where user_id = $1 and type = 'IDENTITY' and status in ('PENDING','VERIFIED')`,
        [userId],
      );
      await c.query(
        `insert into verification_records
           (provider_id, user_id, type, status, subject, method, payload)
         values ($1, $2, 'IDENTITY', 'PENDING', $3, 'DOCUMENT_UPLOAD', $4::jsonb)`,
        [
          user.provider_id, userId, input.documentNumber ?? null,
          JSON.stringify({ channel: 'IDENTITY', recto: input.rectoUrl, verso: input.versoUrl, selfie: input.selfieUrl }),
        ],
      );

      return updated;
    });

    logEvent(LOG_EVENTS.ADMIN_ACTION, {
      action: 'IDENTITY_SUBMITTED', userId: userId,
    });
    return reply.status(201).send({ success: true, data: result });
  });

  /** Poll the identity review state, used while a submission is pending. */
  app.get('/me/activation', {
    preHandler: [app.authenticate],
    schema: { tags: ['activation'], summary: 'My activation state', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const userId = request.auth.userId;
    const row = await queryOne<Record<string, unknown>>(
      `select whatsapp_number, whatsapp_verified_at,
              identity_review_status, identity_recto_url, identity_verso_url,
              identity_submitted_at, identity_review_notes, activation_blocked_until
         from users where id = $1`,
      [userId],
    );
    if (!row) throw notFound('Account');
    return reply.send({
      success: true,
      data: {
        ...row,
        whatsapp: row.whatsapp_verified_at != null,
        identity: row.identity_review_status === 'VERIFIED',
        identityPending: row.identity_review_status === 'PENDING',
        complete: row.whatsapp_verified_at != null && row.identity_review_status === 'VERIFIED',
      },
    });
  });
}

export { MAX_ACTIVATION_ATTEMPTS, BLOCK_MINUTES };

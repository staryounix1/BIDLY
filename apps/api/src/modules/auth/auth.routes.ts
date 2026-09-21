import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuthService, Notifier } from './auth.service.js';
import { AppError, ERROR_CODES, unauthorized } from '../../core/errors.js';
import { RATE_LIMITS } from '@bidly/config';
import { registerSchema, loginSchema, verifyEmailSchema, changePasswordSchema } from '@bidly/validation';

/**
 * /auth routes.
 *
 * Advanced endpoints from the spec will be layered on later; this task
 * establishes the complete, working authentication foundation.
 */

const emailSchema = z.string().email().max(254);
const phoneSchema = z
  .string()
  .min(8)
  .max(20)
  .regex(/^\+?[0-9\s-]+$/, 'Phone must be a valid international number');

const passwordSchema = z.string().min(8).max(128);

export interface AuthRoutesOptions {
  authService: AuthService;
  notifier: Notifier;
}

function clientMeta(request: { ip?: string; headers: Record<string, unknown> }) {
  return {
    ip: request.ip,
    userAgent: typeof request.headers['user-agent'] === 'string' ? (request.headers['user-agent'] as string) : undefined,
  };
}

export async function registerAuthRoutes(app: FastifyInstance, opts: AuthRoutesOptions): Promise<void> {
  const { authService } = opts;

  // -------- register (email) -----------------------------------------
  app.post('/register', {
    config: { rateLimit: { max: RATE_LIMITS.AUTH.max, timeWindow: RATE_LIMITS.AUTH.windowSeconds * 1000 } },
    schema: {
      tags: ['auth'],
      summary: 'Register a new account with email and password',
      body: {
        type: 'object',
        required: ['email', 'password'],
        additionalProperties: false,
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 8, maxLength: 128 },
          fullName: { type: 'string', minLength: 1, maxLength: 120 },
          phone: { type: 'string', minLength: 8, maxLength: 20 },
          locale: { type: 'string', enum: ['ar', 'fr', 'en'] },
          role: { type: 'string', enum: ['CUSTOMER', 'PROVIDER'] },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      email?: string; password?: string; fullName?: string; phone?: string; locale?: string; role?: 'CUSTOMER' | 'PROVIDER';
    };

    const parsed = registerSchema.parse({
      email: body.email,
      password: body.password,
      ...(body.fullName !== undefined ? { fullName: body.fullName } : {}),
      ...(body.phone !== undefined ? { phone: body.phone } : {}),
      ...(body.locale !== undefined ? { locale: body.locale } : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
    });

    const result = await authService.registerWithEmail({
      email: parsed.email,
      password: parsed.password,
      ...(parsed.fullName !== undefined ? { fullName: parsed.fullName } : {}),
      ...(parsed.phone !== undefined ? { phone: parsed.phone } : {}),
      ...(parsed.locale !== undefined ? { locale: parsed.locale } : {}),
      ...(parsed.role !== undefined ? { role: parsed.role } : {}),
    });

    return reply.status(201).send({
      success: true,
      data: {
        user: result.user,
        verificationRequired: result.verificationRequired,
        message: result.verificationRequired
          ? 'Account created. Check your email for the verification code.'
          : 'Account created. You can sign in now.',
      },
    });
  });

  // -------- register / login (phone) ---------------------------------
  app.post('/phone/start', {
    config: { rateLimit: { max: RATE_LIMITS.OTP.max, timeWindow: RATE_LIMITS.OTP.windowSeconds * 1000 } },
    schema: {
      tags: ['auth'],
      summary: 'Start phone verification (creates the account if new, then sends an OTP)',
      body: {
        type: 'object',
        required: ['phone'],
        additionalProperties: false,
        properties: {
          phone: { type: 'string' },
          fullName: { type: 'string', maxLength: 120 },
          locale: { type: 'string', enum: ['ar', 'fr', 'en'] },
          role: { type: 'string', enum: ['CUSTOMER', 'PROVIDER'] },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { phone?: string; fullName?: string; locale?: string; role?: 'CUSTOMER' | 'PROVIDER' };
    const phone = phoneSchema.parse(body.phone);

    const result = await authService.registerWithPhone({
      phone,
      ...(body.fullName !== undefined ? { fullName: body.fullName } : {}),
      ...(body.locale !== undefined ? { locale: body.locale } : {}),
      ...(body.role !== undefined ? { role: body.role } : {}),
    });

    return reply.send({
      success: true,
      data: { otpSent: true, userId: result.user.id },
    });
  });

  app.post('/phone/verify', {
    config: { rateLimit: { max: RATE_LIMITS.OTP.max, timeWindow: RATE_LIMITS.OTP.windowSeconds * 1000 } },
    schema: {
      tags: ['auth'],
      summary: 'Verify the phone OTP and sign in',
      body: {
        type: 'object',
        required: ['phone', 'code'],
        additionalProperties: false,
        properties: {
          phone: { type: 'string' },
          code: { type: 'string', minLength: 4, maxLength: 8 },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { phone?: string; code?: string };
    const phone = phoneSchema.parse(body.phone);
    const code = z.string().min(4).max(8).parse(body.code);

    const result = await authService.verifyPhoneOtp(phone, code, clientMeta(request));
    return reply.send({
      success: true,
      data: {
        user: result.user,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        expiresIn: result.tokens.expiresIn,
        tokenType: 'Bearer',
      },
    });
  });

  // -------- login -----------------------------------------------------
  app.post('/login', {
    config: { rateLimit: { max: RATE_LIMITS.AUTH.max, timeWindow: RATE_LIMITS.AUTH.windowSeconds * 1000 } },
    schema: {
      tags: ['auth'],
      summary: 'Sign in with email/phone and password',
      body: {
        type: 'object',
        required: ['identifier', 'password'],
        additionalProperties: false,
        properties: {
          identifier: { type: 'string', minLength: 3, maxLength: 254 },
          password: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { identifier?: string; password?: string };
    const { identifier, password } = loginSchema.parse(body);

    const result = await authService.loginWithPassword(identifier, password, clientMeta(request));
    return reply.send({
      success: true,
      data: {
        user: result.user,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        expiresIn: result.tokens.expiresIn,
        tokenType: 'Bearer',
      },
    });
  });

  // -------- refresh ---------------------------------------------------
  app.post('/refresh', {
    config: { rateLimit: { max: RATE_LIMITS.AUTH.max, timeWindow: RATE_LIMITS.AUTH.windowSeconds * 1000 } },
    schema: {
      tags: ['auth'],
      summary: 'Rotate the refresh token and issue a new token pair',
      body: {
        type: 'object',
        required: ['refreshToken'],
        additionalProperties: false,
        properties: { refreshToken: { type: 'string', minLength: 20 } },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { refreshToken?: string };
    const refreshToken = z.string().min(20).parse(body.refreshToken);
    const result = await authService.refreshSession(refreshToken, clientMeta(request));
    return reply.send({
      success: true,
      data: {
        user: result.user,
        accessToken: result.tokens.accessToken,
        refreshToken: result.tokens.refreshToken,
        expiresIn: result.tokens.expiresIn,
        tokenType: 'Bearer',
      },
    });
  });

  // -------- logout ----------------------------------------------------
  app.post('/logout', {
    preHandler: [app.authenticate],
    schema: { tags: ['auth'], summary: 'Revoke the current session', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    await authService.logout(request.auth.sessionId);
    return reply.send({ success: true, data: { loggedOut: true } });
  });

  app.post('/logout-all', {
    preHandler: [app.authenticate],
    schema: { tags: ['auth'], summary: 'Revoke every session for the current user', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const count = await authService.logoutAllSessions(request.auth.userId);
    return reply.send({ success: true, data: { sessionsRevoked: count } });
  });

  app.get('/sessions', {
    preHandler: [app.authenticate],
    schema: { tags: ['auth'], summary: 'List active sessions', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const sessions = await authService.listSessions(request.auth.userId);
    return reply.send({ success: true, data: sessions });
  });

  // -------- email verification ---------------------------------------
  app.post('/verify-email', {
    config: { rateLimit: { max: RATE_LIMITS.OTP.max, timeWindow: RATE_LIMITS.OTP.windowSeconds * 1000 } },
    preHandler: [app.optionalAuth],
    schema: {
      tags: ['auth'],
      summary: 'Verify an email address with a code (authenticated, or email + code for a new account)',
      security: [{ bearerAuth: [] }, {}],
      body: {
        type: 'object',
        required: ['code'],
        additionalProperties: false,
        properties: {
          code: { type: 'string', minLength: 4, maxLength: 8 },
          email: { type: 'string', format: 'email' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { code?: string; email?: string };
    const parsed = verifyEmailSchema.parse(body);
    const code = parsed.code;

    // A signed-in user verifies their own address; a brand-new user who has
    // not received a token yet identifies the account by email.
    let userId = request.auth?.userId;
    if (!userId) {
      if (!parsed.email) {
        throw new AppError({
          code: ERROR_CODES.VALIDATION_ERROR,
          message: 'Provide the email address to verify, or sign in first.',
        });
      }
      const { queryOne } = await import('../../db/pool.js');
      const row = await queryOne<{ id: string }>(
        'select id from users where email = $1 and deleted_at is null',
        [parsed.email],
      );
      if (!row) {
        throw new AppError({ code: ERROR_CODES.TOKEN_INVALID, message: 'The code is invalid or has expired.' });
      }
      userId = row.id;
    }

    await authService.verifyEmail(userId, code);
    return reply.send({ success: true, data: { verified: true } });
  });

  app.post('/resend-verification', {
    config: { rateLimit: { max: RATE_LIMITS.OTP.max, timeWindow: RATE_LIMITS.OTP.windowSeconds * 1000 } },
    preHandler: [app.authenticate],
    schema: { tags: ['auth'], summary: 'Resend the email verification code', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const { queryOne } = await import('../../db/pool.js');
    const row = await queryOne<{ email: string | null }>('select email from users where id = $1', [request.auth.userId]);
    if (!row?.email) throw new AppError({ code: ERROR_CODES.CONFLICT, message: 'No email address on this account.' });
    const result = await authService.requestOtp({
      userId: request.auth.userId,
      purpose: 'EMAIL_VERIFY',
      destination: row.email,
    });
    return reply.send({ success: true, data: result });
  });

  // -------- password reset -------------------------------------------
  app.post('/password/forgot', {
    config: { rateLimit: { max: RATE_LIMITS.OTP.max, timeWindow: RATE_LIMITS.OTP.windowSeconds * 1000 } },
    schema: {
      tags: ['auth'],
      summary: 'Request a password reset code',
      body: {
        type: 'object',
        required: ['email'],
        additionalProperties: false,
        properties: { email: { type: 'string', format: 'email' } },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { email?: string };
    const email = emailSchema.parse(body.email);
    await authService.requestPasswordReset(email);
    // Always the same response: never reveal whether the email exists.
    return reply.send({
      success: true,
      data: { sent: true, message: 'If that email is registered, a reset code has been sent.' },
    });
  });

  app.post('/password/reset', {
    config: { rateLimit: { max: RATE_LIMITS.OTP.max, timeWindow: RATE_LIMITS.OTP.windowSeconds * 1000 } },
    schema: {
      tags: ['auth'],
      summary: 'Reset the password with an emailed code',
      body: {
        type: 'object',
        required: ['email', 'code', 'newPassword'],
        additionalProperties: false,
        properties: {
          email: { type: 'string', format: 'email' },
          code: { type: 'string', minLength: 4, maxLength: 8 },
          newPassword: { type: 'string', minLength: 8, maxLength: 128 },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { email?: string; code?: string; newPassword?: string };
    await authService.resetPassword(
      emailSchema.parse(body.email),
      z.string().min(4).max(8).parse(body.code),
      passwordSchema.parse(body.newPassword),
    );
    return reply.send({
      success: true,
      data: { reset: true, message: 'Password updated. Please sign in again.' },
    });
  });

  app.post('/password/change', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['auth'],
      summary: 'Change the password while signed in',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        additionalProperties: false,
        properties: {
          currentPassword: { type: 'string', minLength: 1, maxLength: 128 },
          newPassword: { type: 'string', minLength: 8, maxLength: 128 },
        },
      },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const body = request.body as { currentPassword?: string; newPassword?: string };
    const parsed = changePasswordSchema.parse(body);
    await authService.changePassword(request.auth.userId, parsed.currentPassword, parsed.newPassword);
    return reply.send({ success: true, data: { changed: true } });
  });

  // -------- me / account deletion ------------------------------------
  app.get('/me', {
    preHandler: [app.authenticate],
    schema: { tags: ['auth'], summary: 'Return the current authenticated user', security: [{ bearerAuth: [] }] },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const { queryOne } = await import('../../db/pool.js');
    const user = await queryOne<Record<string, unknown>>(
      `select u.id, u.email, u.phone, u.role, u.status, u.locale, u.country_code,
              u.email_verified_at, u.phone_verified_at, u.created_at,
              u.whatsapp_number, u.whatsapp_verified_at,
              u.identity_review_status, u.identity_recto_url, u.identity_verso_url, u.identity_selfie_url,
              u.identity_submitted_at, u.identity_review_notes,
              u.activation_blocked_until,
              p.full_name, p.display_name, p.avatar_url, p.preferred_currency,
              (select id from providers where user_id = u.id) as provider_id
       from users u left join user_profiles p on p.user_id = u.id
       where u.id = $1`,
      [request.auth.userId],
    );
    if (!user) throw unauthorized();
    // Staff are exempt from activation: an admin runs the platform rather than
    // using the marketplace, and gating the reviewer behind the review would
    // make the queue unreachable. Decided here so no client can disagree.
    const isStaff = user.role === 'ADMIN' || request.auth.adminRole != null;
    return reply.send({
      success: true,
      data: {
        ...user,
        // Derived so every client agrees on what "activated" means without
        // re-implementing the rule: WhatsApp confirmed AND identity approved.
        activation: {
          whatsapp: isStaff || user.whatsapp_verified_at != null,
          identity: isStaff || user.identity_review_status === 'VERIFIED',
          identityPending: !isStaff && user.identity_review_status === 'PENDING',
          blockedUntil: user.activation_blocked_until ?? null,
          complete:
            isStaff ||
            (user.whatsapp_verified_at != null && user.identity_review_status === 'VERIFIED'),
        },
        admin_role: request.auth.adminRole ?? null,
      },
    });
  });

  app.delete('/account', {
    preHandler: [app.authenticate],
    schema: {
      tags: ['auth'],
      summary: 'Soft-delete the account and revoke all access',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['confirmation'],
        additionalProperties: false,
        properties: { confirmation: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    if (!request.auth) throw unauthorized();
    const body = request.body as { confirmation?: string };
    await authService.deleteAccount(request.auth.userId, z.string().parse(body.confirmation));
    return reply.send({ success: true, data: { deleted: true } });
  });
}

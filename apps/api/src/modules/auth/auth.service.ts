import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { env } from '@bidly/config';
import type { AdminRole, AuthenticatedUser, UserRole } from '@bidly/types';
import { clientQuery, queryOne, transaction } from '../../db/pool.js';
import {
  AppError,
  ERROR_CODES,
  conflict,
  duplicateEmail,
  duplicatePhone,
  expired,
  invalidCredentials,
  notFound,
  unauthorized,
  validationError,
} from '../../core/errors.js';
import {
  checkPasswordPolicy,
  hashPassword,
  verifyAgainstDummy,
  verifyPassword,
} from '../../core/password.js';
import {
  generateOtp,
  hashToken,
  issueTokens,
  signAccessToken,
  timingSafeEqualString,
  TOKEN_TTL,
  type IssuedTokens,
} from '../../core/tokens.js';
import { LOG_EVENTS, logEvent, newRequestId } from '../../core/logger.js';

/**
 * Authentication & session service.
 *
 * Supported flows:
 *   - email/password registration and login
 *   - phone OTP registration and login
 *   - email verification / phone verification
 *   - password reset
 *   - refresh-token rotation with reuse detection (session families)
 *   - logout (single session) and logout-all
 *   - account deletion (soft, with session revocation)
 *
 * Provider interfaces for outbound messages are injected so real SMS/email
 * adapters can replace the development log adapters without touching this
 * logic.
 */

export interface Notifier {
  sendEmail(to: string, subject: string, body: string): Promise<void>;
  sendSms(to: string, body: string): Promise<void>;
}

export interface UserRow {
  id: string;
  email: string | null;
  phone: string | null;
  password_hash: string | null;
  role: UserRole;
  status: string;
  email_verified_at: Date | null;
  phone_verified_at: Date | null;
  failed_login_count: number;
  locked_until: Date | null;
  locale: string;
  deleted_at: Date | null;
}

export interface RegisterEmailInput {
  email: string;
  password: string;
  fullName?: string;
  locale?: string;
  phone?: string;
  role?: Extract<UserRole, 'CUSTOMER' | 'PROVIDER'>;
}

export interface LoginResult {
  user: AuthenticatedUser;
  tokens: IssuedTokens;
}

function toAuthenticatedUser(row: UserRow, providerId?: string | null): AuthenticatedUser {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    role: row.role,
    status: row.status as AuthenticatedUser['status'],
    emailVerified: row.email_verified_at != null,
    phoneVerified: row.phone_verified_at != null,
    providerId: providerId ?? null,
  };
}

async function loadProviderId(userId: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>('select id from providers where user_id = $1', [userId]);
  return row?.id ?? null;
}

/** Admin staff record linked to a user, used for sub-role permission checks. */
export interface AdminContext {
  adminRole: AdminRole;
  permissions: string[];
}

/**
 * Resolve the admin staff record for a user. Admin authority lives in the
 * `admins` table (sub-role + explicit permissions), not on `users.role` alone,
 * so a user promoted to ADMIN without a staff row gets no admin powers.
 * Inactive or deleted staff resolve to null, which denies admin access.
 */
async function loadAdminContext(userId: string): Promise<AdminContext | null> {
  const row = await queryOne<{ role: AdminRole; permissions: string[] | null }>(
    `select role, permissions from admins
      where user_id = $1 and is_active = true`,
    [userId],
  );
  if (!row) return null;
  return { adminRole: row.role, permissions: row.permissions ?? [] };
}

export class AuthService {
  constructor(private readonly notifier: Notifier) {}

  // -------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------

  async registerWithEmail(input: RegisterEmailInput): Promise<{ user: AuthenticatedUser; verificationRequired: boolean }> {
    const policy = checkPasswordPolicy(input.password);
    if (!policy.valid) {
      throw validationError({ password: policy.reasons });
    }

    const email = input.email.trim().toLowerCase();

    const existing = await queryOne<{ id: string }>(
      'select id from users where email = $1 and deleted_at is null',
      [email],
    );
    if (existing) throw duplicateEmail();

    if (input.phone) {
      const phoneRow = await queryOne<{ id: string }>(
        'select id from users where phone = $1 and deleted_at is null',
        [input.phone],
      );
      if (phoneRow) throw duplicatePhone();
    }

    const passwordHash = await hashPassword(input.password);

    return transaction(async (client) => {
      const c = clientQuery(client);
      const inserted = await c.one<UserRow>(
        `insert into users (email, phone, password_hash, role, status, locale)
         values ($1, $2, $3, $4, 'PENDING', $5)
         returning id, email, phone, password_hash, role, status,
                   email_verified_at, phone_verified_at, failed_login_count,
                   locked_until, locale, deleted_at`,
        [email, input.phone ?? null, passwordHash, input.role ?? 'CUSTOMER', input.locale ?? env.DEFAULT_LOCALE],
      );
      if (!inserted) throw new AppError({ code: ERROR_CODES.INTERNAL_ERROR, cause: 'user insert failed' });

      await c.query(
        `insert into user_profiles (user_id, full_name, display_name, preferred_locale, preferred_currency)
         values ($1, $2, $2, $3, $4)`,
        [inserted.id, input.fullName ?? null, input.locale ?? env.DEFAULT_LOCALE, env.DEFAULT_CURRENCY],
      );

      const code = generateOtp();
      await this.createVerificationCode(client, {
        userId: inserted.id,
        purpose: 'EMAIL_VERIFY',
        channel: 'EMAIL',
        destination: email,
        code,
      });

      logEvent(LOG_EVENTS.USER_REGISTERED, {
        userId: inserted.id,
        role: inserted.role,
        method: 'email',
      });

      // Delivery is best-effort; the user can request a new code.
      await this.sendVerificationEmail(email, code);

      return {
        user: toAuthenticatedUser(inserted, null),
        verificationRequired: true,
      };
    });
  }

  async registerWithPhone(input: {
    phone: string;
    fullName?: string;
    locale?: string;
    role?: Extract<UserRole, 'CUSTOMER' | 'PROVIDER'>;
  }): Promise<{ user: AuthenticatedUser; otpSent: true }> {
    const phone = input.phone.trim();

    let row = await queryOne<UserRow>(
      `select id, email, phone, password_hash, role, status, email_verified_at,
              phone_verified_at, failed_login_count, locked_until, locale, deleted_at
       from users where phone = $1 and deleted_at is null`,
      [phone],
    );

    if (!row) {
      row = await transaction(async (client) => {
        const c = clientQuery(client);
        const inserted = await c.one<UserRow>(
          `insert into users (phone, role, status, locale, is_phone_primary)
           values ($1, $2, 'PENDING', $3, true)
           returning id, email, phone, password_hash, role, status,
                     email_verified_at, phone_verified_at, failed_login_count,
                     locked_until, locale, deleted_at`,
          [phone, input.role ?? 'CUSTOMER', input.locale ?? env.DEFAULT_LOCALE],
        );
        if (!inserted) throw new AppError({ code: ERROR_CODES.INTERNAL_ERROR, cause: 'user insert failed' });
        await c.query(
          `insert into user_profiles (user_id, full_name, display_name, preferred_locale, preferred_currency)
           values ($1, $2, $2, $3, $4)`,
          [inserted.id, input.fullName ?? null, input.locale ?? env.DEFAULT_LOCALE, env.DEFAULT_CURRENCY],
        );
        logEvent(LOG_EVENTS.USER_REGISTERED, { userId: inserted.id, role: inserted.role, method: 'phone' });
        return inserted;
      });
    }

    if (row.status === 'SUSPENDED') {
      throw new AppError({ code: ERROR_CODES.ACCOUNT_SUSPENDED });
    }

    await this.requestOtp({ userId: row.id, purpose: 'PHONE_VERIFY', destination: phone });
    return { user: toAuthenticatedUser(row, null), otpSent: true };
  }

  // -------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------

  async loginWithPassword(emailOrPhone: string, password: string, meta?: { ip?: string; userAgent?: string }): Promise<LoginResult> {
    const identifier = emailOrPhone.trim().toLowerCase();
    const row = await queryOne<UserRow>(
      `select id, email, phone, password_hash, role, status, email_verified_at,
              phone_verified_at, failed_login_count, locked_until, locale, deleted_at
       from users
       where deleted_at is null and (lower(email) = $1 or phone = $2)
       limit 1`,
      [identifier, emailOrPhone.trim()],
    );

    if (!row) {
      await verifyAgainstDummy(password);
      logEvent(LOG_EVENTS.USER_LOGIN_FAILED, { identifier: identifier.slice(0, 3) + '***', reason: 'unknown_user' });
      throw invalidCredentials();
    }

    if (row.locked_until && row.locked_until.getTime() > Date.now()) {
      throw new AppError({
        code: ERROR_CODES.TOO_MANY_ATTEMPTS,
        message: 'Too many attempts. Please try again later.',
        details: { retryAfterSeconds: Math.ceil((row.locked_until.getTime() - Date.now()) / 1000) },
      });
    }

    if (row.status === 'SUSPENDED') throw new AppError({ code: ERROR_CODES.ACCOUNT_SUSPENDED });
    if (row.status === 'DELETED') throw invalidCredentials();

    const valid = row.password_hash ? await verifyPassword(row.password_hash, password) : false;
    if (!valid) {
      const failedCount = row.failed_login_count + 1;
      const shouldLock = failedCount >= env.MAX_LOGIN_ATTEMPTS;
      await transaction(async (client) => {
        await clientQuery(client).query(
          `update users set failed_login_count = $2,
                 locked_until = case when $3 then now() + ($4 || ' minutes')::interval else null end
           where id = $1`,
          [row.id, failedCount, shouldLock, env.LOCKOUT_MINUTES],
        );
      });
      logEvent(LOG_EVENTS.USER_LOGIN_FAILED, { userId: row.id, reason: 'bad_password', failedCount });
      throw invalidCredentials();
    }

    if (row.password_hash) {
      const { needsRehash, hashPassword: hp } = await import('../../core/password.js');
      if (needsRehash(row.password_hash)) {
        const newHash = await hp(password);
        await transaction(async (client) => {
          await clientQuery(client).query('update users set password_hash = $2 where id = $1', [row.id, newHash]);
        });
      }
    }

    const providerId = await loadProviderId(row.id);
    const tokens = await this.createSession(row, meta);

    logEvent(LOG_EVENTS.USER_LOGGED_IN, { userId: row.id, role: row.role, method: 'password' });
    return { user: toAuthenticatedUser(row, providerId), tokens };
  }

  /** Verify a phone OTP and, on success, treat it as a login. */
  async verifyPhoneOtp(phone: string, code: string, meta?: { ip?: string; userAgent?: string }): Promise<LoginResult> {
    const row = await queryOne<UserRow>(
      `select id, email, phone, password_hash, role, status, email_verified_at,
              phone_verified_at, failed_login_count, locked_until, locale, deleted_at
       from users where phone = $1 and deleted_at is null`,
      [phone.trim()],
    );
    if (!row) throw invalidCredentials();
    if (row.status === 'SUSPENDED') throw new AppError({ code: ERROR_CODES.ACCOUNT_SUSPENDED });

    await this.consumeVerificationCode(row.id, 'PHONE_VERIFY', code);

    await transaction(async (client) => {
      await clientQuery(client).query(
        `update users set phone_verified_at = now(),
               status = case when status = 'PENDING' then 'ACTIVE'::bidly_user_status else status end,
               failed_login_count = 0, locked_until = null, last_login_at = now()
         where id = $1`,
        [row.id],
      );
    });

    const providerId = await loadProviderId(row.id);
    const tokens = await this.createSession(row, meta);
    logEvent(LOG_EVENTS.PHONE_VERIFIED, { userId: row.id });
    logEvent(LOG_EVENTS.USER_LOGGED_IN, { userId: row.id, role: row.role, method: 'phone_otp' });

    return {
      user: toAuthenticatedUser(
        { ...row, phone_verified_at: new Date(), status: row.status === 'PENDING' ? 'ACTIVE' : row.status },
        providerId,
      ),
      tokens,
    };
  }

  // -------------------------------------------------------------------
  // Sessions & refresh rotation
  // -------------------------------------------------------------------

  private async createSession(
    user: UserRow,
    meta?: { ip?: string; userAgent?: string },
    existingClient?: PoolClient,
  ): Promise<IssuedTokens> {
    const run = async (client: PoolClient) => {
      const c = clientQuery(client);
      const sessionId = randomUUID();
      const familyId = randomUUID();

      const inserted = await c.one<{ id: string }>(
        `insert into auth_sessions (id, user_id, family_id, refresh_token_hash, user_agent, ip, expires_at)
         values ($1, $2, $3, '', $4, $5, now() + ($6 || ' seconds')::interval)
         returning id`,
        [sessionId, user.id, familyId, meta?.userAgent ?? null, meta?.ip ?? null, TOKEN_TTL.REFRESH_SECONDS],
      );
      if (!inserted) throw new AppError({ code: ERROR_CODES.INTERNAL_ERROR, cause: 'session insert failed' });

      const tokens = await issueTokens({
        userId: user.id,
        role: user.role,
        sessionId,
        familyId,
      });

      await c.query('update auth_sessions set refresh_token_hash = $2 where id = $1', [
        sessionId,
        tokens.refreshTokenHash,
      ]);

      await c.query('update users set last_login_at = now(), failed_login_count = 0, locked_until = null where id = $1', [
        user.id,
      ]);

      return tokens;
    };

    if (existingClient) return run(existingClient);
    return transaction(run);
  }

  /**
   * Rotate a refresh token. Reuse of an already-rotated token revokes the
   * entire family — the standard defence against refresh-token theft.
   */
  async refreshSession(
    refreshToken: string,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<LoginResult> {
    const { verifyRefreshToken } = await import('../../core/tokens.js');
    let payload;
    try {
      payload = await verifyRefreshToken(refreshToken);
    } catch {
      throw new AppError({ code: ERROR_CODES.TOKEN_INVALID });
    }

    const tokenHash = hashToken(refreshToken);

    return transaction(async (client) => {
      const c = clientQuery(client);
      const session = await c.one<{
        id: string;
        user_id: string;
        family_id: string;
        refresh_token_hash: string;
        expires_at: Date;
        revoked_at: Date | null;
      }>('select id, user_id, family_id, refresh_token_hash, expires_at, revoked_at from auth_sessions where id = $1 for update', [
        payload.sid,
      ]);

      if (!session) throw new AppError({ code: ERROR_CODES.TOKEN_INVALID });

      if (session.revoked_at) {
        // Reuse of a revoked session: burn the whole family.
        await c.query('update auth_sessions set revoked_at = now(), revoked_reason = $2 where family_id = $1 and revoked_at is null', [
          session.family_id,
          'token_reuse_detected',
        ]);
        logEvent(LOG_EVENTS.TOKEN_REUSE_DETECTED, { userId: session.user_id, familyId: session.family_id });
        throw new AppError({ code: ERROR_CODES.TOKEN_INVALID });
      }

      if (session.refresh_token_hash !== tokenHash) {
        await c.query('update auth_sessions set revoked_at = now(), revoked_reason = $2 where family_id = $1 and revoked_at is null', [
          session.family_id,
          'token_mismatch',
        ]);
        logEvent(LOG_EVENTS.TOKEN_REUSE_DETECTED, { userId: session.user_id, familyId: session.family_id });
        throw new AppError({ code: ERROR_CODES.TOKEN_INVALID });
      }

      if (session.expires_at.getTime() <= Date.now()) {
        throw new AppError({ code: ERROR_CODES.TOKEN_EXPIRED });
      }

      const user = await c.one<UserRow>(
        `select id, email, phone, password_hash, role, status, email_verified_at,
                phone_verified_at, failed_login_count, locked_until, locale, deleted_at
         from users where id = $1 and deleted_at is null`,
        [session.user_id],
      );
      if (!user) throw unauthorized();
      if (user.status === 'SUSPENDED') throw new AppError({ code: ERROR_CODES.ACCOUNT_SUSPENDED });

      // Rotate: new session row in the same family, old one revoked.
      const newSessionId = randomUUID();
      const accessToken = await signAccessToken({ userId: user.id, role: user.role, sessionId: newSessionId });

      await c.query(
        `insert into auth_sessions (id, user_id, family_id, refresh_token_hash, user_agent, ip, expires_at)
         values ($1, $2, $3, '', $4, $5, now() + ($6 || ' seconds')::interval)`,
        [newSessionId, user.id, session.family_id, meta?.userAgent ?? null, meta?.ip ?? null, TOKEN_TTL.REFRESH_SECONDS],
      );

      const tokens = await issueTokens({
        userId: user.id,
        role: user.role,
        sessionId: newSessionId,
        familyId: session.family_id,
      });
      await c.query('update auth_sessions set refresh_token_hash = $2 where id = $1', [newSessionId, tokens.refreshTokenHash]);
      await c.query('update auth_sessions set revoked_at = now(), revoked_reason = $2, replaced_by_id = $3 where id = $1', [
        session.id,
        'rotated',
        newSessionId,
      ]);

      const providerId = await c.one<{ id: string }>('select id from providers where user_id = $1', [user.id]);
      logEvent(LOG_EVENTS.TOKEN_REFRESHED, { userId: user.id, familyId: session.family_id });

      return {
        user: toAuthenticatedUser(user, providerId?.id ?? null),
        tokens: { ...tokens, accessToken },
      };
    });
  }

  async logout(sessionId: string): Promise<void> {
    await transaction(async (client) => {
      await clientQuery(client).query(
        'update auth_sessions set revoked_at = now(), revoked_reason = $2 where id = $1 and revoked_at is null',
        [sessionId, 'logout'],
      );
    });
  }

  async logoutAllSessions(userId: string): Promise<number> {
    const result = await transaction(async (client) => {
      const res = await clientQuery(client).query(
        'update auth_sessions set revoked_at = now(), revoked_reason = $2 where user_id = $1 and revoked_at is null',
        [userId, 'logout_all'],
      );
      return res.rowCount ?? 0;
    });
    logEvent(LOG_EVENTS.USER_LOGGED_OUT, { userId, scope: 'all' });
    return result;
  }

  async listSessions(userId: string) {
    const rows = await import('../../db/pool.js').then((m) =>
      m.queryMany(
        `select id, user_agent, ip, device_label, created_at, last_used_at, expires_at, revoked_at
         from auth_sessions where user_id = $1 order by last_used_at desc limit 50`,
        [userId],
      ),
    );
    return rows;
  }

  // -------------------------------------------------------------------
  // Verification codes
  // -------------------------------------------------------------------

  async createVerificationCode(
    client: PoolClient,
    params: {
      userId: string;
      purpose: 'EMAIL_VERIFY' | 'PHONE_VERIFY' | 'PASSWORD_RESET' | 'LOGIN_OTP' | 'PHONE_CHANGE' | 'EMAIL_CHANGE';
      channel: 'EMAIL' | 'SMS';
      destination: string;
      code: string;
    },
  ): Promise<void> {
    const c = clientQuery(client);
    await c.query(
      `update verification_tokens set consumed_at = now()
       where user_id = $1 and purpose = $2 and consumed_at is null`,
      [params.userId, params.purpose],
    );
    await c.query(
      `insert into verification_tokens (user_id, purpose, channel, destination, token_hash, expires_at)
       values ($1, $2, $3, $4, $5, now() + ($6 || ' seconds')::interval)`,
      [
        params.userId,
        params.purpose,
        params.channel,
        params.destination,
        hashToken(params.code),
        env.OTP_TTL_SECONDS,
      ],
    );
  }

  async requestOtp(params: {
    userId: string;
    purpose: 'PHONE_VERIFY' | 'EMAIL_VERIFY' | 'PASSWORD_RESET';
    destination: string;
  }): Promise<{ sent: true; expiresInSeconds: number }> {
    const code = generateOtp();
    await transaction(async (client) => {
      await this.createVerificationCode(client, {
        userId: params.userId,
        purpose: params.purpose,
        channel: params.purpose === 'PHONE_VERIFY' ? 'SMS' : 'EMAIL',
        destination: params.destination,
        code,
      });
    });

    if (params.purpose === 'PHONE_VERIFY') {
      await this.notifier.sendSms(params.destination, `Your BIDLY verification code is ${code}. It expires in ${Math.round(env.OTP_TTL_SECONDS / 60)} minutes.`);
    } else {
      await this.sendVerificationEmail(params.destination, code);
    }

    return { sent: true, expiresInSeconds: env.OTP_TTL_SECONDS };
  }

  /** Verify and consume a one-time code, enforcing expiry and attempts. */
  async consumeVerificationCode(
    userId: string,
    purpose: 'EMAIL_VERIFY' | 'PHONE_VERIFY' | 'PASSWORD_RESET' | 'LOGIN_OTP' | 'PHONE_CHANGE' | 'EMAIL_CHANGE',
    code: string,
  ): Promise<void> {
    await transaction(async (client) => {
      const c = clientQuery(client);
      const token = await c.one<{
        id: string;
        token_hash: string;
        expires_at: Date;
        attempt_count: number;
        max_attempts: number;
      }>(
        `select id, token_hash, expires_at, attempt_count, max_attempts
         from verification_tokens
         where user_id = $1 and purpose = $2 and consumed_at is null
         order by created_at desc limit 1
         for update`,
        [userId, purpose],
      );

      if (!token) throw new AppError({ code: ERROR_CODES.EXPIRED, message: 'No active code was found. Please request a new one.' });
      if (token.expires_at.getTime() <= Date.now()) {
        await c.query('update verification_tokens set consumed_at = now() where id = $1', [token.id]);
        throw new AppError({ code: ERROR_CODES.EXPIRED, message: 'This code has expired. Please request a new one.' });
      }
      if (token.attempt_count >= token.max_attempts) {
        await c.query('update verification_tokens set consumed_at = now() where id = $1', [token.id]);
        throw new AppError({ code: ERROR_CODES.TOO_MANY_ATTEMPTS });
      }

      if (!timingSafeEqualString(token.token_hash, hashToken(code))) {
        await c.query('update verification_tokens set attempt_count = attempt_count + 1 where id = $1', [token.id]);
        throw new AppError({ code: ERROR_CODES.INVALID_CREDENTIALS, message: 'The code is incorrect.' });
      }

      await c.query('update verification_tokens set consumed_at = now() where id = $1', [token.id]);
    });
  }

  async verifyEmail(userId: string, code: string): Promise<void> {
    await this.consumeVerificationCode(userId, 'EMAIL_VERIFY', code);
    await transaction(async (client) => {
      await clientQuery(client).query(
        `update users set email_verified_at = now(),
               status = case when status = 'PENDING' then 'ACTIVE'::bidly_user_status else status end
         where id = $1`,
        [userId],
      );
    });
    logEvent(LOG_EVENTS.EMAIL_VERIFIED, { userId });
  }

  // -------------------------------------------------------------------
  // Password reset
  // -------------------------------------------------------------------

  async requestPasswordReset(email: string): Promise<{ sent: boolean }> {
    const row = await queryOne<{ id: string }>(
      'select id from users where lower(email) = lower($1) and deleted_at is null',
      [email],
    );
    // Always report success: never reveal whether an email is registered.
    if (!row) return { sent: true };

    const code = generateOtp();
    await transaction(async (client) => {
      await this.createVerificationCode(client, {
        userId: row.id,
        purpose: 'PASSWORD_RESET',
        channel: 'EMAIL',
        destination: email,
        code,
      });
    });

    await this.notifier.sendEmail(
      email,
      'Reset your BIDLY password',
      `Use this code to reset your password: ${code}. It expires in ${Math.round(env.OTP_TTL_SECONDS / 60)} minutes. If you did not request this, ignore this email.`,
    );
    logEvent(LOG_EVENTS.PASSWORD_RESET_REQUESTED, { userId: row.id });
    return { sent: true };
  }

  async resetPassword(email: string, code: string, newPassword: string): Promise<void> {
    const policy = checkPasswordPolicy(newPassword);
    if (!policy.valid) throw validationError({ password: policy.reasons });

    const row = await queryOne<{ id: string }>(
      'select id from users where lower(email) = lower($1) and deleted_at is null',
      [email],
    );
    if (!row) throw new AppError({ code: ERROR_CODES.INVALID_CREDENTIALS, message: 'The code is incorrect.' });

    await this.consumeVerificationCode(row.id, 'PASSWORD_RESET', code);

    const hash = await hashPassword(newPassword);
    await transaction(async (client) => {
      const c = clientQuery(client);
      await c.query('update users set password_hash = $2, failed_login_count = 0, locked_until = null where id = $1', [row.id, hash]);
      // Password change invalidates every existing session.
      await c.query('update auth_sessions set revoked_at = now(), revoked_reason = $2 where user_id = $1 and revoked_at is null', [
        row.id,
        'password_reset',
      ]);
    });
    logEvent(LOG_EVENTS.PASSWORD_RESET_COMPLETED, { userId: row.id });
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const policy = checkPasswordPolicy(newPassword);
    if (!policy.valid) throw validationError({ password: policy.reasons });

    const row = await queryOne<{ password_hash: string | null }>('select password_hash from users where id = $1', [userId]);
    if (!row?.password_hash) throw notFound('User');
    const ok = await verifyPassword(row.password_hash, currentPassword);
    if (!ok) throw new AppError({ code: ERROR_CODES.INVALID_CREDENTIALS, message: 'The current password is incorrect.' });

    const hash = await hashPassword(newPassword);
    await transaction(async (client) => {
      await clientQuery(client).query('update users set password_hash = $2 where id = $1', [userId, hash]);
    });
    logEvent(LOG_EVENTS.PASSWORD_RESET_COMPLETED, { userId, method: 'change' });
  }

  // -------------------------------------------------------------------
  // Account deletion
  // -------------------------------------------------------------------

  /**
   * Soft-delete an account and destroy all access. Financial history is
   * retained for legal/audit reasons; personal identifiers are scrambled.
   */
  async deleteAccount(userId: string, confirmation: string): Promise<void> {
    if (confirmation !== 'DELETE') {
      throw conflict('Type DELETE to confirm account deletion.');
    }
    await transaction(async (client) => {
      const c = clientQuery(client);
      await c.query(
        `update users set status = 'DELETED', deleted_at = now(),
               email = null, phone = null,
               password_hash = null
         where id = $1`,
        [userId],
      );
      await c.query('update auth_sessions set revoked_at = now(), revoked_reason = $2 where user_id = $1 and revoked_at is null', [
        userId,
        'account_deleted',
      ]);
      await c.query('update provider_locations set is_current = false where provider_id in (select id from providers where user_id = $1)', [userId]);
      await c.query('update providers set is_online = false, status = $2, deleted_at = now() where user_id = $1', [userId, 'DEACTIVATED']);
    });
    logEvent(LOG_EVENTS.ACCOUNT_DELETED, { userId });
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------

  private async sendVerificationEmail(email: string, code: string): Promise<void> {
    const requestId = newRequestId();
    try {
      await this.notifier.sendEmail(
        email,
        'Verify your BIDLY account',
        `Your BIDLY verification code is ${code}. It expires in ${Math.round(env.OTP_TTL_SECONDS / 60)} minutes.`,
      );
    } catch (err) {
      // Do not fail registration because the mail provider is down.
      logEvent('notification.email_failed', { requestId, err: err instanceof Error ? err.message : String(err) });
    }
  }

  /** Resolve a session id to a live auth context, or throw. */
  async resolveSession(sessionId: string): Promise<{ user: AuthenticatedUser; revoked: boolean }> {
    const session = await queryOne<{ id: string; revoked_at: Date | null; expires_at: Date; user_id: string }>(
      'select id, revoked_at, expires_at, user_id from auth_sessions where id = $1',
      [sessionId],
    );
    if (!session) throw new AppError({ code: ERROR_CODES.TOKEN_INVALID });
    if (session.revoked_at) throw new AppError({ code: ERROR_CODES.TOKEN_INVALID });
    if (session.expires_at.getTime() <= Date.now()) throw expired();

    const user = await queryOne<UserRow>(
      `select id, email, phone, password_hash, role, status, email_verified_at,
              phone_verified_at, failed_login_count, locked_until, locale, deleted_at
       from users where id = $1 and deleted_at is null`,
      [session.user_id],
    );
    if (!user) throw unauthorized();
    if (user.status === 'SUSPENDED') throw new AppError({ code: ERROR_CODES.ACCOUNT_SUSPENDED });

    const providerId = await loadProviderId(user.id);
    const admin = user.role === 'ADMIN' ? await loadAdminContext(user.id) : null;
    const authUser: AuthenticatedUser = {
      ...toAuthenticatedUser(user, providerId),
      adminRole: admin?.adminRole ?? null,
    };
    return { user: authUser, revoked: false };
  }

  /**
   * Extra authorization material for the request context: admin sub-role and
   * explicit permissions. Empty for non-admins.
   */
  async loadAuthorization(user: AuthenticatedUser): Promise<{ adminRole: AdminRole | null; permissions: string[] }> {
    if (user.role !== 'ADMIN') return { adminRole: null, permissions: [] };
    const admin = await loadAdminContext(user.id);
    return { adminRole: admin?.adminRole ?? null, permissions: admin?.permissions ?? [] };
  }
}

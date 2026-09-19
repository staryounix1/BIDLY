import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { env } from '@bidly/config';
import type { JwtAccessPayload, JwtRefreshPayload, UserRole } from '@bidly/types';

/**
 * Token architecture.
 *
 * - Short-lived **access token**: stateless JWT, carries `sub`, `role`, and the
 *   session id (`sid`) so a revoked session can still be rejected.
 * - Long-lived **refresh token**: opaque random string. Only its SHA-256 hash
 *   is stored. Rotated on every use within a `family_id`; reusing a rotated
 *   token revokes the whole family (theft detection).
 * - One-time codes (OTP): random digits, stored hashed, short TTL, attempt
 *   capped.
 */

const encoder = new TextEncoder();
const accessSecret = () => encoder.encode(env.AUTH_SECRET);
const refreshSecret = () => encoder.encode(env.REFRESH_SECRET);

const ACCESS_TTL_SECONDS = env.ACCESS_TOKEN_TTL_MINUTES * 60;
const REFRESH_TTL_SECONDS = env.SESSION_TTL_DAYS * 24 * 60 * 60;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
  familyId: string;
  expiresIn: number;
}

export async function signAccessToken(params: {
  userId: string;
  role: UserRole;
  sessionId: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: params.role, sid: params.sessionId, typ: 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(params.userId)
    .setIssuedAt(now)
    .setIssuer('bidly')
    .setAudience('bidly-api')
    .setExpirationTime(now + ACCESS_TTL_SECONDS)
    .setJti(randomUUID())
    .sign(accessSecret());
}

export async function verifyAccessToken(token: string): Promise<JwtAccessPayload> {
  const { payload } = await jwtVerify(token, accessSecret(), {
    issuer: 'bidly',
    audience: 'bidly-api',
  });
  if (payload.typ !== 'access' || typeof payload.sub !== 'string') {
    throw new Error('Invalid access token payload');
  }
  return payload as unknown as JwtAccessPayload;
}

export function generateRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function signRefreshToken(params: {
  userId: string;
  sessionId: string;
  familyId: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: params.sessionId, fam: params.familyId, typ: 'refresh' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(params.userId)
    .setIssuedAt(now)
    .setIssuer('bidly')
    .setAudience('bidly-refresh')
    .setExpirationTime(now + REFRESH_TTL_SECONDS)
    .setJti(randomUUID())
    .sign(refreshSecret());
}

export async function verifyRefreshToken(token: string): Promise<JwtRefreshPayload> {
  const { payload } = await jwtVerify(token, refreshSecret(), {
    issuer: 'bidly',
    audience: 'bidly-refresh',
  });
  if (payload.typ !== 'refresh' || typeof payload.sub !== 'string') {
    throw new Error('Invalid refresh token payload');
  }
  return payload as unknown as JwtRefreshPayload;
}

export async function issueTokens(params: {
  userId: string;
  role: UserRole;
  sessionId: string;
  familyId: string;
}): Promise<IssuedTokens> {
  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken({ userId: params.userId, role: params.role, sessionId: params.sessionId }),
    signRefreshToken(params),
  ]);
  return {
    accessToken,
    refreshToken,
    refreshTokenHash: hashToken(refreshToken),
    refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    familyId: params.familyId,
    expiresIn: ACCESS_TTL_SECONDS,
  };
}

// ---------------------------------------------------------------------
// One-time codes
// ---------------------------------------------------------------------

export function generateOtp(length = env.OTP_LENGTH): string {
  const digits = '0123456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += digits[(bytes[i] ?? 0) % 10];
  }
  return out;
}

export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Short, human-friendly, unambiguous codes for requests/jobs/support. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateHumanCode(prefix: string, length = 6): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[(bytes[i] ?? 0) % CODE_ALPHABET.length];
  }
  return `${prefix}-${out}`;
}

export const TOKEN_TTL = {
  ACCESS_SECONDS: ACCESS_TTL_SECONDS,
  REFRESH_SECONDS: REFRESH_TTL_SECONDS,
  OTP_SECONDS: env.OTP_TTL_SECONDS,
} as const;

export type { JWTPayload };

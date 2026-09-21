import { describe, expect, it } from 'vitest';
import { deriveActivation } from './auth.service.js';
import type { UserRow } from './auth.service.js';

/**
 * Activation derivation.
 *
 * The bug these guard: email/phone verification was mistaken for activation, so
 * a freshly registered account read as "activated" and the activation gate
 * never opened. Email verification governs sign-in, not usage.
 */
const base: UserRow = {
  id: '00000000-0000-4000-8000-000000000001',
  email: 'a@example.com',
  phone: null,
  password_hash: null,
  role: 'PROVIDER',
  status: 'ACTIVE',
  email_verified_at: new Date(),
  phone_verified_at: null,
  failed_login_count: 0,
  locked_until: null,
  locale: 'ar',
  deleted_at: null,
};

describe('deriveActivation', () => {
  it('is not complete for a fresh account, even with a verified email', () => {
    const a = deriveActivation({
      ...base,
      whatsapp_verified_at: null,
      identity_review_status: 'UNVERIFIED',
      activation_blocked_until: null,
    });
    expect(a).toEqual({
      whatsapp: false,
      identity: false,
      identityPending: false,
      blockedUntil: null,
      complete: false,
    });
  });

  it('is complete only when WhatsApp is confirmed AND identity is approved', () => {
    const a = deriveActivation({
      ...base,
      whatsapp_verified_at: new Date(),
      identity_review_status: 'VERIFIED',
      activation_blocked_until: null,
    });
    expect(a?.complete).toBe(true);
  });

  it('reports a pending identity review without calling it complete', () => {
    const a = deriveActivation({
      ...base,
      whatsapp_verified_at: new Date(),
      identity_review_status: 'PENDING',
      activation_blocked_until: null,
    });
    expect(a?.identityPending).toBe(true);
    expect(a?.identity).toBe(false);
    expect(a?.complete).toBe(false);
  });

  it('returns undefined when the row was not selected with activation columns', () => {
    expect(deriveActivation(base)).toBeUndefined();
  });
});

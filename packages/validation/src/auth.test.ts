import { describe, expect, it } from 'vitest';
import {
  changePasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  strongPasswordSchema,
  updateProfileSchema,
} from './auth.js';

describe('auth validation', () => {
  it('accepts a well-formed registration', () => {
    const result = registerSchema.safeParse({
      email: 'User@Example.com',
      password: 'Str0ngPass',
      fullName: 'Test User',
      role: 'CUSTOMER',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe('user@example.com');
    }
  });

  it('rejects weak or non-conforming passwords', () => {
    expect(strongPasswordSchema.safeParse('short').success).toBe(false);
    // A single character class is rejected even at length.
    expect(strongPasswordSchema.safeParse('alllowercase').success).toBe(false);
    // Two classes are accepted, matching the server-side policy.
    expect(strongPasswordSchema.safeParse('password1').success).toBe(true);
    expect(strongPasswordSchema.safeParse('Abcdef12').success).toBe(true);
    // Repeating the same character is rejected.
    expect(strongPasswordSchema.safeParse('aaaaAAAA1').success).toBe(false);
  });

  it('rejects invalid emails and privileged roles at registration', () => {
    expect(registerSchema.safeParse({ email: 'not-an-email', password: 'Abcdef12' }).success).toBe(false);
    expect(
      registerSchema.safeParse({ email: 'a@b.com', password: 'Abcdef12', role: 'ADMIN' }).success,
    ).toBe(false);
  });

  it('accepts a single login identifier (email or phone-shaped)', () => {
    expect(loginSchema.safeParse({ identifier: 'a@b.com', password: 'x' }).success).toBe(true);
    expect(loginSchema.safeParse({ identifier: '+212612345678', password: 'x' }).success).toBe(true);
    expect(loginSchema.safeParse({ identifier: 'ab', password: 'x' }).success).toBe(false);
  });

  it('requires a strong new password across reset and change flows', () => {
    expect(resetPasswordSchema.safeParse({ email: 'a@b.com', code: '123456', newPassword: 'weak' }).success).toBe(false);
    expect(
      resetPasswordSchema.safeParse({ email: 'a@b.com', code: '123456', newPassword: 'Abcdef12' }).success,
    ).toBe(true);
    expect(changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'Abcdef12' }).success).toBe(true);
  });

  it('validates the profile update shape', () => {
    expect(updateProfileSchema.safeParse({ fullName: 'New Name' }).success).toBe(true);
    expect(updateProfileSchema.safeParse({ avatarUrl: 'not-a-url' }).success).toBe(false);
    expect(updateProfileSchema.safeParse({ preferredLocale: 'de' }).success).toBe(false);
  });
});

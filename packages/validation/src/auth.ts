import { z } from 'zod';
import { LOCALES } from '@bidly/config';

/**
 * Authentication validation schemas.
 *
 * One source of truth shared by the API routes and the web/admin forms, so a
 * field is never accepted by the server that the client would reject, or vice
 * versa. Server-side validation always runs regardless of client checks.
 */

export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const authEmailSchema = z.string().trim().toLowerCase().email('Enter a valid email address.').max(254);

/**
 * Login accepts either an email or a phone number as a single identifier, so
 * this is deliberately permissive: presence and length only, never a strict
 * format, to avoid revealing which identifier type an account uses.
 */
export const loginIdentifierSchema = z.string().trim().min(3).max(254);

export const authPhoneSchema = z
  .string()
  .trim()
  .min(8)
  .max(20)
  .regex(/^\+?[0-9\s()-]+$/, 'Enter a valid phone number.');

/**
 * Password policy: length plus at least two character classes. Mirrors the
 * server-side `checkPasswordPolicy` so the form and the API agree.
 */
export const strongPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters.`)
  .max(PASSWORD_MAX_LENGTH, `Use at most ${PASSWORD_MAX_LENGTH} characters.`)
  .refine((v) => /[a-z]/.test(v) || /[A-Z]/.test(v), 'Include at least one letter.')
  .refine((v) => [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length >= 2, {
    message: 'Use at least two of: lowercase, uppercase, numbers, symbols.',
  })
  .refine((v) => !/(.)\1{3,}/.test(v), 'Avoid repeating the same character many times.');

export const userRoleSchema = z.enum(['CUSTOMER', 'PROVIDER']);
export const localeValueSchema = z.enum(LOCALES as unknown as [string, ...string[]]);

export const registerSchema = z.object({
  email: authEmailSchema,
  password: strongPasswordSchema,
  fullName: z.string().trim().min(1).max(120).optional(),
  phone: authPhoneSchema.optional(),
  locale: localeValueSchema.optional(),
  role: userRoleSchema.optional(),
});

export const loginSchema = z.object({
  identifier: loginIdentifierSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const verifyEmailSchema = z.object({
  code: z.string().min(4).max(8),
  email: authEmailSchema.optional(),
});

export const phoneStartSchema = z.object({
  phone: authPhoneSchema,
  fullName: z.string().trim().max(120).optional(),
  locale: localeValueSchema.optional(),
  role: userRoleSchema.optional(),
});

export const phoneVerifySchema = z.object({
  phone: authPhoneSchema,
  code: z.string().min(4).max(8),
});

export const forgotPasswordSchema = z.object({ email: authEmailSchema });

export const resetPasswordSchema = z.object({
  email: authEmailSchema,
  code: z.string().min(4).max(8),
  newPassword: strongPasswordSchema,
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: strongPasswordSchema,
});

export const updateProfileSchema = z.object({
  fullName: z.string().trim().min(1).max(120).optional(),
  displayName: z.string().trim().min(1).max(60).optional(),
  bio: z.string().trim().max(500).optional(),
  avatarUrl: z.string().url().max(2048).optional(),
  preferredLocale: z.enum(LOCALES as unknown as [string, ...string[]]).optional(),
  preferredCurrency: z.string().length(3).optional(),
  dateOfBirth: z.string().optional(),
  gender: z.string().max(20).optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

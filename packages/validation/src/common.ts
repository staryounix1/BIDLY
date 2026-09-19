import { z } from 'zod';
import { LOCALES } from '@bidly/config';

/**
 * Shared validation primitives.
 *
 * These schemas are the single source of truth for what a valid value looks
 * like across the API, the web app, and the admin console. They are framework
 * agnostic: Fastify route schemas and client forms both build on them.
 */

// --- identifiers ------------------------------------------------------

export const uuidSchema = z.string().uuid();

export const slugSchema = z
  .string()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers, and single hyphens.');

// --- money ------------------------------------------------------------

/**
 * Money is always an integer number of minor units (centimes). Rejecting
 * non-integers here prevents floating-point money from ever entering the
 * system through an API boundary.
 */
export const minorUnitsSchema = z
  .number()
  .int('Amounts must be whole minor units.')
  .nonnegative();

export const positiveMinorUnitsSchema = z
  .number()
  .int('Amounts must be whole minor units.')
  .positive();

export const currencySchema = z
  .string()
  .length(3)
  .regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter ISO 4217 code.');

// --- locale & market --------------------------------------------------

export const localeSchema = z.string().refine((v) => (LOCALES as readonly string[]).includes(v), {
  message: `Locale must be one of: ${LOCALES.join(', ')}.`,
});

export const countryCodeSchema = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, 'Country must be a 2-letter ISO 3166 code.');

export const timezoneSchema = z.string().min(1).max(64);

// --- contact ----------------------------------------------------------

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

/**
 * Phone numbers are stored in E.164. Moroccan numbers are accepted in local
 * form and normalised, but the rule is generic so other markets work.
 */
export const e164PhoneSchema = z
  .string()
  .trim()
  .regex(/^\+[1-9]\d{6,14}$/, 'Enter a valid phone number in international format.');

export function normalizeMoroccanPhone(input: string): string | null {
  const digits = input.replace(/[\s().-]/g, '');
  if (/^0[5-7]\d{8}$/.test(digits)) return `+212${digits.slice(1)}`;
  if (/^212[5-7]\d{8}$/.test(digits)) return `+${digits}`;
  if (/^\+212[5-7]\d{8}$/.test(digits)) return digits;
  return null;
}

export const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(128)
  .refine((v) => /[a-z]/.test(v), 'Include a lowercase letter.')
  .refine((v) => /[A-Z]/.test(v), 'Include an uppercase letter.')
  .refine((v) => /\d/.test(v), 'Include a number.');

export const displayNameSchema = z.string().trim().min(2).max(80);
export const fullNameSchema = z.string().trim().min(2).max(120);

// --- geography --------------------------------------------------------

export const latitudeSchema = z.number().min(-90).max(90);
export const longitudeSchema = z.number().min(-180).max(180);

export const coordinatesSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
});

// --- pagination -------------------------------------------------------

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

// --- media ------------------------------------------------------------

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const ALLOWED_DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;

export const imageMimeSchema = z.enum(ALLOWED_IMAGE_TYPES);
export const documentMimeSchema = z.enum(ALLOWED_DOCUMENT_TYPES);

export const urlSchema = z.string().url().max(2048);

// --- exports ----------------------------------------------------------

export { z };

import { describe, expect, it } from 'vitest';
import {
  currencySchema,
  e164PhoneSchema,
  emailSchema,
  minorUnitsSchema,
  normalizeMoroccanPhone,
  passwordSchema,
  positiveMinorUnitsSchema,
  slugSchema,
  uuidSchema,
  localeSchema,
} from './common.js';

describe('validation primitives', () => {
  it('accepts integers for money and rejects fractions', () => {
    expect(minorUnitsSchema.safeParse(1500).success).toBe(true);
    expect(minorUnitsSchema.safeParse(15.5).success).toBe(false);
    expect(minorUnitsSchema.safeParse(-1).success).toBe(false);
    expect(positiveMinorUnitsSchema.safeParse(0).success).toBe(false);
  });

  it('validates ISO currency and country-shaped codes', () => {
    expect(currencySchema.safeParse('MAD').success).toBe(true);
    expect(currencySchema.safeParse('mad').success).toBe(false);
    expect(currencySchema.safeParse('MADD').success).toBe(false);
  });

  it('normalises and validates phone numbers', () => {
    expect(e164PhoneSchema.safeParse('+212612345678').success).toBe(true);
    expect(e164PhoneSchema.safeParse('0612345678').success).toBe(false);
    expect(normalizeMoroccanPhone('0612345678')).toBe('+212612345678');
    expect(normalizeMoroccanPhone('+212 612-345-678')).toBe('+212612345678');
    expect(normalizeMoroccanPhone('12345')).toBeNull();
  });

  it('normalises emails', () => {
    const parsed = emailSchema.safeParse('  User@Example.COM  ');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe('user@example.com');
  });

  it('enforces password strength', () => {
    expect(passwordSchema.safeParse('Weakpass').success).toBe(false);
    expect(passwordSchema.safeParse('Str0ngPass').success).toBe(true);
    expect(passwordSchema.safeParse('short1A').success).toBe(false);
  });

  it('validates slugs and uuids', () => {
    expect(slugSchema.safeParse('house-cleaning').success).toBe(true);
    expect(slugSchema.safeParse('House_Cleaning').success).toBe(false);
    expect(uuidSchema.safeParse('550e8400-e29b-41d4-a716-446655440000').success).toBe(true);
    expect(uuidSchema.safeParse('not-a-uuid').success).toBe(false);
  });

  it('accepts the supported launch locales', () => {
    for (const locale of ['ar', 'fr', 'en']) {
      expect(localeSchema.safeParse(locale).success).toBe(true);
    }
    expect(localeSchema.safeParse('es').success).toBe(false);
  });
});

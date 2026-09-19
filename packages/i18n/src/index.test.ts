import { describe, expect, it } from 'vitest';
import {
  createTranslator,
  direction,
  formatDate,
  formatMoney,
  formatRelative,
  isRtl,
  resolveLocale,
  DEFAULT_LOCALE,
  LOCALE_META,
} from './index.js';

describe('locale resolution', () => {
  it('defaults to Arabic for the launch market', () => {
    expect(DEFAULT_LOCALE).toBe('ar');
  });

  it('resolves the first supported candidate', () => {
    expect(resolveLocale(['fr-MA', 'en'])).toBe('fr');
    expect(resolveLocale(['de', 'en'])).toBe('en');
  });

  it('ignores region subtags and unknown languages', () => {
    expect(resolveLocale(['ar-MA'])).toBe('ar');
    expect(resolveLocale(['zz', null, undefined])).toBe('ar');
  });

  it('marks Arabic as right-to-left', () => {
    expect(isRtl('ar')).toBe(true);
    expect(direction('ar')).toBe('rtl');
    expect(direction('fr')).toBe('ltr');
    expect(direction('en')).toBe('ltr');
  });

  it('exposes metadata for every launch locale', () => {
    for (const meta of Object.values(LOCALE_META)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(['ltr', 'rtl']).toContain(meta.dir);
    }
  });
});

describe('translator', () => {
  const catalogs = {
    ar: { greeting: 'مرحبا', nav: { jobs: 'المهام' }, welcome: 'مرحبا {name}' },
    fr: { greeting: 'Bonjour', nav: { jobs: 'Missions' }, welcome: 'Bonjour {name}' },
    en: { greeting: 'Hello', nav: { jobs: 'Jobs' }, welcome: 'Hello {name}' },
  } as const;

  it('resolves nested keys', () => {
    const t = createTranslator('fr', catalogs);
    expect(t('nav.jobs')).toBe('Missions');
  });

  it('interpolates variables', () => {
    const t = createTranslator('en', catalogs);
    expect(t('welcome', { name: 'Younes' })).toBe('Hello Younes');
  });

  it('falls back to the default locale for a missing key', () => {
    const t = createTranslator('en', { ar: { only: 'عربي' } });
    expect(t('only')).toBe('عربي');
  });

  it('returns the key itself when nothing matches', () => {
    const t = createTranslator('en', catalogs);
    expect(t('missing.key')).toBe('missing.key');
  });

  it('exposes the bound locale and direction', () => {
    const t = createTranslator('ar', catalogs);
    expect(t.locale).toBe('ar');
    expect(t.dir).toBe('rtl');
  });
});

describe('formatting', () => {
  it('formats minor units as currency', () => {
    const formatted = formatMoney(1250, { currency: 'MAD', locale: 'fr' });
    expect(formatted).toContain('12,50');
  });

  it('respects currencies with no minor units', () => {
    expect(formatMoney(5000, { currency: 'XOF', locale: 'fr' })).toContain('5');
  });

  it('formats a date in the requested timezone', () => {
    const formatted = formatDate('2026-01-15T12:00:00Z', 'en', 'Africa/Casablanca');
    expect(formatted).toContain('2026');
  });

  it('formats relative time', () => {
    const now = new Date('2026-01-15T12:00:00Z');
    const past = new Date('2026-01-15T09:00:00Z');
    expect(formatRelative(past, 'en', now)).toMatch(/3 hours ago/);
  });
});

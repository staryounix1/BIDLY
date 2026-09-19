import { LOCALES, type Locale } from '@bidly/config';

/**
 * Internationalisation foundation.
 *
 * The platform launches in Arabic, French, and English, and the market
 * (country, currency, timezone, locales) is configuration rather than code.
 * This module provides the parts every surface needs — locale metadata, text
 * direction, translation lookup, and locale-aware date/number/currency
 * formatting — without committing to a particular UI framework.
 *
 * Catalogs are plain nested objects keyed by locale. A missing key falls back
 * to the default locale, then to the key itself, so a half-translated screen
 * degrades to readable text rather than crashing.
 */

export interface LocaleMeta {
  code: Locale;
  /** Human label in the language itself, for language pickers. */
  label: string;
  /** Human label in English, for admin tooling. */
  labelEn: string;
  dir: 'ltr' | 'rtl';
  /** Default timezone for users of this locale, before per-user override. */
  timezone: string;
}

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  ar: { code: 'ar', label: 'العربية', labelEn: 'Arabic', dir: 'rtl', timezone: 'Africa/Casablanca' },
  fr: { code: 'fr', label: 'Français', labelEn: 'French', dir: 'ltr', timezone: 'Africa/Casablanca' },
  en: { code: 'en', label: 'English', labelEn: 'English', dir: 'ltr', timezone: 'Africa/Casablanca' },
};

export const DEFAULT_LOCALE: Locale = 'ar';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Resolve the best locale from an ordered list of preferences (for example an
 * `Accept-Language` header, a user setting, then the platform default).
 * Region subtags are ignored: `fr-MA` matches `fr`.
 */
export function resolveLocale(candidates: Array<string | null | undefined>, fallback: Locale = DEFAULT_LOCALE): Locale {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const base = candidate.toLowerCase().split('-')[0];
    if (isLocale(base)) return base;
  }
  return fallback;
}

export function isRtl(locale: Locale): boolean {
  return LOCALE_META[locale]?.dir === 'rtl';
}

export function direction(locale: Locale): 'ltr' | 'rtl' {
  return isRtl(locale) ? 'rtl' : 'ltr';
}

// ---------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------

export type Catalog = { [key: string]: string | Catalog };

function lookup(catalog: Catalog | undefined, key: string): string | undefined {
  if (!catalog) return undefined;
  const parts = key.split('.');
  let node: string | Catalog | undefined = catalog;
  for (const part of parts) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Catalog)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

export interface Translator {
  (key: string, vars?: Record<string, string | number>): string;
  locale: Locale;
  dir: 'ltr' | 'rtl';
}

/**
 * Build a translator bound to a locale and a set of catalogs. Interpolation
 * uses `{name}` placeholders.
 */
export function createTranslator(
  locale: Locale,
  catalogs: Partial<Record<Locale, Catalog>>,
  fallbackLocale: Locale = DEFAULT_LOCALE,
): Translator {
  const translate = (key: string, vars?: Record<string, string | number>): string => {
    const value =
      lookup(catalogs[locale], key) ??
      lookup(catalogs[fallbackLocale], key) ??
      key;
    if (!vars) return value;
    return value.replace(/\{(\w+)\}/g, (match, name: string) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match,
    );
  };
  translate.locale = locale;
  translate.dir = direction(locale);
  return translate as Translator;
}

// ---------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------

export interface MoneyFormatOptions {
  currency: string;
  locale: Locale;
  /** Display style; `code` shows "MAD 12.50", `symbol` shows the local symbol. */
  style?: 'symbol' | 'code';
}

/**
 * Format an integer minor-unit amount for display. The amount is divided by
 * the currency's minor-unit count only at the presentation boundary — never
 * in storage or arithmetic.
 */
export function formatMoney(
  amountMinor: number,
  opts: MoneyFormatOptions,
): string {
  const minorUnits = MINOR_UNITS[opts.currency.toUpperCase()] ?? 2;
  const value = amountMinor / 10 ** minorUnits;
  const formatter = new Intl.NumberFormat(opts.locale, {
    style: 'currency',
    currency: opts.currency,
    currencyDisplay: opts.style === 'code' ? 'code' : 'symbol',
    minimumFractionDigits: minorUnits,
    maximumFractionDigits: minorUnits,
  });
  return formatter.format(value);
}

const MINOR_UNITS: Record<string, number> = {
  MAD: 2, USD: 2, EUR: 2, GBP: 2,
  XOF: 0, XAF: 0, JPY: 0, KRW: 0,
  BHD: 3, KWD: 3,
};

export function formatDate(
  value: Date | string | number,
  locale: Locale,
  timezone: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: timezone }).format(date);
}

export function formatDateTime(
  value: Date | string | number,
  locale: Locale,
  timezone: string,
): string {
  return formatDate(value, locale, timezone, { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatNumber(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale).format(value);
}

/**
 * Relative time ("3 hours ago"), useful in job and message feeds. Kept here so
 * every surface renders it the same way.
 */
export function formatRelative(
  value: Date | string | number,
  locale: Locale,
  now: Date = new Date(),
): string {
  const date = value instanceof Date ? value : new Date(value);
  const diffSeconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const divisions: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [7, 'day'],
    [4.34524, 'week'],
    [12, 'month'],
  ];
  let duration = diffSeconds;
  for (const [amount, unit] of divisions) {
    if (Math.abs(duration) < amount) return rtf.format(Math.round(duration), unit);
    duration /= amount;
  }
  return rtf.format(Math.round(duration), 'year');
}

export { LOCALES };
export type { Locale };

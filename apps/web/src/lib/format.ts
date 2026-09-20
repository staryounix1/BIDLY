/**
 * Locale-aware display formatting for the marketplace screens.
 *
 * These helpers are the presentation boundary: amounts are stored and computed
 * in minor units, distances and ETAs in plain numbers, and only here do they
 * become strings a person reads. Every function is total — a missing or
 * nonsensical value renders a neutral placeholder instead of throwing or
 * leaking `NaN`/`undefined` into the UI.
 */

import { MINOR_UNITS } from '@bidly/config';

/** Currency scale (decimal digits) for a code, defaulting to 2. */
function minorUnitsFor(currency: string): number {
  const units = MINOR_UNITS[currency.toUpperCase()];
  return typeof units === 'number' ? units : 2;
}

/**
 * Format an integer amount in minor units (cents) for display.
 *
 * Amounts are integers in storage to avoid floating-point drift in prices and
 * commissions; dividing by the currency's minor-unit count is the last step
 * before the user sees them. Whole amounts drop the fractional part so a
 * budget reads as "120 MAD" rather than "120.00 MAD", which is what people
 * expect for round numbers while still showing cents when they matter.
 */
export function formatMoney(
  minor: number | null | undefined,
  currency: string,
  locale: string,
): string {
  if (typeof minor !== 'number' || !Number.isFinite(minor)) return '—';
  const code = currency && currency.trim() ? currency.toUpperCase() : 'MAD';
  const units = minorUnitsFor(code);
  const value = minor / 10 ** units;
  const isWholeUnit = Number.isInteger(value);

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'symbol',
      minimumFractionDigits: isWholeUnit ? 0 : units,
      maximumFractionDigits: units,
    }).format(value);
  } catch {
    // Unknown/invalid currency code reaching Intl should not blank the price.
    return `${value} ${code}`;
  }
}

/**
 * Format a distance in kilometres.
 *
 * Providers set a service radius and jobs show a distance; below one
 * kilometre the number needs a decimal to be useful at all, above it whole
 * kilometres are enough and read more calmly in a dense list.
 */
export function formatDistance(km: number | null | undefined, locale: string): string {
  if (typeof km !== 'number' || !Number.isFinite(km)) return '—';
  const value = Math.max(0, km);
  const fractionDigits = value < 10 ? 1 : 0;
  try {
    const number = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: fractionDigits,
    }).format(value);
    return `${number} km`;
  } catch {
    return `${value} km`;
  }
}

/**
 * Compact relative time: "now", "5 min", "2 h", "3 d".
 *
 * Feeds show many timestamps at once, where the full localized phrase from
 * `Intl.RelativeTimeFormat` is too wide; the unit abbreviation is short enough
 * to sit in a subtitle. Future timestamps are treated as "now" because feeds
 * only ever show the past, and a clock skew should not produce "in 2 min".
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  locale: string,
): string {
  if (typeof iso !== 'string' || iso.trim() === '') return '—';
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return '—';

  const elapsedSeconds = Math.max(0, (Date.now() - timestamp) / 1000);
  if (elapsedSeconds < 60) return formatUnitNumber(0, locale, 'now');

  const minutes = elapsedSeconds / 60;
  if (minutes < 60) return `${formatUnitNumber(Math.floor(minutes), locale)} min`;

  const hours = minutes / 60;
  if (hours < 24) return `${formatUnitNumber(Math.floor(hours), locale)} h`;

  const days = hours / 24;
  return `${formatUnitNumber(Math.floor(days), locale)} d`;
}

/**
 * Format an ETA in minutes as an approximate duration.
 *
 * Service providers quote arrival in minutes, but a 90-minute quote is clearer
 * as "1.5 h". Minutes stay exact under an hour so short, high-confidence
 * windows are not rounded away.
 */
export function formatEta(minutes: number | null | undefined, locale: string): string {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return '—';
  const value = Math.max(0, minutes);
  if (value < 60) return `${formatUnitNumber(Math.round(value), locale)} min`;
  const hours = value / 60;
  const formatted = formatUnitNumber(Math.round(hours * 10) / 10, locale, {
    maximumFractionDigits: 1,
  });
  return `${formatted} h`;
}

/**
 * Format a count for display next to a translated noun.
 *
 * Arabic has distinct plural categories (zero, one, two, a few for 3–10, and
 * the 11+ form), and the correct noun for each is supplied by the caller's
 * i18n string — so this only needs to render the numeral correctly for the
 * locale, not choose the noun. Returning the formatted numeral keeps that
 * separation clean and avoids duplicating Arabic plural rules here.
 *
 * A non-finite or missing count formats to zero, matching the empty state.
 */
export function pluralCount(n: number, locale: string): string {
  const value = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

/** Locale-formatted integer/decimal, with an optional "now" substitute. */
function formatUnitNumber(
  value: number,
  locale: string,
  substitute?: string | Intl.NumberFormatOptions,
): string {
  if (typeof substitute === 'string') return substitute;
  try {
    return new Intl.NumberFormat(locale, substitute).format(value);
  } catch {
    return String(value);
  }
}

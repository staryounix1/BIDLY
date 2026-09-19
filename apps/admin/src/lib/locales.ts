/**
 * Locale configuration for the web app.
 *
 * The set of supported locales and the default come from platform config; the
 * URL carries the locale as the first path segment, which keeps every page
 * crawlable and shareable in the user's language.
 */
import { LOCALES } from '@bidly/config';

export const locales = LOCALES;
export const defaultLocale = 'ar' as const;

export type AppLocale = (typeof locales)[number];

export function isAppLocale(value: string): value is AppLocale {
  return (locales as readonly string[]).includes(value);
}

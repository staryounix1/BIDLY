'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createTranslator, isRtl, type Catalog, type Locale } from '@bidly/i18n';
import ar from '@/messages/ar.json';
import fr from '@/messages/fr.json';
import en from '@/messages/en.json';

/**
 * Client-side i18n provider.
 *
 * The locale is decided on the server (from the URL segment) and passed down,
 * so the first paint is already in the right language and direction. The
 * catalogs are small and statically imported, which keeps switching instant.
 */
const catalogs: Record<Locale, Catalog> = {
  ar: ar as Catalog,
  fr: fr as Catalog,
  en: en as Catalog,
};

interface I18nContextValue {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  t: ReturnType<typeof createTranslator>;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<I18nContextValue>(() => {
    const dir = isRtl(locale) ? 'rtl' : 'ltr';
    return { locale, dir, t: createTranslator(locale, catalogs) };
  }, [locale]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside an I18nProvider.');
  return ctx;
}

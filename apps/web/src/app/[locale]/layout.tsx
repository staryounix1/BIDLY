import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { isRtl, type Locale } from '@bidly/i18n';
import { I18nProvider } from '@/lib/i18n-provider';
import { AuthProvider } from '@/lib/auth-provider';
import { AppHeader } from '@/lib/app-header';
import { isAppLocale, locales } from '@/lib/locales';
import '@/app/globals.css';

export const metadata: Metadata = {
  title: 'BIDLY',
  description: 'Request any service and let local providers compete for your job.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f172a',
};

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

/**
 * Root layout.
 *
 * Sets `lang` and `dir` from the locale segment so Arabic renders right-to-left
 * from the very first paint, with no flash of the wrong direction.
 */
export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  if (!isAppLocale(locale)) notFound();

  const typedLocale = locale as Locale;

  return (
    <html lang={typedLocale} dir={isRtl(typedLocale) ? 'rtl' : 'ltr'} suppressHydrationWarning>
      <body>
        <I18nProvider locale={typedLocale}>
          <AuthProvider>
            <AppHeader />
            {children}
          </AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}

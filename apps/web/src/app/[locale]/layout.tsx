import type { Metadata, Viewport } from 'next';
import { notFound } from 'next/navigation';
import { isRtl, type Locale } from '@bidly/i18n';
import { I18nProvider } from '@/lib/i18n-provider';
import { AuthProvider } from '@/lib/auth-provider';
import { AppHeader, BottomNav } from '@/lib/app-header';
import { ActivationGate } from '@/lib/activation-gate';
import { isAppLocale, locales } from '@/lib/locales';
import '@/app/globals.css';
// Leaflet's own stylesheet, so the map chrome (panes, zoom control, attribution)
// is laid out correctly. Imported here rather than inside the map component:
// a component-level CSS import still ends up in the same chunk, and this keeps
// the dependency explicit and in one place.
import 'leaflet/dist/leaflet.css';

export const metadata: Metadata = {
  title: {
    default: 'Khdemli — اطلب أي خدمة ودع الحرفيين يتنافسون',
    template: '%s · Khdemli',
  },
  description:
    'Khdemli منصة مغربية للخدمات: انشر طلبك، حدّد السعر الذي يناسبك، ودع الحرفيين القريبين يتنافسون بعروضهم.',
  manifest: '/manifest.webmanifest',
  applicationName: 'Khdemli',
  appleWebApp: {
    capable: true,
    title: 'Khdemli',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    icon: [
      { url: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/apple-icon.png', sizes: '180x180', type: 'image/png' }],
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#32F4BA',
  viewportFit: 'cover',
};

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

/**
 * Root layout.
 *
 * Sets `lang` and `dir` from the locale segment so Arabic renders right-to-left
 * from the very first paint, with no flash of the wrong direction. The fixed
 * bottom nav needs bottom padding on every page, so the shell owns it here
 * rather than in each screen.
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
            <main style={{ paddingBottom: 'calc(4.5rem + env(safe-area-inset-bottom))' }}>
              {children}
            </main>
            <BottomNav />
            {/* Blocks the app until a new account is activated. Sits last so it
                paints over the header and nav. */}
            <ActivationGate />
          </AuthProvider>
        </I18nProvider>
      </body>
    </html>
  );
}

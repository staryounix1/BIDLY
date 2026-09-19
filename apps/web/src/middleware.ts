import { NextResponse, type NextRequest } from 'next/server';
import { defaultLocale, locales } from '@/lib/locales';

const LOCALE_COOKIE = 'BIDLY_LOCALE';
const PUBLIC_FILE = /\.(.*)$/;

/**
 * Ensures every page URL carries a locale segment.
 *
 * Preference order: an explicit cookie (the user's last choice) -> the
 * `Accept-Language` header -> the platform default. This keeps links
 * shareable and SEO-friendly while still feeling automatic to the visitor.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/api') ||
    PUBLIC_FILE.test(pathname)
  ) {
    return NextResponse.next();
  }

  const hasLocale = locales.some(
    (locale) => pathname === `/${locale}` || pathname.startsWith(`/${locale}/`),
  );
  if (hasLocale) return NextResponse.next();

  const cookieLocale = request.cookies.get(LOCALE_COOKIE)?.value;
  const locale =
    (cookieLocale && (locales as readonly string[]).includes(cookieLocale) && cookieLocale) ||
    negotiate(request.headers.get('accept-language')) ||
    defaultLocale;

  const url = request.nextUrl.clone();
  url.pathname = `/${locale}${pathname === '/' ? '' : pathname}`;
  return NextResponse.redirect(url);
}

function negotiate(header: string | null): string | null {
  if (!header) return null;
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, q] = part.trim().split(';q=');
      return { tag: (tag ?? '').trim().toLowerCase(), q: q ? Number(q) : 1 };
    })
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const base = tag.split('-')[0];
    if (base && (locales as readonly string[]).includes(base)) return base;
  }
  return null;
}

export const config = {
  matcher: ['/((?!_next|api|favicon.ico).*)'],
};

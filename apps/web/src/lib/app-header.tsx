'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from './auth-provider';
import { useI18n } from './i18n-provider';
import { NotificationBell } from './notification-bell';

/**
 * Top navigation shared by the customer-facing pages.
 *
 * Links are locale-prefixed and the active route is highlighted. Signed-in
 * users get an account menu; visitors get sign-in / sign-up. This is purely
 * presentational — route access is still enforced by RequireAuth and, above
 * all, by the API.
 */
export function AppHeader() {
  const { t, locale } = useI18n();
  const { user, ready, signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const links: Array<{ href: string; key: string }> = [
    { href: `/${locale}`, key: 'home' },
    { href: `/${locale}/services`, key: 'services' },
  ];

  if (user?.role === 'CUSTOMER') {
    links.push({ href: `/${locale}/dashboard`, key: 'dashboard' });
    links.push({ href: `/${locale}/requests`, key: 'requests' });
    links.push({ href: `/${locale}/jobs`, key: 'jobs' });
    links.push({ href: `/${locale}/messages`, key: 'messages' });
  }

  if (user?.role === 'PROVIDER' || user?.role === 'ADMIN') {
    links.push({ href: `/${locale}/provider/dashboard`, key: 'providerDash' });
    links.push({ href: `/${locale}/provider/requests`, key: 'feed' });
    links.push({ href: `/${locale}/provider/jobs`, key: 'providerJobs' });
    links.push({ href: `/${locale}/provider/offers`, key: 'offers' });
    links.push({ href: `/${locale}/provider/history`, key: 'providerHistory' });
    links.push({ href: `/${locale}/wallet`, key: 'wallet' });
    links.push({ href: `/${locale}/messages`, key: 'messages' });
  }

  if (user?.role === 'ADMIN') {
    links.push({ href: `/${locale}/admin`, key: 'admin' });
  }

  const isActive = (href: string) =>
    href === `/${locale}` ? pathname === href : pathname.startsWith(href);

  return (
    <header className="sticky top-0 z-20 border-b border-black/10 bg-white/80 backdrop-blur dark:border-white/10 dark:bg-slate-950/80">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
        <div className="flex items-center gap-5">
          <Link href={`/${locale}`} className="text-lg font-black tracking-tight">
            {t('app.name')}
          </Link>
          <nav className="hidden gap-4 text-sm sm:flex">
            {links.map((l) => (
              <Link
                key={l.key}
                href={l.href}
                className={isActive(l.href) ? 'font-semibold underline' : 'opacity-70 hover:opacity-100'}
              >
                {t(`nav.${l.key}`)}
              </Link>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-3 text-sm">
          {ready && user ? (
            <>
              <NotificationBell />
              {user.role === 'CUSTOMER' && (
                <Link
                  href={`/${locale}/requests/new`}
                  className="rounded-lg bg-slate-900 px-3 py-1.5 font-medium text-white dark:bg-white dark:text-slate-900"
                >
                  {t('nav.newRequest')}
                </Link>
              )}
              <Link
                href={user.role === 'PROVIDER' ? `/${locale}/provider/profile` : `/${locale}/profile`}
                className="opacity-70 hover:opacity-100"
              >
                {t('nav.profile')}
              </Link>
              <button
                onClick={async () => {
                  await signOut();
                  router.push(`/${locale}`);
                }}
                className="opacity-70 hover:opacity-100"
              >
                {t('common.signOut')}
              </button>
            </>
          ) : ready ? (
            <>
              <Link href={`/${locale}/login`} className="opacity-70 hover:opacity-100">
                {t('common.signIn')}
              </Link>
              <Link
                href={`/${locale}/register`}
                className="rounded-lg border border-black/15 px-3 py-1.5 font-medium dark:border-white/20"
              >
                {t('common.signUp')}
              </Link>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}

'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAuth } from './auth-provider';
import { useI18n } from './i18n-provider';
import { NotificationBell } from './notification-bell';
import { CategoryIcon, KhdemliLogo } from './icons';

/**
 * App chrome — header and thumb-reach bottom nav.
 *
 * The product is used one-handed next to a job site, so the primary
 * destinations live at the bottom of the screen and the header only carries
 * identity: where you are, and whether you have notifications.
 */

interface Tab {
  href: string;
  key: string;
  icon: string;
}

export function AppHeader() {
  const { t, locale } = useI18n();
  const { user, ready, signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const homeHref = `/${locale}`;
  const isHome = pathname === homeHref;

  /**
   * Leaving is a first-class action, not a hidden one: shared phones are
   * normal, so the header always offers a way out of the current account.
   */
  const onSignOut = async () => {
    setBusy(true);
    try {
      await signOut();
      router.push(homeHref);
    } finally {
      setBusy(false);
    }
  };

  return (
    <header className="surface-blur sticky top-0 z-20 border-b border-[rgb(var(--line))]">
      <div className="container-page">
        <div className="flex items-center justify-between gap-3 py-3">
          <Link href={homeHref} aria-label={t('app.name')}>
            <KhdemliLogo size={30} />
          </Link>

          <div className="flex items-center gap-2 text-sm">
            {ready && user ? (
              <>
                <NotificationBell />
                <Link
                  href={user.role === 'PROVIDER' ? `/${locale}/provider/profile` : `/${locale}/profile`}
                  className="btn btn-secondary h-10 w-10 !p-0"
                  aria-label={t('nav.profile')}
                >
                  <CategoryIcon name="user" size={18} />
                </Link>
                <button
                  type="button"
                  onClick={onSignOut}
                  disabled={busy}
                  className="btn btn-secondary h-10 !px-3 gap-1.5 text-xs font-bold disabled:opacity-60"
                  aria-label={t('common.signOut')}
                >
                  <CategoryIcon name="arrow" size={15} className="rotate-180" />
                  {t('common.signOut')}
                </button>
              </>
            ) : ready ? (
              <Link href={`/${locale}/login`} className="btn btn-secondary">
                {t('common.signIn')}
              </Link>
            ) : null}
          </div>
        </div>
      </div>

      {/* A thin aqua progress hairline keeps the bar from feeling dead. */}
      {!isHome && <div className="h-0.5 w-full bg-[rgb(var(--brand-500)/0.35)]" />}

      {/* A pending identity review is a visible state, not a silent one: the
          user may browse while they wait, and this is how they get back to the
          gate after dismissing it. */}
      {ready && user && user.activation?.identityPending && (
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('khdemli:open-activation'))}
          className="flex w-full items-center justify-center gap-2 bg-[rgb(var(--brand-500)/0.12)] px-4 py-2 text-xs font-bold text-[rgb(var(--brand-700))]"
        >
          <CategoryIcon name="clock" size={15} />
          {t('activation.reviewBanner')}
        </button>
      )}
    </header>
  );
}

/**
 * Bottom navigation. Rendered per role so a provider never sees customer tabs
 * (and vice versa); visitors get browse + sign-in prompts instead.
 */
export function BottomNav() {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const pathname = usePathname();

  let tabs: Tab[];

  if (!user) {
    tabs = [
      { href: `/${locale}`, key: 'home', icon: 'home' },
      { href: `/${locale}/services`, key: 'services', icon: 'layers' },
      { href: `/${locale}/requests/new`, key: 'newRequest', icon: 'plus' },
      { href: `/${locale}/login`, key: 'signIn', icon: 'user' },
    ];
  } else if (user.role === 'PROVIDER') {
    // Until identity is approved a provider has not been vetted, so the
    // available-requests feed stays hidden: they can set up, see their own
    // jobs and talk to people, but they cannot browse work to take on.
    const vetted = user.activation?.identity ?? true;
    tabs = vetted
      ? [
          { href: `/${locale}/provider/dashboard`, key: 'providerDash', icon: 'home' },
          { href: `/${locale}/provider/requests`, key: 'feed', icon: 'radar' },
          { href: `/${locale}/provider/jobs`, key: 'providerJobs', icon: 'route' },
          { href: `/${locale}/provider/history`, key: 'providerHistory', icon: 'wallet' },
          { href: `/${locale}/messages`, key: 'messages', icon: 'chat' },
        ]
      : [
          { href: `/${locale}/provider/dashboard`, key: 'providerDash', icon: 'home' },
          { href: `/${locale}/provider/jobs`, key: 'providerJobs', icon: 'route' },
          { href: `/${locale}/messages`, key: 'messages', icon: 'chat' },
          { href: `/${locale}/provider/history`, key: 'providerHistory', icon: 'wallet' },
        ];
  } else if (user.role === 'ADMIN') {
    // Staff run the platform, not the marketplace: the admin console replaces
    // the provider tabs. Sending an admin to /provider/* always 403s, because
    // those routes are gated on the PROVIDER role.
    tabs = [
      { href: `/${locale}/admin`, key: 'admin', icon: 'shield' },
      { href: `/${locale}/requests`, key: 'requests', icon: 'checklist' },
      { href: `/${locale}/messages`, key: 'messages', icon: 'chat' },
      { href: `/${locale}/wallet`, key: 'wallet', icon: 'wallet' },
      { href: `/${locale}/profile`, key: 'profile', icon: 'user' },
    ];
  } else {
    tabs = [
      { href: `/${locale}`, key: 'home', icon: 'home' },
      { href: `/${locale}/services`, key: 'services', icon: 'layers' },
      { href: `/${locale}/requests`, key: 'requests', icon: 'checklist' },
      { href: `/${locale}/messages`, key: 'messages', icon: 'chat' },
      { href: `/${locale}/profile`, key: 'profile', icon: 'user' },
    ];
  }

  const isActive = (href: string) =>
    href === `/${locale}` ? pathname === href : pathname.startsWith(href);

  return (
    <nav
      className="surface-blur fixed inset-x-0 bottom-0 z-20 border-t border-[rgb(var(--line))]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="app-shell flex items-stretch justify-around px-1">
        {tabs.map((tab) => {
          const active = isActive(tab.href);
          return (
            <Link
              key={tab.key}
              href={tab.href}
              className="relative flex flex-1 flex-col items-center gap-1 py-2.5"
              style={{
                color: active ? 'rgb(var(--brand-700))' : 'rgb(var(--fg-muted))',
              }}
            >
              {active && (
                <span className="absolute top-0 h-1 w-8 rounded-full bg-[rgb(var(--brand-500))]" />
              )}
              <CategoryIcon name={tab.icon} size={22} />
              <span className="text-[0.6875rem] font-bold">{t(`nav.${tab.key}`)}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * Site footer with the copyright line. Kept out of the fixed chrome so it only
 * appears where there is real page content to close.
 */
export function AppFooter() {
  return (
    <footer className="border-t border-[rgb(var(--line))] px-4 py-8 text-center">
      <p className="text-xs font-semibold text-[rgb(var(--fg-subtle))]">
        © {new Date().getFullYear()} Khdemli — جميع الحقوق محفوظة
      </p>
    </footer>
  );
}

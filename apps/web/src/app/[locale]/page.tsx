'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n-provider';
import { useAuth } from '@/lib/auth-provider';

export default function HomePage() {
  const { t, locale } = useI18n();
  const { user, ready, signOut } = useAuth();
  const router = useRouter();

  return (
    <main className="mx-auto flex min-h-[calc(100dvh-57px)] max-w-3xl flex-col items-center justify-center gap-8 px-6 text-center">
      <div className="space-y-3">
        <h1 className="text-5xl font-bold tracking-tight">{t('app.name')}</h1>
        <p className="text-lg opacity-80">{t('app.tagline')}</p>
      </div>

      <div className="flex flex-wrap justify-center gap-3">
        <Link
          href={`/${locale}/services`}
          className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white dark:bg-white dark:text-slate-900"
        >
          {t('catalog.title')}
        </Link>
        {ready && user ? (
          <Link
            href={`/${locale}/requests`}
            className="rounded-lg border border-black/15 px-5 py-2.5 text-sm font-medium dark:border-white/20"
          >
            {t('request.myTitle')}
          </Link>
        ) : null}
      </div>

      {ready && user ? (
        <div className="flex flex-col items-center gap-2">
          <p className="text-sm opacity-70">
            {user.email ?? user.phone} · {user.role}
          </p>
          <div className="flex gap-3">
            <Link href={`/${locale}/profile`} className="text-sm underline">
              {t('nav.profile')}
            </Link>
            <button
              onClick={async () => {
                await signOut();
                router.refresh();
              }}
              className="text-sm underline"
            >
              {t('common.signOut')}
            </button>
          </div>
        </div>
      ) : ready ? (
        <div className="flex gap-3">
          <Link
            href={`/${locale}/register`}
            className="rounded-lg border border-black/15 px-5 py-2.5 text-sm font-medium dark:border-white/20"
          >
            {t('common.signUp')}
          </Link>
          <Link href={`/${locale}/login`} className="rounded-lg px-5 py-2.5 text-sm font-medium underline">
            {t('common.signIn')}
          </Link>
        </div>
      ) : (
        <p className="text-sm opacity-50">{t('common.loading')}</p>
      )}

      <footer className="flex gap-4 text-sm opacity-60">
        {(['ar', 'fr', 'en'] as const).map((code) => (
          <Link key={code} href={`/${code}`} className={code === locale ? 'font-bold underline' : 'hover:underline'}>
            {code.toUpperCase()}
          </Link>
        ))}
      </footer>
    </main>
  );
}

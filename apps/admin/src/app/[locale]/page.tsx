'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';

const SECTIONS = ['users', 'providers', 'disputes', 'payouts', 'settings'] as const;

export default function AdminHomePage() {
  const { t, locale } = useI18n();

  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <header className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight">BIDLY Admin</h1>
        <p className="mt-2 text-sm opacity-70">{t('app.tagline')}</p>
      </header>

      <nav aria-label="Admin sections" className="grid gap-3 sm:grid-cols-3">
        {SECTIONS.map((section) => (
          <div
            key={section}
            className="rounded-xl border border-black/10 p-4 text-sm capitalize dark:border-white/15"
          >
            {t(`admin.sections.${section}`) || section}
          </div>
        ))}
      </nav>

      <footer className="mt-12 flex gap-4 text-sm opacity-60">
        {(['ar', 'fr', 'en'] as const).map((code) => (
          <Link
            key={code}
            href={`/${code}`}
            className={code === locale ? 'font-bold underline' : 'hover:underline'}
          >
            {code.toUpperCase()}
          </Link>
        ))}
      </footer>
    </main>
  );
}

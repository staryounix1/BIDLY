'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-provider';
import { useI18n } from '@/lib/i18n-provider';
import { ApiError } from '@/lib/auth-api';

/**
 * Sign-in page. Posts to POST /auth/login through the AuthProvider and, on
 * success, sends the user to the home page in their locale. Errors from the
 * API are shown with their safe, user-facing message.
 */
export default function LoginPage() {
  const { t, locale } = useI18n();
  const { signIn, isAuthenticated, ready } = useAuth();
  const router = useRouter();

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(identifier, password);
      router.push(`/${locale}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  if (ready && isAuthenticated) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <p className="opacity-70">{t('auth.welcomeBack')}</p>
        <Link href={`/${locale}`} className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white">
          {t('nav.home')}
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6">
      <header className="text-center">
        <h1 className="text-3xl font-bold">{t('auth.signInTitle')}</h1>
        <p className="mt-1 text-sm opacity-70">{t('auth.signInSubtitle')}</p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('auth.identifier')}
          <input
            type="text"
            autoComplete="username"
            required
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            className="rounded-lg border border-black/15 bg-transparent px-3 py-2 font-normal outline-none focus:border-slate-900 dark:border-white/20 dark:focus:border-white"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('auth.password')}
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="rounded-lg border border-black/15 bg-transparent px-3 py-2 font-normal outline-none focus:border-slate-900 dark:border-white/20 dark:focus:border-white"
          />
        </label>

        {error && (
          <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
        >
          {busy ? t('common.loading') : t('common.signIn')}
        </button>
      </form>

      <p className="text-center text-sm opacity-70">
        {t('auth.noAccount')}{' '}
        <Link href={`/${locale}/register`} className="font-medium underline">
          {t('common.signUp')}
        </Link>
      </p>
    </main>
  );
}

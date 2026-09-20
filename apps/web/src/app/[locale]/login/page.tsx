'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-provider';
import { useI18n } from '@/lib/i18n-provider';
import { ApiError } from '@/lib/auth-api';
import { CategoryIcon, KhdemliMark } from '@/lib/icons';
import { Spinner } from '@/lib/ui';

/**
 * Sign-in. Posts to POST /auth/login through the AuthProvider and, on success,
 * sends the user home in their locale. Errors are shown with their safe,
 * user-facing message.
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
      <div className="app-shell container-page flex flex-col items-center justify-center gap-4 py-24 text-center">
        <KhdemliMark size={52} />
        <p className="font-semibold text-[rgb(var(--fg-muted))]">{t('auth.welcomeBack')}</p>
        <Link href={`/${locale}`} className="btn btn-primary">
          {t('nav.home')}
        </Link>
      </div>
    );
  }

  return (
    <div className="app-shell container-page flex flex-col justify-center py-10">
      <header className="mb-7 flex flex-col items-center text-center">
        <KhdemliMark size={58} />
        <h1 className="mt-4 text-3xl font-black tracking-tight">{t('auth.signInTitle')}</h1>
        <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('auth.signInSubtitle')}</p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <label className="block">
          <span className="label">{t('auth.identifier')}</span>
          <div className="relative">
            <CategoryIcon
              name="user"
              size={19}
              className="pointer-events-none absolute inset-y-0 start-3.5 my-auto text-[rgb(var(--fg-subtle))]"
            />
            <input
              type="text"
              autoComplete="username"
              required
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              className="input ps-11"
            />
          </div>
        </label>

        <label className="block">
          <span className="label">{t('auth.password')}</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
        </label>

        {error && (
          <p
            role="alert"
            className="rounded-xl border border-[rgb(var(--danger)/0.35)] bg-[rgb(var(--danger)/0.08)] px-4 py-3 text-sm font-semibold text-[rgb(var(--danger))]"
          >
            {error}
          </p>
        )}

        <button type="submit" disabled={busy} className="btn btn-primary btn-block">
          {busy ? <Spinner size={18} /> : <CategoryIcon name="arrow" size={19} className="rtl:rotate-180" />}
          {t('common.signIn')}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-[rgb(var(--fg-muted))]">
        {t('auth.noAccount')}{' '}
        <Link href={`/${locale}/register`} className="font-bold text-[rgb(var(--brand-700))]">
          {t('common.signUp')}
        </Link>
      </p>
    </div>
  );
}

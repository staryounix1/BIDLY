'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-provider';
import { useI18n } from '@/lib/i18n-provider';
import { ApiError } from '@/lib/auth-api';
import { registerSchema } from '@bidly/validation';

/**
 * Sign-up page.
 *
 * Validates with the shared @bidly/validation schema (the same rules the API
 * enforces server-side) before submitting. On success the account exists in a
 * pending state and an email verification code has been sent; the API never
 * returns a password or hash.
 */
export default function RegisterPage() {
  const { t, locale } = useI18n();
  const { signUp } = useAuth();
  const router = useRouter();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'CUSTOMER' | 'PROVIDER'>('CUSTOMER');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);

    const parsed = registerSchema.safeParse({
      email,
      password,
      ...(fullName ? { fullName } : {}),
      ...(phone ? { phone } : {}),
      role,
      locale,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? t('common.error'));
      return;
    }

    setBusy(true);
    try {
      await signUp(parsed.data);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <h1 className="text-2xl font-bold">{t('auth.verifyNotice')}</h1>
        <Link href={`/${locale}/login`} className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white">
          {t('common.signIn')}
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-6 px-6 py-10">
      <header className="text-center">
        <h1 className="text-3xl font-bold">{t('auth.signUpTitle')}</h1>
        <p className="mt-1 text-sm opacity-70">{t('auth.signUpSubtitle')}</p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field label={t('auth.fullName')}>
          <input
            type="text"
            autoComplete="name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label={t('auth.email')}>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label={t('auth.phone')}>
          <input
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={inputClass}
          />
        </Field>

        <Field label={t('auth.password')}>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
          />
        </Field>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium">{t('auth.accountType')}</legend>
          <div className="flex gap-3">
            {(['CUSTOMER', 'PROVIDER'] as const).map((option) => (
              <label
                key={option}
                className={`flex-1 cursor-pointer rounded-lg border px-3 py-2 text-center text-sm ${
                  role === option ? 'border-slate-900 font-semibold dark:border-white' : 'border-black/15 dark:border-white/20'
                }`}
              >
                <input
                  type="radio"
                  name="role"
                  value={option}
                  checked={role === option}
                  onChange={() => setRole(option)}
                  className="sr-only"
                />
                {option === 'CUSTOMER' ? t('auth.customer') : t('auth.provider')}
              </label>
            ))}
          </div>
        </fieldset>

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
          {busy ? t('common.loading') : t('common.signUp')}
        </button>
      </form>

      <p className="text-center text-sm opacity-70">
        {t('auth.haveAccount')}{' '}
        <Link href={`/${locale}/login`} className="font-medium underline">
          {t('common.signIn')}
        </Link>
      </p>
    </main>
  );
}

const inputClass =
  'rounded-lg border border-black/15 bg-transparent px-3 py-2 font-normal outline-none focus:border-slate-900 dark:border-white/20 dark:focus:border-white';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm font-medium">
      {label}
      {children}
    </label>
  );
}

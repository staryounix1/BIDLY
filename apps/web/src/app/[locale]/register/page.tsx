'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-provider';
import { useI18n } from '@/lib/i18n-provider';
import { ApiError } from '@/lib/auth-api';
import { registerSchema } from '@bidly/validation';
import { CategoryIcon, KhdemliMark } from '@/lib/icons';
import { Spinner } from '@/lib/ui';

/**
 * Sign-up.
 *
 * Validates with the shared @bidly/validation schema (the same rules the API
 * enforces server-side). On success the account exists pending verification and
 * a code has been sent; the API never returns a password or hash.
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
  /** True when the platform's email check is on and a code was sent. */
  const [needsVerify, setNeedsVerify] = useState(false);
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
      // Whether a code was emailed is the platform's decision (the admin
      // verification switches), so the confirmation screen follows the API
      // rather than assuming the email step always happens.
      const result = await signUp(parsed.data);
      setNeedsVerify(result.verificationRequired);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="app-shell container-page flex flex-col items-center justify-center gap-4 py-24 text-center">
        <span className="icon-tile h-16 w-16">
          <CategoryIcon name={needsVerify ? 'doc' : 'check'} size={28} />
        </span>
        <h1 className="text-xl font-black tracking-tight">
          {needsVerify ? t('auth.verifyNotice') : t('auth.accountReady')}
        </h1>
        <Link href={`/${locale}/login`} className="btn btn-primary">
          {t('common.signIn')}
        </Link>
      </div>
    );
  }

  return (
    <div className="app-shell container-page flex flex-col justify-center py-10">
      <header className="mb-6 flex flex-col items-center text-center">
        <KhdemliMark size={52} />
        <h1 className="mt-3 text-3xl font-black tracking-tight">{t('auth.signUpTitle')}</h1>
        <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('auth.signUpSubtitle')}</p>
      </header>

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label={t('auth.fullName')}>
          <input
            type="text"
            autoComplete="name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="input"
          />
        </Field>

        <Field label={t('auth.email')}>
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input"
          />
        </Field>

        <Field label={t('auth.phone')}>
          <input
            type="tel"
            autoComplete="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="input"
          />
        </Field>

        <Field label={t('auth.password')}>
          <input
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="input"
          />
        </Field>

        {/* Role chooses the whole product, so it gets real tiles, not a select. */}
        <fieldset>
          <legend className="label">{t('auth.accountType')}</legend>
          <div className="grid grid-cols-2 gap-2.5">
            {(['CUSTOMER', 'PROVIDER'] as const).map((option) => {
              const on = role === option;
              return (
                <label
                  key={option}
                  className={`card cursor-pointer p-3.5 text-center transition ${
                    on ? 'card-featured' : 'card-tap'
                  }`}
                >
                  <input
                    type="radio"
                    name="role"
                    value={option}
                    checked={on}
                    onChange={() => setRole(option)}
                    className="sr-only"
                  />
                  <span
                    className={`mx-auto mb-2 grid h-11 w-11 place-items-center rounded-xl ${
                      on ? 'bg-[rgb(var(--brand-500))] text-[rgb(var(--brand-ink))]' : 'bg-[rgb(var(--surface-3))] text-[rgb(var(--fg-muted))]'
                    }`}
                  >
                    <CategoryIcon name={option === 'CUSTOMER' ? 'user' : 'wrench'} size={22} />
                  </span>
                  <span className="block text-sm font-bold">
                    {option === 'CUSTOMER' ? t('auth.customer') : t('auth.provider')}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

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
          {t('common.signUp')}
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-[rgb(var(--fg-muted))]">
        {t('auth.haveAccount')}{' '}
        <Link href={`/${locale}/login`} className="font-bold text-[rgb(var(--brand-700))]">
          {t('common.signIn')}
        </Link>
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

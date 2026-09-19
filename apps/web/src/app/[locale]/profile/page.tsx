'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '@/lib/auth-provider';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';

/**
 * Profile page (protected).
 *
 * Reads from and writes to the real /users/me/profile endpoint. The API
 * response never contains a password hash or any auth secret; only the fields
 * below are rendered. A role guard keeps this page to signed-in users.
 */
export default function ProfilePage() {
  return (
    <RequireAuth>
      <ProfileView />
    </RequireAuth>
  );
}

function ProfileView() {
  const { t } = useI18n();
  const { user, profile, saveProfile } = useAuth();

  const [fullName, setFullName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState('');
  const [preferredLocale, setPreferredLocale] = useState('ar');
  const [preferredCurrency, setPreferredCurrency] = useState('MAD');

  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name ?? '');
    setDisplayName(profile.display_name ?? '');
    setBio(profile.bio ?? '');
    setAvatarUrl(profile.avatar_url ?? '');
    setPreferredLocale(profile.preferred_locale ?? 'ar');
    setPreferredCurrency(profile.preferred_currency ?? 'MAD');
  }, [profile]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setError(null);

    // Minimal client-side validation; the API validates again.
    if (avatarUrl && !/^https?:\/\/.+/i.test(avatarUrl)) {
      setError(t('profile.avatarUrl') + ': URL');
      return;
    }
    if (fullName && fullName.trim().length < 2) {
      setError(t('auth.fullName'));
      return;
    }
    if (fullName.length > 120) {
      setError(t('auth.fullName'));
      return;
    }

    setBusy(true);
    try {
      await saveProfile({
        ...(fullName ? { fullName } : {}),
        ...(displayName ? { displayName } : {}),
        bio,
        ...(avatarUrl ? { avatarUrl } : {}),
        preferredLocale,
        preferredCurrency,
      });
      setMessage(t('profile.saved'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-8 px-6 py-10">
      <header>
        <h1 className="text-3xl font-bold">{t('profile.title')}</h1>
        <p className="mt-1 text-sm opacity-70">{t('profile.subtitle')}</p>
      </header>

      <section className="grid grid-cols-2 gap-4 rounded-2xl border border-black/10 p-4 text-sm dark:border-white/15">
        <div>
          <div className="opacity-60">{t('profile.role')}</div>
          <div className="font-semibold">{user?.role}</div>
        </div>
        <div>
          <div className="opacity-60">{t('profile.status')}</div>
          <div className="font-semibold">{user?.status}</div>
        </div>
        <div>
          <div className="opacity-60">{t('auth.email')}</div>
          <div className="font-semibold">{user?.email ?? '—'}</div>
        </div>
        <div>
          <div className="opacity-60">{t('auth.phone')}</div>
          <div className="font-semibold">{user?.phone ?? '—'}</div>
        </div>
      </section>

      <form onSubmit={onSubmit} className="flex flex-col gap-4" noValidate>
        <Field label={t('auth.fullName')}>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputClass} />
        </Field>
        <Field label={t('profile.displayName')}>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={inputClass} />
        </Field>
        <Field label={t('profile.bio')}>
          <textarea value={bio} onChange={(e) => setBio(e.target.value)} rows={3} className={inputClass} />
        </Field>
        <Field label={t('profile.avatarUrl')}>
          <input value={avatarUrl} onChange={(e) => setAvatarUrl(e.target.value)} className={inputClass} />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label={t('profile.preferredLocale')}>
            <select value={preferredLocale} onChange={(e) => setPreferredLocale(e.target.value)} className={inputClass}>
              <option value="ar">AR</option>
              <option value="fr">FR</option>
              <option value="en">EN</option>
            </select>
          </Field>
          <Field label={t('profile.preferredCurrency')}>
            <input
              value={preferredCurrency}
              maxLength={3}
              onChange={(e) => setPreferredCurrency(e.target.value.toUpperCase())}
              className={inputClass}
            />
          </Field>
        </div>

        {message && <p className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{message}</p>}
        {error && <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="self-start rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
        >
          {busy ? t('common.loading') : t('common.save')}
        </button>
      </form>
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

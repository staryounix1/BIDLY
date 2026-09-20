'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useAuth } from '@/lib/auth-provider';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError, authApi } from '@/lib/auth-api';
import { CategoryIcon, type IconName } from '@/lib/icons';
import { SectionTitle, Spinner } from '@/lib/ui';

/**
 * Profile page (protected).
 *
 * Reads from and writes to the real /users/me/profile endpoint. The API
 * response never contains a password hash or any auth secret; only the fields
 * below are rendered. A role guard keeps this page to signed-in users.
 *
 * Layout: a sticky identity card (avatar, name, verification facts) beside the
 * editable form, so the user always sees *who they are signed in as* while
 * editing — the pattern used by large account settings screens.
 */

const LOCALES: Array<{ value: string; label: string; flag: string }> = [
  { value: 'ar', label: 'العربية', flag: '🇲🇦' },
  { value: 'fr', label: 'Français', flag: '🇫🇷' },
  { value: 'en', label: 'English', flag: '🇬🇧' },
];

const CURRENCIES = ['MAD', 'EUR', 'USD', 'GBP', 'AED', 'SAR'];

const ROLE_TINT: Record<string, string> = {
  CUSTOMER: 'from-indigo-500 to-violet-500',
  PROVIDER: 'from-emerald-500 to-teal-600',
  ADMIN: 'from-amber-500 to-orange-600',
};

export default function ProfilePage() {
  return (
    <RequireAuth>
      <ProfileView />
    </RequireAuth>
  );
}

/** Deterministic initials for the avatar fallback. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '؟';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

function ProfileView() {
  const { t, locale } = useI18n();
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
  const [avatarBroken, setAvatarBroken] = useState(false);

  useEffect(() => {
    if (!profile) return;
    setFullName(profile.full_name ?? '');
    setDisplayName(profile.display_name ?? '');
    setBio(profile.bio ?? '');
    setAvatarUrl(profile.avatar_url ?? '');
    setPreferredLocale(profile.preferred_locale ?? 'ar');
    setPreferredCurrency(profile.preferred_currency ?? 'MAD');
  }, [profile]);

  const name = displayName.trim() || fullName.trim() || user?.email || t('profile.title');
  const roleTint = ROLE_TINT[user?.role ?? 'CUSTOMER'] ?? ROLE_TINT.CUSTOMER;

  /** How complete the profile is — a small nudge, common in account screens. */
  const completeness = useMemo(() => {
    const checks = [fullName, displayName, bio, avatarUrl, preferredLocale, preferredCurrency];
    const done = checks.filter((v) => String(v).trim().length > 0).length;
    return Math.round((done / checks.length) * 100);
  }, [fullName, displayName, bio, avatarUrl, preferredLocale, preferredCurrency]);

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
    <div className="app-shell container-page py-5">
      {/* Identity card */}
      <div className="card fade-rise p-5">
        <div className="flex items-center gap-4">
          <span className="icon-tile h-16 w-16 overflow-hidden text-2xl font-black">
            {avatarUrl && !avatarBroken ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt={name}
                className="h-full w-full object-cover"
                onError={() => setAvatarBroken(true)}
              />
            ) : (
              initialsOf(name)
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-extrabold tracking-tight">{name}</h1>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="chip chip-brand">
                <CategoryIcon name="shield" size={12} />
                {t(`profile.roleName.${user?.role ?? 'CUSTOMER'}`)}
              </span>
              <StatusChip status={user?.status ?? ''} />
              {user?.emailVerified && (
                <span className="chip chip-ok">
                  <CategoryIcon name="check" size={12} />
                  {t('auth.email')}
                </span>
              )}
              {user?.phoneVerified && (
                <span className="chip chip-ok">
                  <CategoryIcon name="check" size={12} />
                  {t('auth.phone')}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Completeness meter */}
        <div className="mt-5">
          <div className="flex items-center justify-between text-xs font-semibold text-[rgb(var(--fg-muted))]">
            <span>{t('profile.completeness')}</span>
            <span className="tnum">{completeness}%</span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-[rgb(var(--surface-3))]">
            <div
              className="h-full rounded-full bg-[rgb(var(--brand-500))] transition-all duration-500"
              style={{ width: `${completeness}%` }}
            />
          </div>
        </div>
      </div>

      <div className="mt-5 grid gap-5 lg:grid-cols-[320px_1fr] lg:items-start">
        {/* Account facts */}
        <aside className="card overflow-hidden lg:sticky lg:top-24">
          <div className="border-b border-[rgb(var(--line))] px-5 py-4">
            <h2 className="text-sm font-bold">{t('profile.accountInfo')}</h2>
          </div>
          <dl className="divide-y divide-[rgb(var(--line))]">
            <Fact icon="layers" label={t('auth.email')} value={user?.email ?? '—'} mono />
            <Fact icon="pin" label={t('auth.phone')} value={user?.phone ?? '—'} mono />
            <Fact icon="shield" label={t('profile.role')} value={t(`profile.roleName.${user?.role ?? 'CUSTOMER'}`)} />
            <Fact icon="clock" label={t('profile.status')} value={user?.status ?? '—'} />
            <Fact
              icon="checklist"
              label={t('profile.memberSince')}
              value={profile?.id ? t('profile.activeAccount') : '—'}
            />
          </dl>
          <div className="border-t border-[rgb(var(--line))] p-4">
            <h3 className="mb-2 text-sm font-bold">{t('profile.security')}</h3>
            <ChangePassword onDone={() => setMessage(t('profile.passwordChanged'))} />
          </div>
        </aside>

        {/* Editable form */}
        <form onSubmit={onSubmit} className="card p-5 sm:p-6" noValidate>
          <div className="mb-5">
            <h2 className="text-lg font-extrabold tracking-tight">{t('profile.title')}</h2>
            <p className="text-sm text-[rgb(var(--fg-muted))]">{t('profile.subtitle')}</p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field label={t('auth.fullName')} hint={t('profile.fullNameHint')}>
              <input
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                maxLength={120}
                className="input"
                placeholder={t('profile.fullNamePlaceholder')}
              />
            </Field>
            <Field label={t('profile.displayName')} hint={t('profile.displayNameHint')}>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                maxLength={60}
                className="input"
                placeholder={name}
              />
            </Field>
          </div>

          <div className="mt-5">
            <Field label={t('profile.bio')} hint={`${bio.length}/280`}>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                rows={4}
                maxLength={280}
                className="input resize-none"
                placeholder={t('profile.bioPlaceholder')}
              />
            </Field>
          </div>

          <div className="mt-5">
            <Field label={t('profile.avatarUrl')} hint={t('profile.avatarHint')}>
              <div className="flex items-center gap-3">
                <AvatarPreview url={avatarUrl} name={name} />
                <input
                  value={avatarUrl}
                  onChange={(e) => {
                    setAvatarUrl(e.target.value);
                    setAvatarBroken(false);
                  }}
                  className="input"
                  placeholder="https://…"
                  dir="ltr"
                />
              </div>
            </Field>
          </div>

          <div className="mt-6">
            <span className="label">{t('profile.preferredLocale')}</span>
            <div className="flex flex-wrap gap-2">
              {LOCALES.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  onClick={() => setPreferredLocale(l.value)}
                  aria-pressed={preferredLocale === l.value}
                  className={`chip ${preferredLocale === l.value ? 'chip-brand' : 'chip-neutral'}`}
                >
                  <span aria-hidden>{l.flag}</span>
                  {l.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-6">
            <span className="label">{t('profile.preferredCurrency')}</span>
            <div className="flex flex-wrap gap-2">
              {CURRENCIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setPreferredCurrency(c)}
                  aria-pressed={preferredCurrency === c}
                  className={`chip tnum ${preferredCurrency === c ? 'chip-brand' : 'chip-neutral'}`}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          {message && (
            <p className="mt-6 flex items-center gap-2 rounded-xl border border-[rgb(var(--ok)/0.35)] px-3.5 py-2.5 text-sm font-semibold text-[rgb(var(--ok))]">
              <CategoryIcon name="check" size={16} />
              {message}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-6 flex items-center gap-2 rounded-xl border border-[rgb(var(--danger)/0.35)] px-3.5 py-2.5 text-sm font-semibold text-[rgb(var(--danger))]">
              <CategoryIcon name="shield" size={16} />
              {error}
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-[rgb(var(--line))] pt-5">
            <button type="submit" disabled={busy} className="btn btn-primary btn-lg">
              {busy ? <Spinner size={18} /> : <CategoryIcon name="check" size={16} />}
              {busy ? t('common.loading') : t('common.save')}
            </button>
            <Link href={`/${locale}/dashboard`} className="btn btn-secondary btn-lg">
              {t('nav.dashboard')}
            </Link>
            <span className="text-xs text-[rgb(var(--fg-subtle))]">{t('profile.privacyNote')}</span>
          </div>
        </form>
      </div>
    </div>
  );
}

function Fact({
  icon,
  label,
  value,
  mono,
}: {
  icon: IconName | string;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 px-5 py-3.5">
      <span className="icon-tile icon-tile-neutral mt-0.5 h-8 w-8">
        <CategoryIcon name={icon as IconName} size={15} />
      </span>
      <div className="min-w-0 flex-1">
        <dt className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[rgb(var(--fg-subtle))]">
          {label}
        </dt>
        <dd className={`truncate text-sm font-semibold ${mono ? 'text-start' : ''}`} dir={mono ? 'ltr' : undefined}>
          {value}
        </dd>
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const { t } = useI18n();
  const active = status === 'ACTIVE';
  return (
    <span className={`chip ${active ? 'chip-ok' : 'chip-warn'}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${active ? 'bg-[rgb(var(--ok))]' : 'bg-[rgb(var(--warn))]'}`} />
      {t(`status.${status}`) ?? status}
    </span>
  );
}

function AvatarPreview({ url, name }: { url: string; name: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  return (
    <span className="icon-tile h-12 w-12 overflow-hidden text-sm font-black">
      {url && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt={name} className="h-full w-full object-cover" onError={() => setBroken(true)} />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn btn-secondary btn-block">
        <CategoryIcon name="shield" size={15} />
        {t('profile.changePassword')}
      </button>
    );
  }

  async function submit() {
    setError(null);
    if (next.length < 8) {
      setError(t('profile.passwordTooShort'));
      return;
    }
    setBusy(true);
    try {
      await authApi.changePassword(current, next);
      setCurrent('');
      setNext('');
      setOpen(false);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2.5">
      <input
        type="password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
        placeholder={t('profile.currentPassword')}
        autoComplete="current-password"
        className="input"
      />
      <input
        type="password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
        placeholder={t('profile.newPassword')}
        autoComplete="new-password"
        className="input"
      />
      {error && <p className="text-xs font-semibold text-[rgb(var(--danger))]">{error}</p>}
      <div className="flex gap-2">
        <button type="button" onClick={submit} disabled={busy} className="btn btn-primary flex-1">
          {busy ? t('common.loading') : t('common.confirm')}
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost">
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold">{label}</span>
        {hint && <span className="text-xs font-normal text-[rgb(var(--fg-subtle))]">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

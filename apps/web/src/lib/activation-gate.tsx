'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useAuth } from './auth-provider';
import { useI18n } from './i18n-provider';
import { authApi, ApiError } from './auth-api';
import { CategoryIcon, KhdemliMark } from './icons';
import { Spinner } from './ui';

/**
 * Activation gate.
 *
 * A brand-new account is real and usable, but it has not been activated: the
 * email (and, when the platform asks for them, the WhatsApp and identity
 * checks) have not been satisfied. Rather than hide that in a settings page,
 * the product stops at the door with a blocking sheet that cannot be dismissed
 * — no backdrop click, no Escape, no close button — until the account is
 * activated. That is the one moment we have the user's full attention, so it is
 * the right place to ask.
 *
 * Deliberately not a hard redirect: the sheet is rendered over whatever page
 * the user asked for, so after activating they are already where they wanted to
 * be. The header and bottom nav stay hidden behind it (it covers them) which is
 * what makes it feel like a checkpoint rather than a toast.
 *
 * Sign-out stays reachable: a gate that traps someone who cannot activate would
 * be a dead end.
 */
export function ActivationGate() {
  const { user, ready, signOut, reload } = useAuth();
  const { t } = useI18n();
  const pathname = usePathname();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [awaitingCode, setAwaitingCode] = useState(false);

  const open = ready && user != null && !isActivated(user);

  // Lock the page behind the sheet so the content cannot scroll away under it.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Escape must not close it; block the key so no parent handler reacts either.
  useEffect(() => {
    if (!open) return;
    const block = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', block, true);
    return () => window.removeEventListener('keydown', block, true);
  }, [open]);

  // Nothing to show, and it must not flash before auth resolves.
  if (!open || !user) return null;

  const needsEmail = !user.emailVerified;
  const needsPhone = !user.phoneVerified;

  async function activate() {
    setBusy(true);
    setError(null);
    try {
      if (needsEmail && !awaitingCode) {
        // Ask the server for a fresh code, then move to the code step.
        await authApi.resendVerification();
        setAwaitingCode(true);
        return;
      }
      if (needsEmail && awaitingCode) {
        await authApi.verifyEmail(code.trim(), user!.email ?? undefined);
      } else if (needsPhone) {
        // Phone-only accounts confirm with the OTP they were sent at sign-up.
        await authApi.verifyPhone(user!.phone!, code.trim());
      }
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  // A phone-only account already received its code at sign-up, so it starts on
  // the code step; an email account needs a fresh code requested first.
  const step = needsEmail && !awaitingCode ? 'intro' : 'code';

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="activation-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgb(var(--fg)/0.55)] px-5 backdrop-blur-sm"
    >
      <div className="card w-full max-w-md overflow-hidden p-0 shadow-2xl">
        <div className="flex flex-col items-center gap-3 bg-[rgb(var(--brand-500)/0.08)] px-6 pt-7 pb-6 text-center">
          <KhdemliMark size={54} />
          <span className="chip chip-brand mt-1">{t('activation.badge')}</span>
          <h1 id="activation-title" className="text-xl font-black leading-snug tracking-tight">
            {step === 'intro' ? t('activation.title') : t('activation.codeTitle')}
          </h1>
          <p className="text-sm leading-relaxed text-[rgb(var(--fg-muted))]">
            {step === 'intro' ? t('activation.subtitle') : t('activation.codeSubtitle')}
          </p>
        </div>

        <div className="flex flex-col gap-4 px-6 py-6">
          <ul className="flex flex-col gap-2">
            <CheckRow done={user.emailVerified} label={t('activation.email')} />
            <CheckRow done={user.phoneVerified} label={t('activation.whatsapp')} />
          </ul>

          {step === 'code' && (
            <label className="block">
              <span className="label">{t('activation.code')}</span>
              <input
                className="input text-center text-lg tracking-[0.4em]"
                dir="ltr"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="······"
              />
            </label>
          )}

          {error && (
            <p
              role="alert"
              className="rounded-xl border border-[rgb(var(--danger)/0.35)] bg-[rgb(var(--danger)/0.08)] px-4 py-3 text-sm font-semibold text-[rgb(var(--danger))]"
            >
              {error}
            </p>
          )}

          <button
            type="button"
            disabled={busy || (step === 'code' && code.length < 6)}
            onClick={() => void activate()}
            className="btn btn-primary btn-block"
          >
            {busy ? (
              <Spinner size={18} />
            ) : (
              <CategoryIcon name="check" size={19} />
            )}
            {step === 'intro' ? t('activation.activate') : t('activation.confirm')}
          </button>

          <p className="text-center text-xs leading-relaxed text-[rgb(var(--fg-subtle))]">
            {t('activation.locked')}
          </p>

          <button
            type="button"
            onClick={() => void signOut()}
            className="mx-auto text-xs font-semibold text-[rgb(var(--fg-muted))] underline"
          >
            {t('common.signOut')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** One requirement line, struck through once satisfied. */
function CheckRow({ done, label }: { done: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      <span
        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-black ${
          done
            ? 'bg-[rgb(var(--brand-500))] text-[rgb(var(--brand-ink))]'
            : 'bg-[rgb(var(--line-strong))] text-[rgb(var(--fg-subtle))]'
        }`}
      >
        {done ? '✓' : ''}
      </span>
      <span className={done ? 'text-[rgb(var(--fg-subtle))] line-through' : 'font-semibold'}>
        {label}
      </span>
    </li>
  );
}

/**
 * Whether the account has cleared the checks the platform currently requires.
 *
 * Activation is judged from what the API reports on the user, not from local
 * state, so the gate lifts the instant `reload()` returns a satisfied user.
 */
function isActivated(user: { emailVerified: boolean; phoneVerified: boolean }): boolean {
  return user.emailVerified || user.phoneVerified;
}

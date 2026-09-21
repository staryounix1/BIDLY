'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth-provider';
import { useI18n } from './i18n-provider';
import { authApi, ApiError } from './auth-api';
import { CategoryIcon, KhdemliMark } from './icons';
import { Spinner } from './ui';

/**
 * Account activation gate.
 *
 * A new account exists but is not yet usable. This full-screen sheet cannot be
 * dismissed — no backdrop click, no Escape, no close button — and covers the
 * header and nav, so the platform is genuinely gated until the account is
 * activated. That makes it the one screen where the user's full attention is
 * guaranteed, which is why activation is asked for here rather than buried in
 * settings.
 *
 * The checks, in order:
 *   1. **Email** — satisfied by the code sent at sign-up, when the platform
 *      requires it (the `verification.email_enabled` switch). Skipped entirely
 *      when it is off.
 *   2. **WhatsApp** — the user enters a number, sees a short "verifying" state,
 *      and it is confirmed. Simulated: no message is sent (see the API).
 *   3. **Identity** — front and back of an ID are uploaded and reviewed by an
 *      admin. Until approved the account can browse but not transact.
 *
 * Sign-out stays reachable: a gate with no exit is a dead end.
 */
export function ActivationGate() {
  const { user, ready, signOut, reload } = useAuth();
  const { t } = useI18n();

  const open = ready && user != null && !isActivated(user);

  // While a sheet is open the page behind must not scroll.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  // Escape must not close it; swallow the key so nothing behind reacts.
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

  if (!open || !user) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="activation-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-[rgb(var(--fg)/0.62)] px-4 py-6 backdrop-blur-sm"
    >
      <ActivationCard onDone={() => void reload()} onSignOut={() => void signOut()} />
    </div>
  );
}

/** How long the simulated WhatsApp check "runs" before confirming. */
const WHATSAPP_VERIFY_MS = 6000;

type Step = 'intro' | 'whatsapp' | 'identity' | 'review';

function ActivationCard({ onDone, onSignOut }: { onDone: () => void; onSignOut: () => void }) {
  const { user } = useAuth();
  const { t, locale } = useI18n();
  const [step, setStep] = useState<Step>('intro');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 1 — WhatsApp.
  const [number, setNumber] = useState('');
  const [verifying, setVerifying] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Step 2 — Identity.
  const [recto, setRecto] = useState('');
  const [verso, setVerso] = useState('');
  const [selfie, setSelfie] = useState('');
  const [pendingApproval, setPendingApproval] = useState(false);

  const whatsappDone = user?.activation?.whatsapp ?? false;
  const identityDone = user?.activation?.identity ?? false;
  const identityPending = user?.activation?.identityPending ?? false;

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  // If the account already cleared a step (e.g. resumed later), show the next.
  useEffect(() => {
    if (!whatsappDone && step === 'intro') return;
    if (whatsappDone && !identityDone && !identityPending && step === 'intro') setStep('identity');
    if (identityPending && step === 'intro') setStep('review');
  }, [whatsappDone, identityDone, identityPending, step]);

  async function submitWhatsapp() {
    setError(null);
    setVerifying(true);
    try {
      await authApi.setWhatsapp(number.trim());
      // Hold the "verifying" state briefly so the confirmation reads as a real
      // check rather than an instant no-op. The write already happened.
      await new Promise((r) => {
        timer.current = setTimeout(r, WHATSAPP_VERIFY_MS);
      });
      setVerifying(false);
      setStep('identity');
      onDone();
    } catch (err) {
      setVerifying(false);
      setError(err instanceof ApiError ? err.message : t('common.error'));
    }
  }

  async function submitIdentity() {
    setBusy(true);
    setError(null);
    try {
      await authApi.submitIdentity({
        rectoUrl: recto.trim(),
        versoUrl: verso.trim(),
        selfieUrl: selfie.trim(),
      });
      setPendingApproval(true);
      setStep('review');
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  const title =
    step === 'whatsapp' || (step === 'intro' && !whatsappDone)
      ? t('activation.title')
      : step === 'identity'
        ? t('activation.identityTitle')
        : step === 'review'
          ? t('activation.reviewTitle')
          : t('activation.identityTitle');

  return (
    <div className="card flex max-h-[92vh] w-full max-w-md flex-col overflow-hidden p-0 shadow-2xl">
      <div className="flex flex-col items-center gap-2.5 bg-[rgb(var(--brand-500)/0.08)] px-6 pt-6 pb-5 text-center">
        <KhdemliMark size={48} />
        <span className="chip chip-brand">{t('activation.badge')}</span>
        <h1 id="activation-title" className="text-lg font-black leading-snug tracking-tight">
          {title}
        </h1>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5">
        <ol className="flex flex-col gap-2">
          <StepRow done={whatsappDone} active={step === 'whatsapp' || (step === 'intro' && !whatsappDone)} label={t('activation.stepWhatsapp')} />
          <StepRow done={identityDone} active={step === 'identity'} label={t('activation.stepIdentity')} />
        </ol>

        {error && (
          <p role="alert" className="rounded-xl border border-[rgb(var(--danger)/0.35)] bg-[rgb(var(--danger)/0.08)] px-4 py-3 text-sm font-semibold text-[rgb(var(--danger))]">
            {error}
          </p>
        )}

        {/* ---- intro: explain, then start with WhatsApp ---- */}
        {step === 'intro' && (
          <>
            <p className="text-sm leading-relaxed text-[rgb(var(--fg-muted))]">{t('activation.subtitle')}</p>
            <button type="button" onClick={() => setStep('whatsapp')} className="btn btn-primary btn-block">
              <CategoryIcon name="arrow" size={19} className="rtl:rotate-180" />
              {t('activation.start')}
            </button>
          </>
        )}

        {/* ---- WhatsApp ---- */}
        {step === 'whatsapp' && (
          <>
            <p className="text-sm leading-relaxed text-[rgb(var(--fg-muted))]">{t('activation.whatsappSubtitle')}</p>
            <label className="block">
              <span className="label">{t('activation.whatsappNumber')}</span>
              <input
                className="input"
                dir="ltr"
                type="tel"
                inputMode="tel"
                placeholder="+212 6XX XXX XXX"
                value={number}
                disabled={verifying}
                onChange={(e) => setNumber(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={verifying || number.trim().length < 8}
              onClick={() => void submitWhatsapp()}
              className="btn btn-primary btn-block"
            >
              {verifying ? <Spinner size={18} /> : <CategoryIcon name="check" size={19} />}
              {verifying ? t('activation.verifying') : t('activation.activateWhatsapp')}
            </button>
            {verifying && (
              <p className="text-center text-xs text-[rgb(var(--fg-subtle))]">{t('activation.verifyingHint')}</p>
            )}
          </>
        )}

        {/* ---- Identity upload ---- */}
        {step === 'identity' && (
          <>
            <p className="text-sm leading-relaxed text-[rgb(var(--fg-muted))]">{t('activation.identitySubtitle')}</p>

            <DocumentField
              label={t('activation.recto')}
              hint={t('activation.rectoHint')}
              value={recto}
              onChange={setRecto}
              errorText={t('activation.uploadFailed')}
            />
            <DocumentField
              label={t('activation.verso')}
              hint={t('activation.versoHint')}
              value={verso}
              onChange={setVerso}
              errorText={t('activation.uploadFailed')}
            />
            <DocumentField
              label={t('activation.selfie')}
              hint={t('activation.selfieHint')}
              value={selfie}
              onChange={setSelfie}
              errorText={t('activation.uploadFailed')}
            />

            <button
              type="button"
              disabled={busy || !recto.trim() || !verso.trim() || !selfie.trim()}
              onClick={() => void submitIdentity()}
              className="btn btn-primary btn-block"
            >
              {busy ? <Spinner size={18} /> : <CategoryIcon name="shield" size={19} />}
              {t('activation.submitIdentity')}
            </button>
            <p className="text-center text-xs leading-relaxed text-[rgb(var(--fg-subtle))]">
              {t('activation.identityNote')}
            </p>
          </>
        )}

        {/* ---- Awaiting admin review ---- */}
        {step === 'review' && (
          <>
            <div className="flex flex-col items-center gap-3 py-3 text-center">
              <span className="icon-tile h-14 w-14">
                <CategoryIcon name="clock" size={26} />
              </span>
              <p className="text-sm leading-relaxed text-[rgb(var(--fg-muted))]">{t('activation.reviewSubtitle')}</p>
            </div>
            <button type="button" onClick={onDone} className="btn btn-primary btn-block">
              {t('activation.continueBrowsing')}
            </button>
          </>
        )}

        <p className="text-center text-[11px] leading-relaxed text-[rgb(var(--fg-subtle))]">
          {t('activation.locked')}
        </p>
        <button type="button" onClick={onSignOut} className="mx-auto text-xs font-semibold text-[rgb(var(--fg-muted))] underline">
          {t('common.signOut')}
        </button>
      </div>
    </div>
  );
}

/** One numbered requirement row, ticked once satisfied. */
function StepRow({ done, active, label }: { done: boolean; active: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2.5 text-sm">
      <span
        className={`grid h-5 w-5 shrink-0 place-items-center rounded-full text-[11px] font-black ${
          done
            ? 'bg-[rgb(var(--brand-500))] text-[rgb(var(--brand-ink))]'
            : active
              ? 'border-2 border-[rgb(var(--brand-500))] text-[rgb(var(--brand-700))]'
              : 'bg-[rgb(var(--line-strong))] text-[rgb(var(--fg-subtle))]'
        }`}
      >
        {done ? '✓' : ''}
      </span>
      <span className={done ? 'text-[rgb(var(--fg-subtle))] line-through' : 'font-semibold'}>{label}</span>
    </li>
  );
}

/**
 * A labelled slot for one document photo.
 *
 * The user picks or photographs an image; it is downscaled and compressed in the
 * browser to a data URL before it is sent, so a phone photo becomes a small
 * payload the API accepts as text. There is no separate binary upload service
 * (`STORAGE_DRIVER=local`), and this is honest about it: the image travels with
 * the submission, and swapping in real object storage later only changes this
 * component.
 */
const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.72;

async function fileToCompressedDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();

  // A card photo is fine as JPEG; it keeps a 1280px image well under the limit.
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

function DocumentField({
  label, hint, value, onChange, errorText,
}: {
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  errorText: string;
}) {
  const [reading, setReading] = useState(false);
  const [failed, setFailed] = useState(false);
  const inputId = `doc-${label.replace(/\s+/g, '-')}`;

  async function pick(file: File | undefined) {
    if (!file) return;
    setFailed(false);
    setReading(true);
    try {
      onChange(await fileToCompressedDataUrl(file));
    } catch {
      setFailed(true);
    } finally {
      setReading(false);
    }
  }

  return (
    <div className="block">
      <span className="label">{label}</span>
      <span className="mb-1.5 block text-[11px] text-[rgb(var(--fg-subtle))]">{hint}</span>
      <label
        htmlFor={inputId}
        className="flex cursor-pointer items-center gap-3 rounded-[var(--radius)] border border-dashed border-[rgb(var(--line-strong))] px-3 py-2.5"
      >
        {value ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={value} alt="" className="h-12 w-16 shrink-0 rounded-md object-cover" />
        ) : (
          <CategoryIcon name="doc" size={18} />
        )}
        <span className="min-w-0 flex-1 text-xs text-[rgb(var(--fg-muted))]">
          {reading ? '…' : value ? '✓' : '📷'}
        </span>
        <span className="shrink-0 rounded-lg bg-[rgb(var(--brand-500)/0.14)] px-2.5 py-1 text-[11px] font-bold text-[rgb(var(--brand-700))]">
          {label}
        </span>
        <input
          id={inputId}
          type="file"
          accept="image/*"
          capture="environment"
          className="sr-only"
          onChange={(e) => void pick(e.target.files?.[0])}
        />
      </label>
      {failed && (
        <span className="mt-1 block text-[11px] font-semibold text-[rgb(var(--danger))]">{errorText}</span>
      )}
    </div>
  );
}

/**
 * Whether the account has cleared every check the platform requires.
 *
 * Judged from the API's `activation` object, so there is one rule in one place.
 * The server is the only authority: it sends `activation` on every auth
 * response. Email/phone verification is a different concern (it gates sign-in,
 * not usage) and must never stand in for it — treating `emailVerified` as
 * "activated" is what let freshly registered accounts slip past this gate.
 */
function isActivated(user: { activation?: { complete: boolean } }): boolean {
  // No `activation` means the server did not report it (older API): fail closed
  // and let the gate open, then `reload()` will replace it with the real state.
  return user.activation?.complete === true;
}

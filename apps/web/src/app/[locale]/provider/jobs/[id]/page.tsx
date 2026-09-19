'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { jobsApi, providerNextAction, type JobDetail } from '@/lib/jobs-api';
import { StatusBadge } from '@/lib/status-badge';

/**
 * Provider active-job screen (task 7 requirements 6 and 7).
 *
 * Drives the job through PROVIDER_EN_ROUTE → PROVIDER_ARRIVED → IN_PROGRESS →
 * COMPLETED. No status is invented here: each button maps to one endpoint, and
 * the server's state machine decides whether the move is legal. A rejected
 * transition is shown as an error rather than optimistically applied.
 */

export default function ProviderJobPage() {
  return (
    <RequireAuth roles={['PROVIDER', 'ADMIN']}>
      <ProviderJobView />
    </RequireAuth>
  );
}

function ProviderJobView() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [data, setData] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [otp, setOtp] = useState('');
  const [showOtp, setShowOtp] = useState(false);
  const [completionNote, setCompletionNote] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await jobsApi.get(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError(t('job.forbidden'));
      else if (err instanceof ApiError && err.status === 404) setError(t('job.notFound'));
      else setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setNotice(message);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <main className="mx-auto max-w-3xl px-4 py-10 opacity-60">{t('common.loading')}</main>;
  }

  if (error && !data) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
        <button onClick={() => router.push(`/${locale}/provider/jobs`)} className="mt-4 text-sm underline">
          ← {t('providerJob.title')}
        </button>
      </main>
    );
  }

  if (!data) return null;
  const { job, events, payment } = data;
  const next = providerNextAction(job.status);

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <button
        onClick={() => router.push(`/${locale}/provider/jobs`)}
        className="mb-4 text-sm opacity-60 hover:opacity-100"
      >
        ← {t('providerJob.title')}
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">
            {job.code} · {job.service_name ?? t('job.title')}
          </h1>
          <p className="mt-1 text-sm opacity-60">
            {t('providerJob.pickup')}: {[job.pickup_line1, job.pickup_city_name].filter(Boolean).join(', ') || '—'}
          </p>
        </div>
        <StatusBadge status={job.status} />
      </div>

      {notice && (
        <p className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <dl className="mt-6 grid grid-cols-2 gap-4 rounded-2xl border border-black/10 p-5 text-sm dark:border-white/15 sm:grid-cols-3">
        <Info label={t('job.price')}>
          {(job.final_price_minor / 100).toFixed(2)} {job.currency}
        </Info>
        <Info label={t('job.providerNet')}>
          {((job.provider_net_minor ?? 0) / 100).toFixed(2)} {job.currency}
        </Info>
        <Info label={t('job.paymentStatus')}>
          <StatusBadge status={job.payment_status} />
        </Info>
        <Info label={t('providerJob.destination')}>
          {[job.destination_line1, job.destination_city_name].filter(Boolean).join(', ') || '—'}
        </Info>
        <Info label={t('providerJob.scheduled')}>
          {job.scheduled_at ? new Date(job.scheduled_at).toLocaleString(locale) : '—'}
        </Info>
      </dl>

      {/* Actions — only what the current status allows. */}
      <section className="mt-6 rounded-2xl border border-black/10 p-5 dark:border-white/15">
        <h2 className="font-semibold">{t('providerJob.actions')}</h2>

        {next === 'enRoute' && (
          <button
            onClick={() => void run(() => jobsApi.enRoute(id), t('providerJob.enRouteDone'))}
            disabled={busy}
            className="mt-3 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
          >
            {busy ? t('common.loading') : t('providerJob.enRoute')}
          </button>
        )}

        {next === 'arrived' && (
          <button
            onClick={() => void run(() => jobsApi.arrived(id), t('providerJob.arrivedDone'))}
            disabled={busy}
            className="mt-3 rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
          >
            {busy ? t('common.loading') : t('providerJob.arrived')}
          </button>
        )}

        {next === 'start' && (
          <div className="mt-3 space-y-3">
            <p className="text-sm opacity-70">{t('providerJob.startHint')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type={showOtp ? 'text' : 'password'}
                inputMode="numeric"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                placeholder={t('providerJob.otpPlaceholder')}
                className="w-40 rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm tracking-widest outline-none focus:border-slate-900 dark:border-white/20 dark:focus:border-white"
              />
              <button
                type="button"
                onClick={() => setShowOtp((v) => !v)}
                className="text-xs underline opacity-70"
              >
                {showOtp ? t('providerJob.hide') : t('providerJob.show')}
              </button>
              <button
                onClick={() => void run(() => jobsApi.start(id, otp.trim()), t('providerJob.startedDone'))}
                disabled={busy || otp.trim().length < 4}
                className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
              >
                {busy ? t('common.loading') : t('providerJob.start')}
              </button>
            </div>
          </div>
        )}

        {next === 'complete' && (
          <div className="mt-3 space-y-3">
            <label className="block text-sm">
              <span className="opacity-70">{t('providerJob.completionNote')}</span>
              <textarea
                value={completionNote}
                onChange={(e) => setCompletionNote(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-slate-900 dark:border-white/20 dark:focus:border-white"
              />
            </label>
            <button
              onClick={() =>
                void run(
                  () => jobsApi.complete(id, completionNote.trim() ? { note: completionNote.trim() } : {}),
                  t('providerJob.completedDone'),
                )
              }
              disabled={busy}
              className="rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50"
            >
              {busy ? t('common.loading') : t('providerJob.complete')}
            </button>
          </div>
        )}

        {!next && (
          <p className="mt-3 text-sm opacity-60">
            {job.status === 'COMPLETED' || job.status === 'PAYMENT_PENDING' || job.status === 'PAID'
              ? t('providerJob.awaitingCustomer')
              : t('providerJob.noAction')}
          </p>
        )}
      </section>

      {/* Timeline */}
      <section className="mt-6 rounded-2xl border border-black/10 p-5 dark:border-white/15">
        <h2 className="font-semibold">{t('job.timeline')}</h2>
        {events.length === 0 ? (
          <p className="mt-2 text-sm opacity-60">{t('job.noEvents')}</p>
        ) : (
          <ol className="mt-3 space-y-2 text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 border-s-2 border-black/10 ps-3 dark:border-white/15">
                <span>
                  {e.to_status ? <StatusBadge status={e.to_status} /> : e.type}
                  {e.note && <span className="ms-2 opacity-70">{e.note}</span>}
                </span>
                <span className="text-xs opacity-60">{new Date(e.created_at).toLocaleString(locale)}</span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {payment && (
        <section className="mt-6 rounded-2xl border border-black/10 p-5 text-sm dark:border-white/15">
          <h2 className="font-semibold">{t('job.payment')}</h2>
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1">
            <span>
              {t('job.price')}: {(payment.amount_minor / 100).toFixed(2)} {payment.currency}
            </span>
            <span>
              {t('job.commission')}: {(payment.commission_minor / 100).toFixed(2)} {payment.currency}
            </span>
            <span className="font-semibold">
              {t('job.providerNet')}: {(payment.provider_net_minor / 100).toFixed(2)} {payment.currency}
            </span>
            <StatusBadge status={payment.status} />
          </div>
        </section>
      )}

      <div className="mt-6 flex flex-wrap gap-4 text-sm">
        <Link href={`/${locale}/provider/dashboard`} className="underline opacity-70">
          {t('providerDash.title')}
        </Link>
        <CountdownOrNothing expiresAt={job.start_otp_expires_at} label={t('providerJob.otpValidity')} />
      </div>
    </main>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs opacity-60">{label}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  );
}

function CountdownOrNothing({ expiresAt, label }: { expiresAt: string | null; label: string }) {
  const { t } = useI18n();
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return null;
  return (
    <span className="text-xs opacity-60">
      {label}: {Math.round(ms / 60000)} {t('request.minutes')}
    </span>
  );
}

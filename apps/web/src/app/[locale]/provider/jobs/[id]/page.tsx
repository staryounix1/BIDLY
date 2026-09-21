'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { jobsApi, providerNextAction, type JobDetail } from '@/lib/jobs-api';
import { reviewsApi, type RatingStatus } from '@/lib/reviews-api';
import { RatingPanel } from '@/lib/rating-panel';
import { JobPhotos } from '@/lib/job-photos';
import { StatusBadge } from '@/lib/status-badge';
import { CategoryIcon } from '@/lib/icons';
import { Price, SectionTitle, Spinner } from '@/lib/ui';

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
  const [afterPhotos, setAfterPhotos] = useState<string[]>([]);
  const [rating, setRating] = useState<RatingStatus | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await jobsApi.get(id);
      setData(d);
      if (['COMPLETED', 'PAID', 'DELIVERED'].includes(d.job.status)) {
        setRating(await reviewsApi.status(id).catch(() => null));
      } else {
        setRating(null);
      }
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
    return (
      <div className="app-shell container-page py-5">
        <div className="card flex items-center justify-center gap-2 px-5 py-10 text-sm text-[rgb(var(--fg-muted))]">
          <Spinner size={18} />
          {t('common.loading')}
        </div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="app-shell container-page py-5">
        <div className="card flex items-start gap-3 border-[rgb(var(--danger)/0.35)] p-4 text-sm text-[rgb(var(--danger))]">
          <CategoryIcon name="shield" size={18} />
          <span className="flex-1">{error}</span>
        </div>
        <button
          onClick={() => router.push(`/${locale}/provider/jobs`)}
          className="btn btn-secondary btn-block mt-4"
        >
          <CategoryIcon name="arrow" size={16} className="rtl:rotate-180" />
          {t('providerJob.title')}
        </button>
      </div>
    );
  }

  if (!data) return null;
  const { job, events, payment } = data;
  const next = providerNextAction(job.status);

  return (
    <div className="app-shell container-page py-5">
      <button
        onClick={() => router.push(`/${locale}/provider/jobs`)}
        className="btn btn-ghost mb-3 !px-2"
      >
        <CategoryIcon name="arrow" size={16} className="rtl:rotate-180" />
        {t('providerJob.title')}
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-extrabold tracking-tight">
            {job.code} · {job.service_name ?? t('job.title')}
          </h1>
          <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">
            {t('providerJob.pickup')}: {[job.pickup_line1, job.pickup_city_name].filter(Boolean).join(', ') || '—'}
          </p>
        </div>
        <StatusBadge status={job.status} />
      </div>

      {notice && (
        <div className="card mt-4 flex items-center gap-2 border-[rgb(var(--ok)/0.35)] p-3 text-sm text-[rgb(var(--ok))]">
          <CategoryIcon name="check" size={16} />
          <span className="flex-1">{notice}</span>
        </div>
      )}
      {error && (
        <div className="card mt-4 flex items-center gap-2 border-[rgb(var(--danger)/0.35)] p-3 text-sm text-[rgb(var(--danger))]">
          <CategoryIcon name="shield" size={16} />
          <span className="flex-1">{error}</span>
        </div>
      )}

      <div className="card mt-5 grid grid-cols-2 gap-4 p-5 text-sm sm:grid-cols-3">
        <Info label={t('job.price')}>
          <Price minor={job.final_price_minor} currency={job.currency} size="sm" />
        </Info>
        <Info label={t('job.providerNet')}>
          <Price minor={job.provider_net_minor ?? 0} currency={job.currency} size="sm" />
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
      </div>

      {/* Actions — only what the current status allows. */}
      <section className="card mt-5 p-5">
        <SectionTitle>{t('providerJob.actions')}</SectionTitle>

        {next === 'enRoute' && (
          <button
            onClick={() => void run(() => jobsApi.enRoute(id), t('providerJob.enRouteDone'))}
            disabled={busy}
            className="btn btn-primary btn-block"
          >
            {busy ? <Spinner size={18} /> : <CategoryIcon name="nav" size={18} />}
            {busy ? t('common.loading') : t('providerJob.enRoute')}
          </button>
        )}

        {next === 'arrived' && (
          <button
            onClick={() => void run(() => jobsApi.arrived(id), t('providerJob.arrivedDone'))}
            disabled={busy}
            className="btn btn-primary btn-block"
          >
            {busy ? <Spinner size={18} /> : <CategoryIcon name="pin" size={18} />}
            {busy ? t('common.loading') : t('providerJob.arrived')}
          </button>
        )}

        {next === 'start' && (
          <div className="space-y-3">
            <p className="text-sm text-[rgb(var(--fg-muted))]">{t('providerJob.startHint')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type={showOtp ? 'text' : 'password'}
                inputMode="numeric"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                placeholder={t('providerJob.otpPlaceholder')}
                className="input tnum w-40 tracking-widest"
              />
              <button
                type="button"
                onClick={() => setShowOtp((v) => !v)}
                className="text-xs font-semibold text-[rgb(var(--fg-muted))] underline"
              >
                {showOtp ? t('providerJob.hide') : t('providerJob.show')}
              </button>
            </div>
            <button
              onClick={() => void run(() => jobsApi.start(id, otp.trim()), t('providerJob.startedDone'))}
              disabled={busy || otp.trim().length < 4}
              className="btn btn-primary btn-block"
            >
              {busy ? <Spinner size={18} /> : <CategoryIcon name="bolt" size={18} />}
              {busy ? t('common.loading') : t('providerJob.start')}
            </button>
          </div>
        )}

        {/* Rating closes the job; photos are the evidence trail. */}
        {data.job.completion_photos && data.job.completion_photos.length > 0 && (
          <div className="card p-4">
            <h3 className="mb-2 text-sm font-bold" style={{ color: 'rgb(var(--fg-muted))' }}>
              {t('photos.title')}
            </h3>
            <JobPhotos photos={data.job.completion_photos} readOnly />
          </div>
        )}

        {rating && (
          <RatingPanel jobId={id} status={rating} onRated={load} opponentName={t('job.customer')} />
        )}

        {next === 'complete' && (
          <div className="space-y-3">
            <JobPhotos
              photos={afterPhotos}
              onChange={setAfterPhotos}
              label={t('photos.after')}
              hint={t('photos.afterHint')}
            />
            <label className="block">
              <span className="label">{t('providerJob.completionNote')}</span>
              <textarea
                value={completionNote}
                onChange={(e) => setCompletionNote(e.target.value)}
                rows={3}
                className="input resize-none"
              />
            </label>
            <button
              onClick={() =>
                void run(
                  () => jobsApi.complete(id, {
                    ...(completionNote.trim() ? { note: completionNote.trim() } : {}),
                    ...(afterPhotos.length ? { photoUrls: afterPhotos } : {}),
                  }),
                  t('providerJob.completedDone'),
                )
              }
              disabled={busy}
              className="btn btn-primary btn-block"
            >
              {busy ? <Spinner size={18} /> : <CategoryIcon name="check" size={18} />}
              {busy ? t('common.loading') : t('providerJob.complete')}
            </button>
          </div>
        )}

        {!next && (
          <p className="text-sm text-[rgb(var(--fg-muted))]">
            {job.status === 'COMPLETED' || job.status === 'PAYMENT_PENDING' || job.status === 'PAID'
              ? t('providerJob.awaitingCustomer')
              : t('providerJob.noAction')}
          </p>
        )}
      </section>

      {/* Timeline */}
      <section className="card mt-5 p-5">
        <SectionTitle>{t('job.timeline')}</SectionTitle>
        {events.length === 0 ? (
          <p className="text-sm text-[rgb(var(--fg-muted))]">{t('job.noEvents')}</p>
        ) : (
          <ol className="space-y-2.5 text-sm">
            {events.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-center justify-between gap-2 border-s-2 border-[rgb(var(--line-strong))] ps-3"
              >
                <span className="flex flex-wrap items-center gap-2">
                  {e.to_status ? <StatusBadge status={e.to_status} /> : e.type}
                  {e.note && <span className="text-[rgb(var(--fg-muted))]">{e.note}</span>}
                </span>
                <span className="tnum text-xs text-[rgb(var(--fg-subtle))]">
                  {new Date(e.created_at).toLocaleString(locale)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {payment && (
        <section className="card mt-5 p-5 text-sm">
          <SectionTitle>{t('job.payment')}</SectionTitle>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span>
              {t('job.price')}: <Price minor={payment.amount_minor} currency={payment.currency} size="sm" />
            </span>
            <span>
              {t('job.commission')}: <Price minor={payment.commission_minor} currency={payment.currency} size="sm" />
            </span>
            <span className="font-semibold">
              {t('job.providerNet')}: <Price minor={payment.provider_net_minor} currency={payment.currency} size="sm" />
            </span>
            <StatusBadge status={payment.status} />
          </div>
        </section>
      )}

      <div className="mt-5 flex flex-wrap items-center gap-4 text-sm">
        <Link href={`/${locale}/provider/dashboard`} className="font-semibold text-[rgb(var(--brand-700))]">
          {t('providerDash.title')}
        </Link>
        <CountdownOrNothing expiresAt={job.start_otp_expires_at} label={t('providerJob.otpValidity')} />
      </div>
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-[rgb(var(--fg-subtle))]">{label}</dt>
      <dd className="mt-0.5 font-semibold">{children}</dd>
    </div>
  );
}

function CountdownOrNothing({ expiresAt, label }: { expiresAt: string | null; label: string }) {
  const { t } = useI18n();
  if (!expiresAt) return null;
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return null;
  return (
    <span className="tnum text-xs text-[rgb(var(--fg-subtle))]">
      {label}: {Math.round(ms / 60000)} {t('request.minutes')}
    </span>
  );
}

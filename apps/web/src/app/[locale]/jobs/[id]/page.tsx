'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { jobsApi, TRACKABLE_JOB_STATUSES, type JobDetail } from '@/lib/jobs-api';
import { paymentsApi } from '@/lib/payments-api';
import { TrackProvider } from '@/lib/map/track-provider';
import { StatusBadge } from '@/lib/status-badge';
import { CategoryIcon } from '@/lib/icons';
import { Price, Spinner } from '@/lib/ui';

/**
 * Customer job detail.
 *
 * Notifications link straight here (`/jobs/:id`), so this page must exist —
 * the jobs list only expands rows inline and has no id route of its own.
 */
export default function CustomerJobPage() {
  return (
    <RequireAuth roles={['CUSTOMER']}>
      <JobDetailView />
    </RequireAuth>
  );
}

function JobDetailView() {
  const { t, locale } = useI18n();
  const params = useParams<{ id: string }>();
  const id = params?.id as string;

  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await jobsApi.get(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onConfirm() {
    setBusy(true);
    setNotice(null);
    try {
      await jobsApi.confirm(id);
      setNotice(t('job.confirmed'));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function onPay() {
    setBusy(true);
    setNotice(null);
    try {
      const result = await paymentsApi.payJob(id, 'CARD');
      setNotice(result.status === 'FAILED' ? t('payment.paymentFailed') : t('payment.paid'));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="app-shell container-page flex items-center justify-center py-24">
        <Spinner size={28} />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="app-shell container-page py-8">
        <p className="card border-[rgb(var(--danger)/0.35)] p-4 text-sm font-semibold text-[rgb(var(--danger))]">
          {error ?? t('job.notFound')}
        </p>
        <Link href={`/${locale}/jobs`} className="btn btn-secondary mt-4">
          <CategoryIcon name="chevron" size={16} className="rotate-180 rtl:rotate-0" />
          {t('job.myTitle')}
        </Link>
      </div>
    );
  }

  const job = detail.job;

  return (
    <div className="app-shell container-page py-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-extrabold">{job.code}</h1>
          <p className="mt-0.5 text-xs text-[rgb(var(--fg-subtle))]">
            {job.service_name ?? ''}
          </p>
        </div>
        <StatusBadge status={job.status} />
      </div>

      {notice && (
        <p className="mb-4 rounded-xl border border-[rgb(var(--ok)/0.35)] bg-[rgb(var(--ok)/0.08)] px-4 py-3 text-sm font-semibold text-[rgb(5_150_105)]">
          {notice}
        </p>
      )}

      <div className="space-y-5">
        {(TRACKABLE_JOB_STATUSES as readonly string[]).includes(job.status) && job.provider_id && (
          <TrackProvider
            providerId={job.provider_id}
            providerName={job.provider_name}
            destination={
              job.pickup_lat != null && job.pickup_lng != null
                ? { lat: Number(job.pickup_lat), lng: Number(job.pickup_lng) }
                : null
            }
            refreshKey={job.status}
          />
        )}

        <div className="card grid grid-cols-2 gap-3 p-4 text-sm">
          <Info label={t('job.provider')}>{job.provider_name ?? '—'}</Info>
          <Info label={t('job.price')}>
            <Price minor={job.final_price_minor} currency={job.currency} size="sm" />
          </Info>
          <Info label={t('job.commission')}>
            <Price minor={job.commission_minor} currency={job.currency} size="sm" />
          </Info>
          <Info label={t('job.providerNet')}>
            <Price minor={job.provider_net_minor} currency={job.currency} size="sm" />
          </Info>
          {detail.payment && (
            <Info label={t('job.paymentStatus')}>
              <StatusBadge status={detail.payment.status} />
            </Info>
          )}
          {job.scheduled_at && (
            <Info label={t('request.scheduledAt')}>
              {new Date(job.scheduled_at).toLocaleString(locale)}
            </Info>
          )}
        </div>

        <div className="card p-4">
          <h2 className="mb-2 text-sm font-bold text-[rgb(var(--fg-muted))]">{t('job.timeline')}</h2>
          {detail.events.length === 0 ? (
            <p className="text-sm text-[rgb(var(--fg-muted))]">{t('job.noEvents')}</p>
          ) : (
            <ol className="space-y-2 border-s-2 border-[rgb(var(--line-strong))] ps-3">
              {detail.events.map((e) => (
                <li key={e.id} className="text-sm">
                  <div className="font-semibold">{e.to_status ?? e.type}</div>
                  <div className="tnum text-xs text-[rgb(var(--fg-subtle))]">
                    {new Date(e.created_at).toLocaleString(locale)}
                    {e.actor_role ? ` · ${e.actor_role}` : ''}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>

        {job.status === 'COMPLETED' && detail.payment?.status !== 'CAPTURED' && (
          <div className="flex flex-wrap gap-3">
            <button onClick={onConfirm} disabled={busy} className="btn btn-primary btn-lg flex-1">
              {busy ? <Spinner size={18} /> : <CategoryIcon name="check" size={18} />}
              {t('job.confirmCompletion')}
            </button>
            <button onClick={onPay} disabled={busy} className="btn btn-secondary btn-lg flex-1">
              {busy ? <Spinner size={18} /> : <CategoryIcon name="wallet" size={18} />}
              {busy ? t('payment.paying') : t('payment.payNow')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs font-semibold text-[rgb(var(--fg-subtle))]">{label}</div>
      <div className="mt-0.5 font-semibold">{children}</div>
    </div>
  );
}

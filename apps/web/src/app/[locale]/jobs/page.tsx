'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { jobsApi, TRACKABLE_JOB_STATUSES, type JobDetail, type JobSummary } from '@/lib/jobs-api';
import { paymentsApi } from '@/lib/payments-api';
import { TrackProvider } from '@/lib/map/track-provider';
import { StatusBadge } from '@/lib/status-badge';
import { CategoryIcon } from '@/lib/icons';
import { EmptyState, Price, Spinner } from '@/lib/ui';

/**
 * Customer jobs list.
 *
 * A job exists once the customer accepts an offer. This screen lists confirmed
 * engagements and, on expand, shows the assigned provider, the event timeline
 * and the payment summary — all from `/jobs/mine` and `/jobs/:id`.
 */
export default function JobsPage() {
  return (
    <RequireAuth roles={['CUSTOMER']}>
      <JobsView />
    </RequireAuth>
  );
}

function JobsView() {
  const { t, locale } = useI18n();
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await jobsApi.mine({ role: 'customer', limit: 50 });
      setJobs(data.items ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onExpand(id: string) {
    if (openId === id) {
      setOpenId(null);
      setDetail(null);
      return;
    }
    setOpenId(id);
    setDetailLoading(true);
    setDetail(null);
    try {
      setDetail(await jobsApi.get(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setDetailLoading(false);
    }
  }

  async function onConfirm(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await jobsApi.confirm(id);
      setNotice(t('job.confirmed'));
      await load();
      setDetail(await jobsApi.get(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function onPay(id: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await paymentsApi.payJob(id, 'CARD');
      setNotice(result.status === 'FAILED' ? t('payment.paymentFailed') : t('payment.paid'));
      await load();
      setDetail(await jobsApi.get(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell container-page py-5">
      <header>
        <h1 className="text-2xl font-extrabold tracking-tight">{t('job.title')}</h1>
        <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('job.subtitle')}</p>
      </header>

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
          <button onClick={load} className="font-semibold underline">
            {t('common.retry')}
          </button>
        </div>
      )}

      {loading ? (
        <div className="card mt-5 flex items-center justify-center gap-2 px-5 py-10 text-sm text-[rgb(var(--fg-muted))]">
          <Spinner size={18} />
          {t('common.loading')}
        </div>
      ) : jobs.length === 0 ? (
        <div className="mt-5">
          <EmptyState
            title={t('job.empty')}
            icon={<CategoryIcon name="truck" size={26} />}
            action={
              <Link href={`/${locale}/requests`} className="btn btn-primary">
                {t('request.myTitle')}
              </Link>
            }
          />
        </div>
      ) : (
        <ul className="mt-5 space-y-3">
          {jobs.map((j, i) => (
            <li
              key={j.id}
              className="card card-tap slide-in overflow-hidden"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <button
                onClick={() => onExpand(j.id)}
                className="flex w-full items-center justify-between gap-4 p-4 text-start"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-bold">{j.service_name || j.code}</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[rgb(var(--fg-subtle))]">
                    <span className="tnum">{j.code}</span>
                    <span>
                      {t('job.provider')}: {j.provider_name}
                    </span>
                    <span className="tnum">
                      {t('job.price')}: <Price minor={j.final_price_minor} currency={j.currency} size="sm" />
                    </span>
                    <span>{new Date(j.created_at).toLocaleDateString(locale)}</span>
                  </div>
                </div>
                <span className="flex flex-none items-center gap-2">
                  <StatusBadge status={j.status} />
                  <CategoryIcon
                    name="chevron"
                    size={16}
                    className={`text-[rgb(var(--fg-subtle))] transition-transform rtl:rotate-180 ${openId === j.id ? 'rotate-90' : ''}`}
                  />
                </span>
              </button>

              {openId === j.id && (
                <div className="border-t border-[rgb(var(--line))] p-4">
                  {detailLoading ? (
                    <div className="flex items-center justify-center gap-2 py-4 text-sm text-[rgb(var(--fg-muted))]">
                      <Spinner size={16} />
                      {t('common.loading')}
                    </div>
                  ) : detail ? (
                    <div className="space-y-5">
                      {(TRACKABLE_JOB_STATUSES as readonly string[]).includes(detail.job.status) &&
                        detail.job.provider_id && (
                          <TrackProvider
                            providerId={detail.job.provider_id}
                            providerName={detail.job.provider_name}
                            destination={
                              detail.job.pickup_lat != null && detail.job.pickup_lng != null
                                ? { lat: Number(detail.job.pickup_lat), lng: Number(detail.job.pickup_lng) }
                                : null
                            }
                            refreshKey={detail.job.status}
                          />
                        )}
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <Info label={t('job.provider')}>{detail.job.provider_name ?? '—'}</Info>
                        <Info label={t('job.price')}>
                          <Price minor={detail.job.final_price_minor} currency={detail.job.currency} size="sm" />
                        </Info>
                        <Info label={t('job.commission')}>
                          <Price minor={detail.job.commission_minor} currency={detail.job.currency} size="sm" />
                        </Info>
                        <Info label={t('job.providerNet')}>
                          <Price minor={detail.job.provider_net_minor} currency={detail.job.currency} size="sm" />
                        </Info>
                        {detail.payment && (
                          <Info label={t('job.paymentStatus')}>
                            <StatusBadge status={detail.payment.status} />
                          </Info>
                        )}
                        {detail.job.scheduled_at && (
                          <Info label={t('request.scheduledAt')}>
                            {new Date(detail.job.scheduled_at).toLocaleString(locale)}
                          </Info>
                        )}
                      </div>

                      <div>
                        <h3 className="mb-2 text-sm font-bold text-[rgb(var(--fg-muted))]">{t('job.timeline')}</h3>
                        {detail.events.length === 0 ? (
                          <p className="text-sm text-[rgb(var(--fg-muted))]">{t('job.noEvents')}</p>
                        ) : (
                          <ol className="space-y-2 border-s-2 border-[rgb(var(--line-strong))] ps-3">
                            {detail.events.map((e) => (
                              <li key={e.id} className="text-sm">
                                <div className="font-semibold">
                                  {e.to_status ?? e.type}
                                </div>
                                <div className="tnum text-xs text-[rgb(var(--fg-subtle))]">
                                  {new Date(e.created_at).toLocaleString(locale)}
                                  {e.actor_role ? ` · ${e.actor_role}` : ''}
                                </div>
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>

                      {detail.job.status === 'COMPLETED' && detail.payment?.status !== 'CAPTURED' && (
                        <div className="flex flex-wrap gap-3">
                          <button
                            onClick={() => onConfirm(j.id)}
                            disabled={busy}
                            className="btn btn-primary btn-lg flex-1"
                          >
                            {busy ? <Spinner size={18} /> : <CategoryIcon name="check" size={18} />}
                            {t('job.confirmCompletion')}
                          </button>
                          <button
                            onClick={() => onPay(j.id)}
                            disabled={busy}
                            className="btn btn-secondary btn-lg flex-1"
                          >
                            {busy ? <Spinner size={18} /> : <CategoryIcon name="wallet" size={18} />}
                            {busy ? t('payment.paying') : t('payment.payNow')}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
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

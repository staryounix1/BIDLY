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
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header>
        <h1 className="text-2xl font-bold">{t('job.title')}</h1>
        <p className="mt-1 text-sm opacity-70">{t('job.subtitle')}</p>
      </header>

      {notice && (
        <p className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}{' '}
          <button onClick={load} className="underline">
            {t('common.retry')}
          </button>
        </p>
      )}

      {loading ? (
        <p className="mt-6 opacity-60">{t('common.loading')}</p>
      ) : jobs.length === 0 ? (
        <div className="mt-10 rounded-2xl border border-dashed border-black/15 p-10 text-center dark:border-white/15">
          <p className="opacity-70">{t('job.empty')}</p>
          <Link href={`/${locale}/requests`} className="mt-3 inline-block text-sm font-medium underline">
            {t('request.myTitle')}
          </Link>
        </div>
      ) : (
        <ul className="mt-6 space-y-3">
          {jobs.map((j) => (
            <li key={j.id} className="rounded-2xl border border-black/10 dark:border-white/15">
              <button
                onClick={() => onExpand(j.id)}
                className="flex w-full items-center justify-between gap-4 p-4 text-start"
              >
                <div className="min-w-0">
                  <div className="truncate font-semibold">{j.service_name || j.code}</div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs opacity-60">
                    <span className="mono">{j.code}</span>
                    <span>
                      {t('job.provider')}: {j.provider_name}
                    </span>
                    <span>
                      {t('job.price')}: {(j.final_price_minor / 100).toFixed(2)} {j.currency}
                    </span>
                    <span>{new Date(j.created_at).toLocaleDateString(locale)}</span>
                  </div>
                </div>
                <StatusBadge status={j.status} />
              </button>

              {openId === j.id && (
                <div className="border-t border-black/10 p-4 dark:border-white/10">
                  {detailLoading ? (
                    <p className="text-sm opacity-60">{t('common.loading')}</p>
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
                          {(detail.job.final_price_minor / 100).toFixed(2)} {detail.job.currency}
                        </Info>
                        <Info label={t('job.commission')}>
                          {(detail.job.commission_minor / 100).toFixed(2)} {detail.job.currency}
                        </Info>
                        <Info label={t('job.providerNet')}>
                          {(detail.job.provider_net_minor / 100).toFixed(2)} {detail.job.currency}
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
                        <h3 className="text-sm font-semibold opacity-70">{t('job.timeline')}</h3>
                        {detail.events.length === 0 ? (
                          <p className="mt-1 text-sm opacity-60">{t('job.noEvents')}</p>
                        ) : (
                          <ol className="mt-2 space-y-2 border-s border-black/10 ps-3 dark:border-white/15">
                            {detail.events.map((e) => (
                              <li key={e.id} className="text-sm">
                                <div className="font-medium">
                                  {e.to_status ?? e.type}
                                </div>
                                <div className="text-xs opacity-60">
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
                            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                          >
                            {t('job.confirmCompletion')}
                          </button>
                          <button
                            onClick={() => onPay(j.id)}
                            disabled={busy}
                            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
                          >
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
    </main>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs opacity-60">{label}</div>
      <div className="mt-0.5 font-medium">{children}</div>
    </div>
  );
}

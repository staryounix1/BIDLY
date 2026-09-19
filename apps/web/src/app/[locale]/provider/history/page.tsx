'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { jobsApi, type JobSummary } from '@/lib/jobs-api';
import { StatusBadge } from '@/lib/status-badge';

/**
 * Provider history (task 7 requirement 8).
 *
 * Past work only — completed, cancelled and paid jobs. The API scopes the
 * result to jobs belonging to the signed-in provider, so this can never show
 * another provider's work. Totals are computed from the same rows, so the
 * numbers always agree with the list.
 */

const ACTIVE_STATUSES = ['CREATED', 'CONFIRMED', 'PROVIDER_EN_ROUTE', 'PROVIDER_ARRIVED', 'IN_PROGRESS', 'STARTED'];

const HISTORY_TABS = ['', 'COMPLETED', 'PAYMENT_PENDING', 'PAID', 'CANCELLED'] as const;

export default function ProviderHistoryPage() {
  return (
    <RequireAuth roles={['PROVIDER', 'ADMIN']}>
      <ProviderHistoryView />
    </RequireAuth>
  );
}

function ProviderHistoryView() {
  const { t, locale } = useI18n();
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await jobsApi.mine({ limit: 100, role: 'provider', status: filter || undefined });
      setJobs((data.items ?? []).filter((j) => !ACTIVE_STATUSES.includes(j.status)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [filter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const earned = jobs
    .filter((j) => ['COMPLETED', 'PAYMENT_PENDING', 'PAID'].includes(j.status))
    .reduce((sum, j) => sum + (j.provider_net_minor ?? 0), 0);

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('providerHistory.title')}</h1>
          <p className="mt-1 text-sm opacity-70">{t('providerHistory.subtitle')}</p>
        </div>
        <div className="rounded-2xl border border-black/10 px-4 py-3 text-end dark:border-white/15">
          <div className="text-xs opacity-60">{t('providerHistory.totalEarned')}</div>
          <div className="text-lg font-bold">
            {(earned / 100).toFixed(2)} {jobs[0]?.currency ?? 'MAD'}
          </div>
        </div>
      </header>

      <div className="mb-5 flex flex-wrap gap-2 text-sm">
        {HISTORY_TABS.map((tab) => (
          <button
            key={tab || 'all'}
            onClick={() => setFilter(tab)}
            className={
              filter === tab
                ? 'rounded-full bg-slate-900 px-3 py-1 font-semibold text-white dark:bg-white dark:text-slate-900'
                : 'rounded-full border border-black/15 px-3 py-1 opacity-70 hover:opacity-100 dark:border-white/20'
            }
          >
            {tab ? <StatusBadge status={tab} /> : t('providerHistory.all')}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          <span>{error}</span>
          <button onClick={() => void load()} className="underline">
            {t('common.retry')}
          </button>
        </div>
      )}

      {loading ? (
        <p className="opacity-60">{t('common.loading')}</p>
      ) : jobs.length === 0 ? (
        <p className="rounded-2xl border border-black/10 px-5 py-10 text-center text-sm opacity-60 dark:border-white/15">
          {t('providerHistory.empty')}
        </p>
      ) : (
        <ul className="space-y-3 sm:grid sm:grid-cols-1 sm:gap-3 sm:space-y-0 lg:grid-cols-2">
          {jobs.map((j) => (
            <li
              key={j.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-black/10 p-4 dark:border-white/15"
            >
              <div className="min-w-0">
                <Link href={`/${locale}/provider/jobs/${j.id}`} className="font-semibold hover:underline">
                  {j.code} · {j.service_name ?? t('job.title')}
                </Link>
                <p className="mt-0.5 text-xs opacity-60">
                  {j.pickup_city_name ?? '—'}
                  {j.completed_at && ` · ${new Date(j.completed_at).toLocaleDateString(locale)}`}
                </p>
              </div>
              <div className="text-end">
                <div className="font-bold">
                  {((j.provider_net_minor ?? 0) / 100).toFixed(2)} {j.currency}
                </div>
                <div className="mt-1">
                  <StatusBadge status={j.status} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

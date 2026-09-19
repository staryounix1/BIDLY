'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { jobsApi, providerNextAction, type JobSummary } from '@/lib/jobs-api';
import { StatusBadge } from '@/lib/status-badge';

/**
 * Provider jobs (task 7 requirements 6 and 8).
 *
 * Split into active work and history. "Active" is every status where the
 * provider still has an action to take; everything else is past work. History
 * is scoped by the API to jobs whose provider is the signed-in user, so a
 * provider can never see another provider's jobs.
 */

const ACTIVE_STATUSES = ['CREATED', 'CONFIRMED', 'PROVIDER_EN_ROUTE', 'PROVIDER_ARRIVED', 'IN_PROGRESS', 'STARTED'];

export default function ProviderJobsPage() {
  return (
    <RequireAuth roles={['PROVIDER', 'ADMIN']}>
      <ProviderJobsView />
    </RequireAuth>
  );
}

function ProviderJobsView() {
  const { t, locale } = useI18n();
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'active' | 'history'>('active');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await jobsApi.mine({ limit: 100, role: 'provider' });
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

  const active = jobs.filter((j) => ACTIVE_STATUSES.includes(j.status));
  const history = jobs.filter((j) => !ACTIVE_STATUSES.includes(j.status));
  const shown = tab === 'active' ? active : history;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('providerJob.title')}</h1>
          <p className="mt-1 text-sm opacity-70">{t('providerJob.subtitle')}</p>
        </div>
        <Link
          href={`/${locale}/provider/dashboard`}
          className="rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium dark:border-white/20"
        >
          {t('providerDash.title')}
        </Link>
      </header>

      <div className="mb-5 flex flex-wrap gap-2 text-sm">
        {(['active', 'history'] as const).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={
              tab === key
                ? 'rounded-full bg-slate-900 px-3 py-1 font-semibold text-white dark:bg-white dark:text-slate-900'
                : 'rounded-full border border-black/15 px-3 py-1 opacity-70 hover:opacity-100 dark:border-white/20'
            }
          >
            {t(`providerJob.tab.${key}`)} ({key === 'active' ? active.length : history.length})
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
      ) : shown.length === 0 ? (
        <p className="rounded-2xl border border-black/10 px-5 py-10 text-center text-sm opacity-60 dark:border-white/15">
          {tab === 'active' ? t('providerJob.noActive') : t('providerJob.noHistory')}
        </p>
      ) : (
        <ul className="space-y-3 sm:grid sm:grid-cols-1 sm:gap-3 sm:space-y-0 lg:grid-cols-2">
          {shown.map((j) => {
            const next = providerNextAction(j.status);
            return (
              <li key={j.id} className="rounded-2xl border border-black/10 p-4 dark:border-white/15">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <Link
                      href={`/${locale}/provider/jobs/${j.id}`}
                      className="text-lg font-semibold hover:underline"
                    >
                      {j.code} · {j.service_name ?? t('job.title')}
                    </Link>
                    <p className="mt-0.5 text-xs opacity-60">
                      {j.pickup_city_name ?? '—'}
                      {j.scheduled_at && ` · ${new Date(j.scheduled_at).toLocaleDateString(locale)}`}
                    </p>
                  </div>
                  <StatusBadge status={j.status} />
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
                  <span className="opacity-70">
                    {t('job.providerNet')}:{' '}
                    <span className="font-semibold opacity-100">
                      {((j.provider_net_minor ?? 0) / 100).toFixed(2)} {j.currency}
                    </span>
                  </span>
                  {next ? (
                    <Link
                      href={`/${locale}/provider/jobs/${j.id}`}
                      className="rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white dark:bg-white dark:text-slate-900"
                    >
                      {t(`providerJob.next.${next}`)}
                    </Link>
                  ) : (
                    <Link href={`/${locale}/provider/jobs/${j.id}`} className="text-xs underline opacity-70">
                      {t('job.details')}
                    </Link>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}

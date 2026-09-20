'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { jobsApi, type JobSummary } from '@/lib/jobs-api';
import { StatusBadge } from '@/lib/status-badge';
import { CategoryIcon } from '@/lib/icons';
import { EmptyState, Price, SectionTitle, Spinner } from '@/lib/ui';

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
    <div className="app-shell container-page py-5">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{t('providerHistory.title')}</h1>
          <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('providerHistory.subtitle')}</p>
        </div>
        <div className="card px-4 py-3 text-end">
          <div className="text-xs font-semibold text-[rgb(var(--fg-subtle))]">{t('providerHistory.totalEarned')}</div>
          <div className="mt-0.5">
            <Price minor={earned} currency={jobs[0]?.currency} size="md" />
          </div>
        </div>
      </header>

      <div className="mb-5 flex flex-wrap gap-2 text-sm">
        {HISTORY_TABS.map((tab) => (
          <button
            key={tab || 'all'}
            onClick={() => setFilter(tab)}
            className={filter === tab ? 'chip chip-brand' : 'chip chip-neutral'}
          >
            {tab ? <StatusBadge status={tab} /> : t('providerHistory.all')}
          </button>
        ))}
      </div>

      {error && (
        <div className="card mb-4 flex flex-wrap items-center justify-between gap-2 border-[rgb(var(--danger)/0.35)] p-3 text-sm text-[rgb(var(--danger))]">
          <span>{error}</span>
          <button onClick={() => void load()} className="font-semibold underline">
            {t('common.retry')}
          </button>
        </div>
      )}

      {loading ? (
        <div className="card flex items-center justify-center gap-2 px-5 py-10 text-sm text-[rgb(var(--fg-muted))]">
          <Spinner size={18} />
          {t('common.loading')}
        </div>
      ) : jobs.length === 0 ? (
        <EmptyState
          title={t('providerHistory.empty')}
          icon={<CategoryIcon name="checklist" size={26} />}
        />
      ) : (
        <ul className="space-y-3">
          {jobs.map((j, i) => (
            <li key={j.id} className="fade-rise" style={{ animationDelay: `${i * 40}ms` }}>
              <Link
                href={`/${locale}/provider/jobs/${j.id}`}
                className="card card-tap flex items-center justify-between gap-4 p-4"
              >
                <div className="min-w-0">
                  <span className="font-bold">
                    {j.code} · {j.service_name ?? t('job.title')}
                  </span>
                  <p className="mt-0.5 text-xs text-[rgb(var(--fg-subtle))]">
                    {j.pickup_city_name ?? '—'}
                    {j.completed_at && ` · ${new Date(j.completed_at).toLocaleDateString(locale)}`}
                  </p>
                </div>
                <div className="flex-none text-end">
                  <Price minor={j.provider_net_minor ?? 0} currency={j.currency} size="sm" />
                  <div className="mt-1.5">
                    <StatusBadge status={j.status} />
                  </div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

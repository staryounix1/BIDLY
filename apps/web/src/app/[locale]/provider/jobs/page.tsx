'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { jobsApi, providerNextAction, type JobSummary } from '@/lib/jobs-api';
import { StatusBadge } from '@/lib/status-badge';
import { CategoryIcon } from '@/lib/icons';
import { Price, Spinner } from '@/lib/ui';

/**
 * Provider jobs.
 *
 * Split into active work and history. "Active" is every status where the
 * provider still has an action; everything else is past work. History is scoped
 * by the API to the signed-in provider, so one provider can never see another's
 * jobs.
 */

const ACTIVE_STATUSES = [
  'CREATED',
  'CONFIRMED',
  'PROVIDER_EN_ROUTE',
  'PROVIDER_ARRIVED',
  'IN_PROGRESS',
  'STARTED',
];

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
    <div className="app-shell container-page py-5">
      <header className="mb-4">
        <h1 className="text-2xl font-black tracking-tight">{t('providerJob.title')}</h1>
        <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('providerJob.subtitle')}</p>
      </header>

      <div className="mb-4 flex gap-2">
        {(['active', 'history'] as const).map((key) => {
          const count = key === 'active' ? active.length : history.length;
          return (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={
                tab === key ? 'chip chip-brand h-9 flex-1 px-4 text-sm' : 'chip chip-neutral h-9 flex-1 px-4 text-sm'
              }
            >
              {t(`providerJob.tab.${key}`)}
              <span className="tnum">({count})</span>
            </button>
          );
        })}
      </div>

      {error && (
        <div className="card mb-4 flex items-center justify-between gap-3 border-[rgb(var(--danger)/0.35)] p-3.5">
          <span className="text-sm font-semibold text-[rgb(var(--danger))]">{error}</span>
          <button onClick={() => void load()} className="text-sm font-bold underline">
            {t('common.retry')}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-16">
          <Spinner size={26} />
        </div>
      ) : shown.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
          <span className="icon-tile h-16 w-16">
            <CategoryIcon name="route" size={28} />
          </span>
          <p className="text-base font-bold">
            {tab === 'active' ? t('providerJob.noActive') : t('providerJob.noHistory')}
          </p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {shown.map((j, index) => {
            const next = providerNextAction(j.status);
            const isActive = ACTIVE_STATUSES.includes(j.status);
            return (
              <li
                key={j.id}
                className={`card slide-in p-4 ${isActive ? 'card-featured' : ''}`}
                style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className="icon-tile h-11 w-11">
                      <CategoryIcon name={isActive ? 'route' : 'check'} size={21} />
                    </span>
                    <div className="min-w-0">
                      <Link
                        href={`/${locale}/provider/jobs/${j.id}`}
                        className="block truncate text-[0.9375rem] font-bold"
                      >
                        {j.code} · {j.service_name ?? t('job.title')}
                      </Link>
                      <p className="mt-0.5 truncate text-xs text-[rgb(var(--fg-muted))]">
                        {j.pickup_city_name ?? '—'}
                        {j.scheduled_at
                          ? ` · ${new Date(j.scheduled_at).toLocaleDateString(locale)}`
                          : ''}
                      </p>
                    </div>
                  </div>
                  <StatusBadge status={j.status} />
                </div>

                <div className="mt-3 flex items-center justify-between gap-3 border-t border-[rgb(var(--line))] pt-3">
                  <span className="text-xs font-semibold text-[rgb(var(--fg-muted))]">
                    {t('job.providerNet')}
                  </span>
                  <Price minor={j.provider_net_minor} currency={j.currency} size="md" />
                </div>

                {next && (
                  <Link href={`/${locale}/provider/jobs/${j.id}`} className="btn btn-primary btn-block mt-3">
                    <CategoryIcon name="arrow" size={18} className="rtl:rotate-180" />
                    {t(`providerJob.next.${next}`)}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

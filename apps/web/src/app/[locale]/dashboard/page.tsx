'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { useAuth } from '@/lib/auth-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { requestsApi, type RequestSummary } from '@/lib/requests-api';
import { jobsApi } from '@/lib/jobs-api';
import { NearbyProvidersMap } from '@/lib/map/nearby-providers';
import { StatusBadge } from '@/lib/status-badge';

/**
 * Customer dashboard.
 *
 * A single landing screen that surfaces the customer's live situation: the
 * request currently in flight, headline counts, and shortcuts into the flows
 * they can act on. Everything is computed from the real APIs — the request
 * list, the offers received across requests, and the confirmed jobs.
 */
export default function DashboardPage() {
  return (
    <RequireAuth roles={['CUSTOMER']}>
      <DashboardView />
    </RequireAuth>
  );
}

const OPEN_STATUSES = ['PUBLISHED', 'MATCHING', 'RECEIVING_OFFERS', 'PROVIDER_SELECTED', 'CONFIRMED', 'IN_PROGRESS'];

function DashboardView() {
  const { t, locale } = useI18n();
  const { user } = useAuth();

  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [offerCount, setOfferCount] = useState(0);
  const [jobCount, setJobCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [mine, jobs] = await Promise.all([
        requestsApi.mine({ limit: 50 }),
        jobsApi.mine({ role: 'customer', limit: 50 }).catch(() => ({ items: [] })),
      ]);
      const items = mine.items ?? [];
      setRequests(items);
      setJobCount((jobs.items ?? []).filter((j) => j.status !== 'COMPLETED' && j.status !== 'CANCELLED').length);

      // Total offers received on the customer's own requests. The detail call
      // is owner-scoped, so this never leaks another customer's offers.
      const withOffers = items.filter((r) => r.offer_count > 0).slice(0, 10);
      const details = await Promise.all(
        withOffers.map((r) => requestsApi.get(r.id).catch(() => null)),
      );
      setOfferCount(details.reduce((sum, d) => sum + (d?.offers?.length ?? 0), 0));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return <main className="mx-auto max-w-5xl px-4 py-10 opacity-60">{t('common.loading')}</main>;
  }

  const active = requests.find((r) => OPEN_STATUSES.includes(r.status));
  const openCount = requests.filter((r) => OPEN_STATUSES.includes(r.status)).length;

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">
            {t('dashboard.welcome')}
            {user?.email ? `، ${user.email.split('@')[0]}` : ''}
          </h1>
          <p className="mt-1 text-sm opacity-70">{t('dashboard.subtitle')}</p>
        </div>
        <Link
          href={`/${locale}/requests/new`}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white dark:bg-white dark:text-slate-900"
        >
          + {t('dashboard.newRequest')}
        </Link>
      </header>

      {error && (
        <p className="mt-5 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}{' '}
          <button onClick={load} className="underline">
            {t('common.retry')}
          </button>
        </p>
      )}

      {/* Who is around — the marketplace's supply, made visible. */}
      <section className="mt-6">
        <NearbyProvidersMap radiusKm={15} height={280} />
      </section>

      {/* Active request — the most important thing on the screen. */}
      <section className="mt-6">
        <h2 className="text-sm font-semibold opacity-70">{t('dashboard.activeRequest')}</h2>
        {active ? (
          <Link
            href={`/${locale}/requests/${active.id}`}
            className="mt-2 block rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-5 transition hover:border-emerald-500/60"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-lg font-semibold">{active.title || active.service_name}</div>
                <p className="mt-0.5 text-xs opacity-60">
                  <span className="mono">{active.code}</span> · {active.service_name}
                  {active.pickup_city_name ? ` · ${active.pickup_city_name}` : ''}
                </p>
              </div>
              <StatusBadge status={active.status} />
            </div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs opacity-70">
              <span>
                {t('request.offersCount')}: <strong>{active.offer_count}</strong>
              </span>
              {active.expires_at && (
                <span>
                  {t('feed.expires')}: {new Date(active.expires_at).toLocaleDateString(locale)}
                </span>
              )}
            </div>
          </Link>
        ) : (
          <div className="mt-2 rounded-2xl border border-dashed border-black/15 p-8 text-center dark:border-white/15">
            <p className="opacity-70">{t('dashboard.noActive')}</p>
            <p className="mt-1 text-sm opacity-50">{t('dashboard.noActiveHint')}</p>
            <Link
              href={`/${locale}/services`}
              className="mt-3 inline-block text-sm font-medium underline"
            >
              {t('dashboard.browseServices')}
            </Link>
          </div>
        )}
      </section>

      {/* Headline numbers. */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold opacity-70">{t('dashboard.stats')}</h2>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label={t('dashboard.totalRequests')} value={requests.length} />
          <Stat label={t('dashboard.openRequests')} value={openCount} />
          <Stat label={t('dashboard.receivedOffers')} value={offerCount} />
          <Stat label={t('dashboard.activeJobs')} value={jobCount} />
        </div>
      </section>

      {/* Shortcuts. */}
      <section className="mt-8">
        <h2 className="text-sm font-semibold opacity-70">{t('dashboard.quickActions')}</h2>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Action href={`/${locale}/services`} label={t('dashboard.browseServices')} />
          <Action href={`/${locale}/requests`} label={t('request.myTitle')} />
          <Action href={`/${locale}/jobs`} label={t('dashboard.myJobs')} />
          <Action href={`/${locale}/profile`} label={t('nav.profile')} />
        </div>
      </section>

      {/* Recent requests. */}
      {requests.length > 0 && (
        <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold opacity-70">{t('dashboard.recentRequests')}</h2>
            <Link href={`/${locale}/requests`} className="text-xs underline">
              {t('dashboard.viewAll')}
            </Link>
          </div>
          <ul className="mt-2 space-y-2">
            {requests.slice(0, 5).map((r) => (
              <li key={r.id}>
                <Link
                  href={`/${locale}/requests/${r.id}`}
                  className="flex items-center justify-between gap-4 rounded-xl border border-black/10 p-3 text-sm transition hover:border-slate-400 dark:border-white/15 dark:hover:border-white/40"
                >
                  <span className="min-w-0 truncate">{r.title || r.service_name}</span>
                  <StatusBadge status={r.status} />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-black/10 p-4 text-center dark:border-white/15">
      <div className="text-3xl font-bold">{value}</div>
      <div className="mt-1 text-xs opacity-60">{label}</div>
    </div>
  );
}

function Action({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="rounded-2xl border border-black/10 p-4 text-center text-sm font-medium transition hover:border-slate-400 dark:border-white/15 dark:hover:border-white/40"
    >
      {label}
    </Link>
  );
}

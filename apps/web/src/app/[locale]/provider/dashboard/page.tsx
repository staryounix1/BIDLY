'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { providersApi, type ProviderProfile, type FeedRequest } from '@/lib/providers-api';
import { offersApi, type OfferOnRequest } from '@/lib/offers-api';
import { jobsApi, providerNextAction, type JobSummary } from '@/lib/jobs-api';
import { StatusBadge } from '@/lib/status-badge';

/**
 * Provider dashboard (spec §40, task 7 requirement 1).
 *
 * One screen that answers the provider's four questions in order: am I
 * available, what can I earn right now, what am I working on, and how am I
 * doing. Availability is written straight through to the API — never kept in
 * component state alone — so the matching engine sees the same truth the
 * provider does.
 */

const ACTIVE_JOB_STATUSES = ['CREATED', 'CONFIRMED', 'PROVIDER_EN_ROUTE', 'PROVIDER_ARRIVED', 'IN_PROGRESS', 'STARTED'];

export default function ProviderDashboardPage() {
  return (
    <RequireAuth roles={['PROVIDER', 'ADMIN']}>
      <ProviderDashboardView />
    </RequireAuth>
  );
}

function ProviderDashboardView() {
  const { t, locale } = useI18n();
  const [profile, setProfile] = useState<ProviderProfile | null | undefined>(undefined);
  const [feed, setFeed] = useState<FeedRequest[]>([]);
  const [pendingOffers, setPendingOffers] = useState<OfferOnRequest[]>([]);
  const [activeJobs, setActiveJobs] = useState<JobSummary[]>([]);
  const [recentJobs, setRecentJobs] = useState<JobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingAvailability, setTogglingAvailability] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await providersApi.me();
      setProfile(me);
      if (me) {
        const [feedRes, offersRes, jobsRes] = await Promise.all([
          providersApi.feed({ limit: 5 }),
          offersApi.mine({ limit: 5, status: 'PENDING' }),
          jobsApi.mine({ limit: 20, role: 'provider' }),
        ]);
        setFeed(feedRes.items ?? []);
        setPendingOffers(offersRes.items ?? []);
        const jobs = jobsRes.items ?? [];
        setActiveJobs(jobs.filter((j) => ACTIVE_JOB_STATUSES.includes(j.status)));
        setRecentJobs(jobs.filter((j) => !ACTIVE_JOB_STATUSES.includes(j.status)).slice(0, 5));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setOnline(next: boolean) {
    setTogglingAvailability(true);
    setError(null);
    try {
      const updated = await providersApi.update({ isOnline: next, isAvailable: next });
      setProfile(updated);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setTogglingAvailability(false);
    }
  }

  if (loading) {
    return <main className="mx-auto max-w-5xl px-4 py-10 text-center opacity-60">{t('common.loading')}</main>;
  }

  if (!profile) {
    return (
      <main className="mx-auto max-w-2xl px-4 py-12 text-center">
        <h1 className="text-2xl font-bold">{t('provider.title')}</h1>
        <p className="mt-2 text-sm opacity-70">{t('provider.subtitle')}</p>
        <Link
          href={`/${locale}/provider/profile`}
          className="mt-6 inline-block rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white dark:bg-white dark:text-slate-900"
        >
          {t('provider.create')}
        </Link>
      </main>
    );
  }

  const isOnline = Boolean(profile.is_online);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{t('providerDash.title')}</h1>
          <p className="mt-1 text-sm opacity-70">
            {t('providerDash.welcome')}, {profile.display_name}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <StatusBadge status={profile.status} />
          <StatusBadge status={profile.verification_status} />
        </div>
      </header>

      {error && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          <span>{error}</span>
          <button onClick={() => void load()} className="underline">
            {t('common.retry')}
          </button>
        </div>
      )}

      {profile.status !== 'ACTIVE' && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-medium">{t('providerDash.notActive')}</p>
          <p className="mt-1 text-xs">{t('providerDash.notActiveHint')}</p>
        </div>
      )}

      {/* Availability — the single most important control on the screen. */}
      <section className="rounded-2xl border border-black/10 p-5 dark:border-white/15">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="font-semibold">{t('providerDash.availability')}</h2>
            <p className="mt-1 text-xs opacity-70">
              {isOnline ? t('providerDash.onlineHint') : t('providerDash.offlineHint')}
            </p>
          </div>
          <button
            onClick={() => void setOnline(!isOnline)}
            disabled={togglingAvailability}
            aria-pressed={isOnline}
            className={
              'relative inline-flex h-9 min-w-[7rem] items-center justify-center rounded-full px-4 text-sm font-semibold transition disabled:opacity-50 ' +
              (isOnline
                ? 'bg-emerald-600 text-white'
                : 'border border-black/20 opacity-80 dark:border-white/25')
            }
          >
            <span
              className={
                'me-2 inline-block h-2 w-2 rounded-full ' + (isOnline ? 'bg-white' : 'bg-slate-400')
              }
            />
            {isOnline ? t('providerDash.online') : t('providerDash.offline')}
          </button>
        </div>
      </section>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label={t('providerDash.rating')} value={profile.rating_avg ? Number(profile.rating_avg).toFixed(1) : '—'} />
        <Stat label={t('providerDash.completedJobs')} value={String(profile.completed_jobs ?? 0)} />
        <Stat label={t('providerDash.activeJobs')} value={String(activeJobs.length)} />
        <Stat label={t('providerDash.pendingOffers')} value={String(pendingOffers.length)} />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        {/* Active job */}
        <section className="rounded-2xl border border-black/10 p-5 dark:border-white/15">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">{t('providerDash.activeJob')}</h2>
            <Link href={`/${locale}/provider/jobs`} className="text-xs underline opacity-70">
              {t('providerDash.viewAll')}
            </Link>
          </div>
          {activeJobs.length === 0 ? (
            <p className="mt-3 text-sm opacity-60">{t('providerDash.noActiveJob')}</p>
          ) : (
            <ul className="mt-3 space-y-3">
              {activeJobs.slice(0, 3).map((j) => {
                const next = providerNextAction(j.status);
                return (
                  <li key={j.id} className="rounded-xl border border-black/10 p-3 dark:border-white/15">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Link href={`/${locale}/provider/jobs/${j.id}`} className="font-medium hover:underline">
                        {j.code} · {j.service_name ?? t('job.title')}
                      </Link>
                      <StatusBadge status={j.status} />
                    </div>
                    <p className="mt-1 text-xs opacity-70">
                      {j.pickup_city_name ?? '—'} ·{' '}
                      {((j.provider_net_minor ?? 0) / 100).toFixed(2)} {j.currency}
                    </p>
                    {next && (
                      <Link
                        href={`/${locale}/provider/jobs/${j.id}`}
                        className="mt-2 inline-block rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white dark:bg-white dark:text-slate-900"
                      >
                        {t(`providerJob.next.${next}`)}
                      </Link>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* Nearby requests */}
        <section className="rounded-2xl border border-black/10 p-5 dark:border-white/15">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">{t('providerDash.nearbyRequests')}</h2>
            <Link href={`/${locale}/provider/requests`} className="text-xs underline opacity-70">
              {t('providerDash.viewAll')}
            </Link>
          </div>
          {feed.length === 0 ? (
            <p className="mt-3 text-sm opacity-60">
              {isOnline ? t('feed.empty') : t('providerDash.goOnlineHint')}
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {feed.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/${locale}/provider/requests/${r.id}`}
                    className="block rounded-xl border border-black/10 p-3 hover:border-slate-400 dark:border-white/15 dark:hover:border-white/40"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{r.title || r.service_name}</span>
                      <StatusBadge status={r.status} />
                    </div>
                    <p className="mt-1 text-xs opacity-70">
                      {r.pickup_city_name ?? '—'} ·{' '}
                      {r.budget_max_minor != null ? (r.budget_max_minor / 100).toFixed(0) : '—'} {r.currency}
                    </p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Pending offers */}
        <section className="rounded-2xl border border-black/10 p-5 dark:border-white/15">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">{t('providerDash.pendingOffers')}</h2>
            <Link href={`/${locale}/provider/offers`} className="text-xs underline opacity-70">
              {t('providerDash.viewAll')}
            </Link>
          </div>
          {pendingOffers.length === 0 ? (
            <p className="mt-3 text-sm opacity-60">{t('offer.empty')}</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {pendingOffers.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    <span className="mono text-xs opacity-60">{o.request_code}</span> {o.request_title || ''}
                  </span>
                  <span className="font-semibold">
                    {(o.price_minor / 100).toFixed(2)} {o.currency}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* History */}
        <section className="rounded-2xl border border-black/10 p-5 dark:border-white/15">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">{t('providerDash.history')}</h2>
            <Link href={`/${locale}/provider/history`} className="text-xs underline opacity-70">
              {t('providerDash.viewAll')}
            </Link>
          </div>
          {recentJobs.length === 0 ? (
            <p className="mt-3 text-sm opacity-60">{t('job.empty')}</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {recentJobs.map((j) => (
                <li key={j.id} className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/${locale}/provider/jobs/${j.id}`} className="hover:underline">
                    <span className="mono text-xs opacity-60">{j.code}</span> {j.service_name ?? ''}
                  </Link>
                  <StatusBadge status={j.status} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-black/10 p-4 dark:border-white/15">
      <div className="text-2xl font-bold">{value}</div>
      <div className="mt-1 text-xs opacity-60">{label}</div>
    </div>
  );
}

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
import { CategoryIcon } from '@/lib/icons';
import { Price, SectionTitle, Spinner } from '@/lib/ui';

/**
 * Provider dashboard.
 *
 * One screen that answers the provider's four questions in order: am I
 * available, what can I earn right now, what am I working on, and how am I
 * doing. Availability is written straight to the API — never held in component
 * state alone — so matching sees the same truth the provider does.
 *
 * Availability is a full-width action here because it is the one thing a
 * craftsman flips between jobs, one-handed, often in a stairwell.
 */

const ACTIVE_JOB_STATUSES = [
  'CREATED',
  'CONFIRMED',
  'PROVIDER_EN_ROUTE',
  'PROVIDER_ARRIVED',
  'IN_PROGRESS',
  'STARTED',
];

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
    return (
      <div className="app-shell container-page flex items-center justify-center py-24">
        <Spinner size={28} />
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="app-shell container-page py-14 text-center">
        <span className="icon-tile mx-auto h-16 w-16">
          <CategoryIcon name="wrench" size={28} />
        </span>
        <h1 className="mt-4 text-2xl font-black tracking-tight">{t('provider.title')}</h1>
        <p className="mt-2 text-sm text-[rgb(var(--fg-muted))]">{t('provider.subtitle')}</p>
        <Link href={`/${locale}/provider/profile`} className="btn btn-primary mt-6">
          {t('provider.create')}
        </Link>
      </div>
    );
  }

  const isOnline = Boolean(profile.is_online);

  return (
    <div className="app-shell container-page py-5">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tight">{t('providerDash.title')}</h1>
          <p className="mt-1 truncate text-sm text-[rgb(var(--fg-muted))]">{profile.display_name}</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <StatusBadge status={profile.status} />
          <StatusBadge status={profile.verification_status} />
        </div>
      </header>

      {error && (
        <div className="card mb-4 flex items-center justify-between gap-3 border-[rgb(var(--danger)/0.35)] p-3.5">
          <span className="text-sm font-semibold text-[rgb(var(--danger))]">{error}</span>
          <button onClick={() => void load()} className="text-sm font-bold underline">
            {t('common.retry')}
          </button>
        </div>
      )}

      {profile.status !== 'ACTIVE' && (
        <div className="card mb-4 border-[rgb(var(--warn)/0.35)] bg-[rgb(var(--warn)/0.08)] p-4">
          <p className="text-sm font-bold text-[rgb(180_83_9)]">{t('providerDash.notActive')}</p>
          <p className="mt-1 text-xs text-[rgb(180_83_9)]">{t('providerDash.notActiveHint')}</p>
        </div>
      )}

      {/* Availability — the loudest control on the screen. */}
      <button
        type="button"
        onClick={() => void setOnline(!isOnline)}
        disabled={togglingAvailability}
        aria-pressed={isOnline}
        className="card card-tap flex w-full items-center gap-4 p-4 text-start disabled:opacity-60"
        style={
          isOnline
            ? {
                background: 'rgb(50 244 186 / 0.14)',
                borderColor: 'rgb(50 244 186 / 0.5)',
              }
            : undefined
        }
      >
        <span
          className="grid h-14 w-14 flex-none place-items-center rounded-2xl transition-colors"
          style={{
            background: isOnline ? 'rgb(50 244 186)' : 'rgb(var(--surface-3))',
            color: isOnline ? 'rgb(var(--brand-ink))' : 'rgb(var(--fg-muted))',
          }}
        >
          {togglingAvailability ? (
            <Spinner size={22} />
          ) : (
            <CategoryIcon name="bolt" size={26} />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-base font-black tracking-tight">
              {isOnline ? t('providerHome.availableNow') : t('providerHome.unavailableNow')}
            </span>
          </span>
          <span className="mt-0.5 block text-xs text-[rgb(var(--fg-muted))]">
            {t('providerHome.toggleHint')}
          </span>
        </span>

        {/* Switch */}
        <span
          className="relative inline-flex h-7 w-12 flex-none items-center rounded-full transition-colors"
          style={{ background: isOnline ? 'rgb(50 244 186)' : 'rgb(var(--line-strong))' }}
        >
          <span
            className="absolute h-5 w-5 rounded-full bg-white shadow-sm transition-all"
            style={{ insetInlineStart: isOnline ? '1.625rem' : '0.25rem' }}
          />
        </span>
      </button>

      {/* Stats */}
      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <Stat icon="star" label={t('providerDash.rating')} value={profile.rating_avg ? Number(profile.rating_avg).toFixed(1) : '—'} />
        <Stat icon="check" label={t('providerDash.completedJobs')} value={String(profile.completed_jobs ?? 0)} />
        <Stat icon="route" label={t('providerDash.activeJobs')} value={String(activeJobs.length)} />
        <Stat icon="chat" label={t('providerDash.pendingOffers')} value={String(pendingOffers.length)} />
      </div>

      {/* Active job */}
      <section className="mt-6">
        <SectionTitle
          action={
            <Link href={`/${locale}/provider/jobs`} className="text-sm font-bold text-[rgb(var(--brand-700))]">
              {t('providerDash.viewAll')}
            </Link>
          }
        >
          {t('providerDash.activeJob')}
        </SectionTitle>

        {activeJobs.length === 0 ? (
          <div className="card p-5 text-center text-sm text-[rgb(var(--fg-muted))]">
            {t('providerDash.noActiveJob')}
          </div>
        ) : (
          <ul className="space-y-2.5">
            {activeJobs.slice(0, 3).map((j) => {
              const next = providerNextAction(j.status);
              return (
                <li key={j.id} className="card card-featured slide-in p-4">
                  <div className="flex items-center justify-between gap-2">
                    <Link
                      href={`/${locale}/provider/jobs/${j.id}`}
                      className="truncate text-[0.9375rem] font-bold"
                    >
                      {j.code} · {j.service_name ?? t('job.title')}
                    </Link>
                    <StatusBadge status={j.status} />
                  </div>
                  <p className="mt-1 text-xs text-[rgb(var(--fg-muted))]">
                    {j.pickup_city_name ?? '—'}
                  </p>
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <Price minor={j.provider_net_minor} currency={j.currency} size="md" />
                    {next && (
                      <Link href={`/${locale}/provider/jobs/${j.id}`} className="btn btn-primary">
                        {t(`providerJob.next.${next}`)}
                      </Link>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Nearby requests */}
      <section className="mt-6">
        <SectionTitle
          action={
            <Link href={`/${locale}/provider/requests`} className="text-sm font-bold text-[rgb(var(--brand-700))]">
              {t('providerDash.viewAll')}
            </Link>
          }
        >
          {t('providerHome.nearbyRequests')}
        </SectionTitle>

        {feed.length === 0 ? (
          <div className="card p-5 text-center text-sm text-[rgb(var(--fg-muted))]">
            {isOnline ? t('feed.empty') : t('providerDash.goOnlineHint')}
          </div>
        ) : (
          <ul className="space-y-2.5">
            {feed.map((r, i) => (
              <li key={r.id}>
                <Link
                  href={`/${locale}/provider/requests/${r.id}`}
                  className="card card-tap slide-in block p-4"
                  style={{ animationDelay: `${i * 45}ms` }}
                >
                  <div className="flex items-start gap-3">
                    <span className="icon-tile h-11 w-11">
                      <CategoryIcon name="radar" size={21} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-[0.9375rem] font-bold">
                          {r.title || r.service_name}
                        </span>
                        <Price minor={r.budget_max_minor} currency={r.currency} size="md" />
                      </div>
                      <p className="mt-1 text-xs text-[rgb(var(--fg-muted))]">
                        {r.pickup_city_name ?? '—'}
                        {r.offer_count > 0 ? ` · ${r.offer_count} ${t('request.offer')}` : ''}
                      </p>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Pending offers + history */}
      <section className="mt-6">
        <SectionTitle
          action={
            <Link href={`/${locale}/provider/offers`} className="text-sm font-bold text-[rgb(var(--brand-700))]">
              {t('providerDash.viewAll')}
            </Link>
          }
        >
          {t('providerDash.pendingOffers')}
        </SectionTitle>

        {pendingOffers.length === 0 ? (
          <div className="card p-5 text-center text-sm text-[rgb(var(--fg-muted))]">
            {t('offer.empty')}
          </div>
        ) : (
          <ul className="card divide-y divide-[rgb(var(--line))]">
            {pendingOffers.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 p-3.5">
                <span className="min-w-0">
                  <span className="tnum block text-xs text-[rgb(var(--fg-subtle))]">
                    {o.request_code}
                  </span>
                  <span className="block truncate text-sm font-semibold">
                    {o.request_title || '—'}
                  </span>
                </span>
                <Price minor={o.price_minor} currency={o.currency} size="md" />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6">
        <SectionTitle
          action={
            <Link href={`/${locale}/provider/history`} className="text-sm font-bold text-[rgb(var(--brand-700))]">
              {t('providerDash.viewAll')}
            </Link>
          }
        >
          {t('providerDash.history')}
        </SectionTitle>

        {recentJobs.length === 0 ? (
          <div className="card p-5 text-center text-sm text-[rgb(var(--fg-muted))]">
            {t('job.empty')}
          </div>
        ) : (
          <ul className="card divide-y divide-[rgb(var(--line))]">
            {recentJobs.map((j) => (
              <li key={j.id} className="flex items-center justify-between gap-3 p-3.5">
                <Link
                  href={`/${locale}/provider/jobs/${j.id}`}
                  className="min-w-0 text-sm font-semibold"
                >
                  <span className="tnum block text-xs text-[rgb(var(--fg-subtle))]">{j.code}</span>
                  <span className="block truncate">{j.service_name ?? t('job.title')}</span>
                </Link>
                <StatusBadge status={j.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: string;
  label: string;
  value: string;
}) {
  return (
    <div className="card p-3.5">
      <span className="icon-tile mb-2 h-9 w-9">
        <CategoryIcon name={icon} size={18} />
      </span>
      <div className="tnum text-xl font-black tracking-tight">{value}</div>
      <div className="mt-0.5 text-xs text-[rgb(var(--fg-muted))]">{label}</div>
    </div>
  );
}

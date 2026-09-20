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
import { CategoryIcon, iconForSlug, type IconName } from '@/lib/icons';

/**
 * Customer dashboard.
 *
 * A single landing screen that surfaces the customer's live situation: the
 * request currently in flight, headline counts, and shortcuts into the flows
 * they can act on. Everything is computed from the real APIs — the request
 * list, the offers received across requests, and the confirmed jobs.
 *
 * Layout follows the marketplace pattern: a greeting banner carrying the
 * primary action, the live request elevated above everything else, a compact
 * stat strip, then supply (nearby providers) and history.
 */

const OPEN_STATUSES = [
  'PUBLISHED',
  'MATCHING',
  'RECEIVING_OFFERS',
  'PROVIDER_SELECTED',
  'CONFIRMED',
  'IN_PROGRESS',
];

/** Statuses that mean "someone is on their way to you right now". */
const TRACKABLE = ['PROVIDER_SELECTED', 'CONFIRMED', 'IN_PROGRESS'];

/** Currency formatting that never crashes on a null/NaN amount. */
function money(minor: number | null | undefined, currency: string): string {
  if (minor == null || !Number.isFinite(minor)) return '—';
  return `${Math.round(minor / 100).toLocaleString()} ${currency}`;
}

function relativeDays(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const days = Math.round((d.getTime() - Date.now()) / 86_400_000);
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(days, 'day');
}

export default function DashboardPage() {
  return (
    <RequireAuth roles={['CUSTOMER']}>
      <DashboardView />
    </RequireAuth>
  );
}

function DashboardView() {
  const { t, locale } = useI18n();
  const { user } = useAuth();

  const [requests, setRequests] = useState<RequestSummary[]>([]);
  const [offerCount, setOfferCount] = useState(0);
  const [jobCount, setJobCount] = useState(0);
  const [activeJob, setActiveJob] = useState<{ id: string; status: string; code: string } | null>(null);
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

      const liveJobs = (jobs.items ?? []).filter(
        (j) => j.status !== 'COMPLETED' && j.status !== 'CANCELLED',
      );
      setJobCount(liveJobs.length);
      const running = liveJobs.find((j) => TRACKABLE.includes(j.status));
      setActiveJob(running ? { id: running.id, status: running.status, code: running.code } : null);

      // Total offers received on the customer's own requests. The detail call
      // is owner-scoped, so this never leaks another customer's offers.
      const withOffers = items.filter((r) => r.offer_count > 0).slice(0, 10);
      const details = await Promise.all(withOffers.map((r) => requestsApi.get(r.id).catch(() => null)));
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

  const active = requests.find((r) => OPEN_STATUSES.includes(r.status));
  const openCount = requests.filter((r) => OPEN_STATUSES.includes(r.status)).length;
  const completedCount = requests.filter((r) => r.status === 'COMPLETED').length;
  const firstName = (user?.email?.split('@')[0] ?? '').trim();

  /** Pending offers across every open request — the customer's to-do list. */
  const pendingOffers = requests
    .filter((r) => OPEN_STATUSES.includes(r.status) && r.offer_count > 0)
    .reduce((n, r) => n + r.offer_count, 0);

  return (
    <div className="app-shell container-page py-5">
      {/* Greeting — carries identity and the primary action. */}
      <header className="fade-rise">
        <p className="text-xs font-bold uppercase tracking-wide text-[rgb(var(--fg-subtle))]">
          {t('dashboard.title')}
        </p>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight">
          {t('dashboard.welcome')}
          {firstName ? `، ${firstName}` : ''}
        </h1>
        <p className="mt-1.5 text-sm text-[rgb(var(--fg-muted))]">{t('dashboard.subtitle')}</p>
        <Link href={`/${locale}/requests/new`} className="btn btn-primary btn-block mt-4">
          <CategoryIcon name="spark" size={18} />
          {t('dashboard.newRequest')}
        </Link>
      </header>

      {/* Headline numbers. */}
      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <Stat
          icon="layers"
          label={t('dashboard.openRequests')}
          value={openCount}
          tone="brand"
          href={`/${locale}/requests`}
          loading={loading}
        />
        <Stat
          icon="bolt"
          label={t('dashboard.receivedOffers')}
          value={offerCount}
          tone="warn"
          href={`/${locale}/requests`}
          loading={loading}
          highlight={pendingOffers > 0}
        />
        <Stat
          icon="truck"
          label={t('dashboard.activeJobs')}
          value={jobCount}
          tone="ok"
          href={`/${locale}/jobs`}
          loading={loading}
        />
        <Stat
          icon="checklist"
          label={t('dashboard.totalRequests')}
          value={requests.length}
          tone="neutral"
          href={`/${locale}/requests`}
          loading={loading}
        />
      </div>

      {error && (
        <div className="card mt-4 flex flex-wrap items-center gap-3 border-[rgb(var(--danger)/0.35)] p-4 text-sm text-[rgb(var(--danger))]">
          <CategoryIcon name="shield" size={18} />
          <span className="flex-1">{error}</span>
          <button onClick={load} className="btn btn-secondary !py-1.5 !text-xs">
            {t('common.retry')}
          </button>
        </div>
      )}

      <div className="mt-5 space-y-6">
        {/* Live job — highest priority once a provider is assigned. */}
        {activeJob && (
          <section>
            <SectionTitle icon="truck" title={t('dashboard.liveJob')} hint={t('dashboard.liveJobHint')} />
            <Link
              href={`/${locale}/jobs/${activeJob.id}`}
              className="card card-tap card-featured fade-rise mt-3 block p-5"
            >
              <div className="flex items-center gap-4">
                <span className="relative grid h-12 w-12 flex-none place-items-center rounded-xl bg-[rgb(var(--brand-500))] text-[rgb(var(--brand-ink))]">
                  <span className="pulse-ring absolute inset-0 rounded-xl bg-[rgb(var(--brand-500))]" />
                  <CategoryIcon name="truck" size={22} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold">{t('dashboard.providerOnTheWay')}</span>
                    <StatusBadge status={activeJob.status} />
                  </div>
                  <p className="mt-0.5 text-xs text-[rgb(var(--fg-muted))]">
                    <span className="tnum">{activeJob.code}</span>
                  </p>
                </div>
                <span className="text-xs font-bold text-[rgb(var(--brand-700))]">
                  {t('dashboard.trackNow')}
                </span>
              </div>
            </Link>
          </section>
        )}

        {/* Active request — the most important thing on the screen. */}
        <section>
          <SectionTitle
            icon="bolt"
            title={t('dashboard.activeRequest')}
            action={
              active ? { href: `/${locale}/requests/${active.id}`, label: t('dashboard.openRequest') } : undefined
            }
          />
          {loading ? (
            <RequestSkeleton />
          ) : active ? (
            <ActiveRequestCard request={active} locale={locale} />
          ) : (
            <EmptyActive />
          )}
        </section>

        {/* Recent requests. */}
        {loading ? (
          <section>
            <SectionTitle icon="clock" title={t('dashboard.recentRequests')} />
            <div className="mt-3 space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="card flex items-center justify-between gap-4 p-3.5">
                  <div className="skeleton h-3.5 w-1/2" />
                  <div className="skeleton h-6 w-24 rounded-full" />
                </div>
              ))}
            </div>
          </section>
        ) : requests.length > 0 ? (
          <section>
            <SectionTitle
              icon="clock"
              title={t('dashboard.recentRequests')}
              action={{ href: `/${locale}/requests`, label: t('dashboard.viewAll') }}
            />
            <ul className="mt-3 space-y-2">
              {requests.slice(0, 5).map((r, i) => (
                <li key={r.id} className="slide-in" style={{ animationDelay: `${i * 40}ms` }}>
                  <RequestRow request={r} locale={locale} />
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section>
          <SectionTitle icon="pin" title={t('dashboard.nearbyProviders')} hint={t('dashboard.nearbyHint')} />
          <div className="card mt-3 overflow-hidden">
            <NearbyProvidersMap radiusKm={15} height={230} />
          </div>
        </section>

        <section>
          <SectionTitle icon="spark" title={t('dashboard.quickActions')} />
          <div className="mt-3 grid grid-cols-2 gap-2.5">
            <Action icon="layers" href={`/${locale}/services`} label={t('dashboard.browseServices')} />
            <Action icon="checklist" href={`/${locale}/requests`} label={t('request.myTitle')} />
            <Action icon="truck" href={`/${locale}/jobs`} label={t('dashboard.myJobs')} />
            <Action icon="shield" href={`/${locale}/profile`} label={t('nav.profile')} />
          </div>
        </section>

        {/* Follow-ups: what actually needs the customer's attention. */}
        {!loading && (pendingOffers > 0 || completedCount > 0 || jobCount > 0) && (
          <section>
            <SectionTitle icon="bolt" title={t('dashboard.needsAttention')} />
            <div className="card mt-3 divide-y divide-[rgb(var(--line))] overflow-hidden">
              {pendingOffers > 0 && (
                <FollowUp
                  icon="bolt"
                  tone="warn"
                  href={`/${locale}/requests`}
                  title={t('dashboard.offersWaiting', { count: pendingOffers })}
                  hint={t('dashboard.offersWaitingHint')}
                />
              )}
              {activeJob && (
                <FollowUp
                  icon="truck"
                  tone="ok"
                  href={`/${locale}/jobs/${activeJob.id}`}
                  title={t('dashboard.jobInProgress')}
                  hint={t('dashboard.jobInProgressHint')}
                />
              )}
              {completedCount > 0 && (
                <FollowUp
                  icon="checklist"
                  tone="brand"
                  href={`/${locale}/requests`}
                  title={t('dashboard.completedCount', { count: completedCount })}
                  hint={t('dashboard.completedCountHint')}
                />
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

const TONES: Record<string, { tile: string; value: string }> = {
  brand: { tile: 'bg-[rgb(var(--brand-500)/0.18)] text-[rgb(var(--brand-800))]', value: 'text-[rgb(var(--brand-700))]' },
  warn: { tile: 'bg-[rgb(var(--warn)/0.16)] text-[rgb(var(--warn))]', value: 'text-[rgb(var(--warn))]' },
  ok: { tile: 'bg-[rgb(var(--ok)/0.16)] text-[rgb(var(--ok))]', value: 'text-[rgb(var(--ok))]' },
  neutral: { tile: 'bg-[rgb(var(--surface-3))] text-[rgb(var(--fg-muted))]', value: 'text-[rgb(var(--fg))]' },
};

function Stat({
  icon,
  label,
  value,
  tone,
  href,
  loading,
  highlight,
}: {
  icon: IconName | string;
  label: string;
  value: number;
  tone: keyof typeof TONES;
  href: string;
  loading: boolean;
  highlight?: boolean;
}) {
  const tn = TONES[tone] ?? TONES.neutral!;
  return (
    <Link
      href={href}
      className={`card card-tap flex items-center gap-3 p-3.5 ${
        highlight ? 'ring-2 ring-[rgb(var(--warn)/0.6)]' : ''
      }`}
    >
      <span className={`icon-tile h-10 w-10 ${tn.tile}`}>
        <CategoryIcon name={icon as IconName} size={19} />
      </span>
      <div className="min-w-0">
        {loading ? (
          <div className="skeleton h-6 w-9" />
        ) : (
          <div className={`tnum text-2xl font-extrabold leading-none ${tn.value}`}>{value}</div>
        )}
        <div className="mt-1 truncate text-[0.6875rem] font-semibold text-[rgb(var(--fg-subtle))]">
          {label}
        </div>
      </div>
    </Link>
  );
}

function SectionTitle({
  icon,
  title,
  hint,
  action,
}: {
  icon: IconName | string;
  title: string;
  hint?: string;
  action?: { href: string; label: string };
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div className="flex items-center gap-2">
        <span className="icon-tile icon-tile-neutral h-7 w-7">
          <CategoryIcon name={icon as IconName} size={15} />
        </span>
        <div>
          <h2 className="text-sm font-bold leading-tight">{title}</h2>
          {hint && <p className="text-[0.6875rem] text-[rgb(var(--fg-subtle))]">{hint}</p>}
        </div>
      </div>
      {action && (
        <Link
          href={action.href}
          className="text-xs font-bold text-[rgb(var(--brand-700))] hover:underline"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}

/** The in-flight request, with the offer signal called out. */
function ActiveRequestCard({ request, locale }: { request: RequestSummary; locale: string }) {
  const { t } = useI18n();
  const icon = iconForSlug(request.service_slug || request.service_name || '');
  const expiry = relativeDays(request.expires_at, locale);

  return (
    <Link
      href={`/${locale}/requests/${request.id}`}
      className="card card-tap card-featured fade-rise mt-3 block p-5"
    >
      <div className="flex items-start gap-4">
        <span className="icon-tile h-12 w-12">
          <CategoryIcon name={icon as IconName} size={22} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate font-bold">{request.title || request.service_name}</h3>
            <StatusBadge status={request.status} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[rgb(var(--fg-muted))]">
            <span className="tnum font-semibold">{request.code}</span>
            <span aria-hidden>·</span>
            <span>{request.service_name}</span>
            {request.pickup_city_name && (
              <>
                <span aria-hidden>·</span>
                <span>{request.pickup_city_name}</span>
              </>
            )}
          </p>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-xl bg-[rgb(var(--surface-2))] px-3 py-2.5">
          <div className="text-[0.6875rem] font-semibold text-[rgb(var(--fg-subtle))]">
            {t('dashboard.receivedOffers')}
          </div>
          <div className="tnum mt-0.5 text-lg font-extrabold">{request.offer_count}</div>
        </div>
        <div className="rounded-xl bg-[rgb(var(--surface-2))] px-3 py-2.5">
          <div className="text-[0.6875rem] font-semibold text-[rgb(var(--fg-subtle))]">{t('request.budget')}</div>
          <div className="tnum mt-0.5 truncate text-sm font-bold">
            {request.budget_min_minor == null && request.budget_max_minor == null
              ? t('catalog.priceOnRequest')
              : `${money(request.budget_min_minor, request.currency)} – ${money(request.budget_max_minor, request.currency)}`}
          </div>
        </div>
        {expiry && (
          <div className="rounded-xl bg-[rgb(var(--surface-2))] px-3 py-2.5">
            <div className="text-[0.6875rem] font-semibold text-[rgb(var(--fg-subtle))]">{t('feed.expires')}</div>
            <div className="mt-0.5 truncate text-sm font-bold">{expiry}</div>
          </div>
        )}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-[rgb(var(--line))] pt-3.5">
        <span className="text-xs text-[rgb(var(--fg-muted))]">
          {request.offer_count > 0 ? t('dashboard.offersReady') : t('dashboard.waitingOffers')}
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs font-bold text-[rgb(var(--brand-700))]">
          {request.offer_count > 0 ? t('dashboard.compareOffers') : t('dashboard.openRequest')}
          <CategoryIcon name="chevron" size={14} className="rtl:rotate-180" />
        </span>
      </div>
    </Link>
  );
}

/** A compact row in the recent-requests list. */
function RequestRow({ request, locale }: { request: RequestSummary; locale: string }) {
  const icon = iconForSlug(request.service_slug || request.service_name || '');
  return (
    <Link
      href={`/${locale}/requests/${request.id}`}
      className="card card-tap flex items-center gap-3.5 p-3.5"
    >
      <span className="icon-tile icon-tile-neutral h-10 w-10">
        <CategoryIcon name={icon as IconName} size={19} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">{request.title || request.service_name}</div>
        <div className="tnum truncate text-xs text-[rgb(var(--fg-subtle))]">
          {request.code} · {request.service_name}
        </div>
      </div>
      {request.offer_count > 0 && (
        <span className="chip chip-brand tnum">
          <CategoryIcon name="bolt" size={12} />
          {request.offer_count}
        </span>
      )}
      <StatusBadge status={request.status} />
    </Link>
  );
}

function Action({
  icon,
  href,
  label,
}: {
  icon: IconName | string;
  href: string;
  label: string;
}) {
  return (
    <Link href={href} className="card card-tap flex items-center gap-2.5 p-3.5">
      <span className="icon-tile icon-tile-neutral h-9 w-9">
        <CategoryIcon name={icon as IconName} size={17} />
      </span>
      <span className="truncate text-[0.8125rem] font-semibold">{label}</span>
    </Link>
  );
}

function FollowUp({
  icon,
  tone,
  href,
  title,
  hint,
}: {
  icon: IconName | string;
  tone: keyof typeof TONES;
  href: string;
  title: string;
  hint: string;
}) {
  const tn = TONES[tone] ?? TONES.neutral!;
  return (
    <Link href={href} className="flex items-center gap-3 p-3.5 transition hover:bg-[rgb(var(--surface-3))]">
      <span className={`icon-tile h-9 w-9 ${tn.tile}`}>
        <CategoryIcon name={icon as IconName} size={17} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[0.8125rem] font-bold">{title}</div>
        <div className="truncate text-[0.6875rem] text-[rgb(var(--fg-subtle))]">{hint}</div>
      </div>
      <CategoryIcon name="chevron" size={14} className="text-[rgb(var(--fg-subtle))] rtl:rotate-180" />
    </Link>
  );
}

/** Empty state for "no active request" — an invitation, not a dead end. */
function EmptyActive() {
  const { t, locale } = useI18n();
  return (
    <div className="card fade-rise mt-3 border-dashed px-6 py-10 text-center">
      <span className="icon-tile mx-auto h-16 w-16">
        <CategoryIcon name="spark" size={30} />
      </span>
      <p className="mt-4 font-bold">{t('dashboard.noActive')}</p>
      <p className="mx-auto mt-1 max-w-sm text-sm text-[rgb(var(--fg-muted))]">{t('dashboard.noActiveHint')}</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
        <Link href={`/${locale}/requests/new`} className="btn btn-primary">
          <CategoryIcon name="spark" size={16} />
          {t('dashboard.newRequest')}
        </Link>
        <Link href={`/${locale}/services`} className="btn btn-secondary">
          {t('dashboard.browseServices')}
        </Link>
      </div>
    </div>
  );
}

function RequestSkeleton() {
  return (
    <div className="card mt-3 p-5">
      <div className="flex items-start gap-4">
        <div className="skeleton h-12 w-12 rounded-xl" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-4 w-1/2" />
          <div className="skeleton h-3 w-1/3" />
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="skeleton h-14 rounded-xl" />
        ))}
      </div>
    </div>
  );
}

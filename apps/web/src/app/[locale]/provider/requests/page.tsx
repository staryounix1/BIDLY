'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { providersApi, type FeedRequest, type ProviderProfile } from '@/lib/providers-api';
import { StatusBadge } from '@/lib/status-badge';

/**
 * Provider request feed (build order sprint 4-5).
 *
 * Shows published requests that match at least one service the provider has
 * activated. Eligibility, expiry and "already offered" filtering all happen
 * server-side; this screen only renders the result. A signed-in provider with
 * no profile yet is guided to create one.
 */
export default function ProviderFeedPage() {
  return (
    <RequireAuth roles={['PROVIDER', 'ADMIN']}>
      <FeedView />
    </RequireAuth>
  );
}

function FeedView() {
  const { t, locale } = useI18n();
  const [profile, setProfile] = useState<ProviderProfile | null | undefined>(undefined);
  const [requests, setRequests] = useState<FeedRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await providersApi.me();
      setProfile(me);
      if (me) {
        const feed = await providersApi.feed({ limit: 30 });
        setRequests(feed.items ?? []);
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

  if (loading) {
    return <main className="mx-auto max-w-4xl px-4 py-10 opacity-60">{t('common.loading')}</main>;
  }

  const activeProfile = profile;
  if (!activeProfile) {
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

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('feed.title')}</h1>
          <p className="mt-1 text-sm opacity-70">{t('feed.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <StatusBadge status={activeProfile.status} />
          <Link
            href={`/${locale}/provider/profile`}
            className="rounded-lg border border-black/15 px-3 py-1.5 font-medium dark:border-white/20"
          >
            {t('provider.title')}
          </Link>
          <Link
            href={`/${locale}/provider/offers`}
            className="rounded-lg border border-black/15 px-3 py-1.5 font-medium dark:border-white/20"
          >
            {t('offer.myTitle')}
          </Link>
        </div>
      </header>

      {activeProfile.status !== 'ACTIVE' && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <p className="font-medium">{t('provider.status')}: {activeProfile.status}</p>
          <p className="mt-1 flex items-center gap-2 text-xs">
            {t('provider.verification')}: <StatusBadge status={activeProfile.verification_status} />
          </p>
        </div>
      )}

      {error && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {requests.length === 0 ? (
        <p className="mt-6 rounded-2xl border border-black/10 px-5 py-10 text-center text-sm opacity-60 dark:border-white/15">
          {t('feed.empty')}
        </p>
      ) : (
        <ul className="mt-4 space-y-3">
          {requests.map((r) => (
            <li
              key={r.id}
              className="rounded-2xl border border-black/10 p-5 transition hover:border-slate-400 dark:border-white/15 dark:hover:border-white/40"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link
                    href={`/${locale}/provider/requests/${r.id}`}
                    className="text-lg font-semibold hover:underline"
                  >
                    {r.title || r.service_name}
                  </Link>
                  <p className="mt-0.5 text-xs opacity-60">
                    <span className="mono">{r.code}</span> · {r.service_name} · {r.category_name}
                  </p>
                </div>
                <StatusBadge status={r.status} />
              </div>

              {r.description && (
                <p className="mt-2 line-clamp-2 text-sm opacity-80">{r.description}</p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs opacity-70">
                <span>
                  {t('feed.budget')}:{' '}
                  {r.budget_min_minor != null || r.budget_max_minor != null ? (
                    <>
                      {r.budget_min_minor != null ? (r.budget_min_minor / 100).toFixed(0) : '—'}–
                      {r.budget_max_minor != null ? (r.budget_max_minor / 100).toFixed(0) : '—'} {r.currency}
                    </>
                  ) : (
                    '—'
                  )}
                </span>
                {r.pickup_city_name && <span>{r.pickup_city_name}</span>}
                <span>
                  {t('feed.offersCount')}: {r.offer_count}
                </span>
                {r.published_at && (
                  <span>
                    {t('feed.posted')}: {new Date(r.published_at).toLocaleDateString(locale)}
                  </span>
                )}
                {r.expires_at && (
                  <span>
                    {t('feed.expires')}: {new Date(r.expires_at).toLocaleDateString(locale)}
                  </span>
                )}
              </div>

              <div className="mt-4">
                <Link
                  href={`/${locale}/provider/requests/${r.id}`}
                  className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white dark:bg-white dark:text-slate-900"
                >
                  {t('offer.submit')}
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

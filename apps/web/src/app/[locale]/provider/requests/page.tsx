'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { useAutoRefresh } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime-client';
import { providersApi, type FeedRequest, type ProviderProfile } from '@/lib/providers-api';
import { StatusBadge } from '@/lib/status-badge';
import { CategoryIcon } from '@/lib/icons';
import { SectionTitle, Spinner } from '@/lib/ui';

/**
 * Provider request feed.
 *
 * Shows published requests matching at least one service the provider has
 * activated. Eligibility, expiry and "already offered" filtering all happen
 * server-side; this screen only renders the result. A provider with no profile
 * yet is guided to create one.
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

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const me = await providersApi.me();
      setProfile(me);
      if (me) {
        const feed = await providersApi.feed({ limit: 30 });
        setRequests(feed.items ?? []);
      }
    } catch (err) {
      if (!silent) setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  // New requests matching this provider's services appear without a reload.
  // A provider room carries the event; the poll covers a dropped stream.
  const [liveBump, setLiveBump] = useState(0);
  useRealtime({}, {
    onEvent: (env) => {
      if (env.event === 'request:updated' || env.event === 'notification:new') {
        setLiveBump((n) => n + 1);
      }
    },
  });
  const refresh = useCallback(() => load(true), [load]);
  useAutoRefresh(refresh, {
    enabled: Boolean(profile),
    intervalMs: 20_000,
    bump: liveBump,
  });

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

  return (
    <div className="app-shell container-page py-5">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-black tracking-tight">{t('feed.title')}</h1>
          <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('feed.subtitle')}</p>
        </div>
        <StatusBadge status={profile.status} />
      </header>

      {profile.status !== 'ACTIVE' && (
        <div className="card mb-4 border-[rgb(var(--warn)/0.35)] bg-[rgb(var(--warn)/0.08)] p-4">
          <p className="text-sm font-bold text-[rgb(180_83_9)]">
            {t('provider.status')}: {profile.status}
          </p>
          <p className="mt-1 flex items-center gap-2 text-xs text-[rgb(180_83_9)]">
            {t('provider.verification')}: <StatusBadge status={profile.verification_status} />
          </p>
        </div>
      )}

      {error && (
        <p className="card mb-4 border-[rgb(var(--danger)/0.35)] p-3.5 text-sm font-semibold text-[rgb(var(--danger))]">
          {error}
        </p>
      )}

      {requests.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
          <span className="icon-tile h-16 w-16">
            <CategoryIcon name="radar" size={28} />
          </span>
          <p className="text-base font-bold">{t('feed.empty')}</p>
        </div>
      ) : (
        <>
          <SectionTitle
            action={
              <span className="chip chip-brand tnum">{requests.length}</span>
            }
          >
            {t('feed.title')}
          </SectionTitle>

          <ul className="space-y-2.5">
            {requests.map((r, index) => (
              <li key={r.id}>
                <Link
                  href={`/${locale}/provider/requests/${r.id}`}
                  className="card card-tap slide-in block p-4"
                  style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[0.9375rem] font-bold">
                        {r.title || r.service_name}
                      </p>
                      <p className="tnum mt-0.5 truncate text-xs text-[rgb(var(--fg-subtle))]">
                        {r.code} · {r.service_name}
                      </p>
                    </div>
                    <StatusBadge status={r.status} />
                  </div>

                  {r.description && (
                    <p className="mt-2 line-clamp-2 text-sm text-[rgb(var(--fg-muted))]">
                      {r.description}
                    </p>
                  )}

                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-[rgb(var(--line))] pt-3 text-xs">
                    <span className="flex items-center gap-1.5 font-bold text-[rgb(var(--fg))]">
                      <CategoryIcon name="wallet" size={14} className="text-[rgb(var(--brand-700))]" />
                      {(r.budget_min_minor != null || r.budget_max_minor != null
                        ? Math.round((r.budget_max_minor ?? r.budget_min_minor ?? 0) / 100).toLocaleString()
                        : '—')}{' '}
                      {r.currency}
                    </span>
                    {r.pickup_city_name && (
                      <span className="flex items-center gap-1 text-[rgb(var(--fg-muted))]">
                        <CategoryIcon name="pin" size={13} />
                        {r.pickup_city_name}
                      </span>
                    )}
                    <span className="text-[rgb(var(--fg-muted))]">
                      {t('feed.offersCount')}: {r.offer_count}
                    </span>
                    {r.published_at && (
                      <span className="text-[rgb(var(--fg-subtle))]">
                        {new Date(r.published_at).toLocaleDateString(locale)}
                      </span>
                    )}
                  </div>

                  <div className="mt-3.5">
                    <span className="btn btn-primary w-full">{t('offer.submit')}</span>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

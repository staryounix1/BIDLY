'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { offersApi, type OfferOnRequest } from '@/lib/offers-api';
import { StatusBadge } from '@/lib/status-badge';

/**
 * A provider's submitted offers and their outcomes (sprint 5).
 *
 * Accept/reject happens on the customer side; here a provider watches their
 * offers move from PENDING to ACCEPTED / REJECTED / WITHDRAWN.
 */
export default function ProviderOffersPage() {
  return (
    <RequireAuth roles={['PROVIDER', 'ADMIN']}>
      <OffersView />
    </RequireAuth>
  );
}

function OffersView() {
  const { t, locale } = useI18n();
  const [offers, setOffers] = useState<OfferOnRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await offersApi.mine({ limit: 50, status: filter || undefined });
      setOffers(data.items ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [filter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const tabs = ['', 'PENDING', 'ACCEPTED', 'REJECTED', 'WITHDRAWN'];

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('offer.myTitle')}</h1>
          <p className="mt-1 text-sm opacity-70">{t('offer.mySubtitle')}</p>
        </div>
        <Link
          href={`/${locale}/provider/requests`}
          className="rounded-lg border border-black/15 px-3 py-1.5 text-sm font-medium dark:border-white/20"
        >
          {t('feed.title')}
        </Link>
      </header>

      <div className="mb-5 flex flex-wrap gap-2 text-sm">
        {tabs.map((tab) => (
          <button
            key={tab || 'all'}
            onClick={() => setFilter(tab)}
            className={
              filter === tab
                ? 'rounded-full bg-slate-900 px-3 py-1 font-semibold text-white dark:bg-white dark:text-slate-900'
                : 'rounded-full border border-black/15 px-3 py-1 opacity-70 hover:opacity-100 dark:border-white/20'
            }
          >
            {tab ? <StatusBadge status={tab} /> : t('nav.offers')}
          </button>
        ))}
      </div>

      {error && (
        <p className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      {loading ? (
        <p className="opacity-60">{t('common.loading')}</p>
      ) : offers.length === 0 ? (
        <p className="rounded-2xl border border-black/10 px-5 py-10 text-center text-sm opacity-60 dark:border-white/15">
          {t('offer.empty')}
        </p>
      ) : (
        <ul className="space-y-3">
          {offers.map((o) => (
            <li
              key={o.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-black/10 p-4 text-sm dark:border-white/15"
            >
              <div className="min-w-0">
                <Link
                  href={`/${locale}/provider/requests/${o.request_id}`}
                  className="font-semibold hover:underline"
                >
                  {o.request_title || o.service_name || o.request_code}
                </Link>
                <p className="mt-0.5 text-xs opacity-60">
                  <span className="mono">{o.request_code}</span> · {o.service_name}
                </p>
                {o.message && <p className="mt-1 opacity-70">{o.message}</p>}
                <p className="mt-1 text-xs opacity-60">
                  {new Date(o.created_at).toLocaleDateString(locale)}
                  {o.eta_minutes != null && ` · ${t('offer.eta')}: ${o.eta_minutes} ${t('request.minutes')}`}
                </p>
              </div>
              <div className="text-end">
                <div className="text-base font-bold">
                  {(o.price_minor / 100).toFixed(2)} {o.currency}
                </div>
                <div className="mt-1">
                  <StatusBadge status={o.status} />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

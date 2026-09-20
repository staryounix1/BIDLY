'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { offersApi, type OfferOnRequest } from '@/lib/offers-api';
import { StatusBadge } from '@/lib/status-badge';
import { CategoryIcon } from '@/lib/icons';
import { EmptyState, Price, Spinner } from '@/lib/ui';

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
    <div className="app-shell container-page py-5">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{t('offer.myTitle')}</h1>
          <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('offer.mySubtitle')}</p>
        </div>
        <Link href={`/${locale}/provider/requests`} className="btn btn-secondary !py-2 !text-sm">
          {t('feed.title')}
        </Link>
      </header>

      <div className="mb-5 flex flex-wrap gap-2 text-sm">
        {tabs.map((tab) => (
          <button
            key={tab || 'all'}
            onClick={() => setFilter(tab)}
            className={filter === tab ? 'chip chip-brand' : 'chip chip-neutral'}
          >
            {tab ? <StatusBadge status={tab} /> : t('nav.offers')}
          </button>
        ))}
      </div>

      {error && (
        <div className="card mb-4 flex items-center gap-2 border-[rgb(var(--danger)/0.35)] p-3 text-sm text-[rgb(var(--danger))]">
          <CategoryIcon name="shield" size={16} />
          <span className="flex-1">{error}</span>
        </div>
      )}

      {loading ? (
        <div className="card flex items-center justify-center gap-2 px-5 py-10 text-sm text-[rgb(var(--fg-muted))]">
          <Spinner size={18} />
          {t('common.loading')}
        </div>
      ) : offers.length === 0 ? (
        <EmptyState
          title={t('offer.empty')}
          icon={<CategoryIcon name="bolt" size={26} />}
        />
      ) : (
        <ul className="space-y-3">
          {offers.map((o, i) => (
            <li
              key={o.id}
              className="card card-tap slide-in p-4 text-sm"
              style={{ animationDelay: `${i * 40}ms` }}
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/${locale}/provider/requests/${o.request_id}`}
                    className="font-bold text-[rgb(var(--fg))] hover:underline"
                  >
                    {o.request_title || o.service_name || o.request_code}
                  </Link>
                  <p className="mt-0.5 text-xs text-[rgb(var(--fg-subtle))]">
                    <span className="tnum">{o.request_code}</span> · {o.service_name}
                  </p>
                  {o.message && <p className="mt-1.5 text-[rgb(var(--fg-muted))]">{o.message}</p>}
                  <p className="mt-1.5 text-xs text-[rgb(var(--fg-subtle))]">
                    {new Date(o.created_at).toLocaleDateString(locale)}
                    {o.eta_minutes != null && ` · ${t('offer.eta')}: ${o.eta_minutes} ${t('request.minutes')}`}
                  </p>
                </div>
                <div className="flex-none text-end">
                  <Price minor={o.price_minor} currency={o.currency} size="md" />
                  <div className="mt-1.5">
                    <StatusBadge status={o.status} />
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

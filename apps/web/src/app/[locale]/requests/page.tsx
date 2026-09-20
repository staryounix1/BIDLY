'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { requestsApi, type RequestSummary } from '@/lib/requests-api';
import { StatusBadge } from '@/lib/status-badge';
import { CategoryIcon } from '@/lib/icons';
import { Price, SectionTitle, Spinner } from '@/lib/ui';

/**
 * The customer's own requests, as cards.
 *
 * The API scopes the query by the authenticated user, so this list can never
 * contain another customer's request.
 */
export default function MyRequestsPage() {
  return (
    <RequireAuth roles={['CUSTOMER']}>
      <MyRequestsView />
    </RequireAuth>
  );
}

function MyRequestsView() {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<RequestSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'all' | 'open' | 'done'>('all');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const page = await requestsApi.mine({ limit: 50 });
      setItems(page.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const OPEN = [
    'DRAFT',
    'PUBLISHED',
    'MATCHING',
    'RECEIVING_OFFERS',
    'PROVIDER_SELECTED',
    'CONFIRMED',
    'IN_PROGRESS',
  ];
  const DONE = ['COMPLETED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'FAILED', 'DISPUTED'];
  const filtered =
    tab === 'open'
      ? items.filter((r) => OPEN.includes(r.status))
      : tab === 'done'
        ? items.filter((r) => DONE.includes(r.status))
        : items;

  const tabs = [
    ['all', t('dashboard.overview')],
    ['open', t('dashboard.openRequests')],
    ['done', t('status.COMPLETED')],
  ] as const;

  return (
    <div className="app-shell container-page py-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-black tracking-tight">{t('request.myTitle')}</h1>
          <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('request.mySubtitle')}</p>
        </div>
        <Link
          href={`/${locale}/requests/new`}
          className="btn btn-primary h-11 w-11 flex-none !p-0"
          aria-label={t('nav.newRequest')}
        >
          <CategoryIcon name="plus" size={22} />
        </Link>
      </div>

      {/* Filter rail */}
      <div className="no-scrollbar -mx-4 mb-4 flex gap-2 overflow-x-auto px-4">
        {tabs.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={tab === key ? 'chip chip-brand h-9 px-4 text-sm' : 'chip chip-neutral h-9 px-4 text-sm'}
          >
            {label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex justify-center py-16">
          <Spinner size={26} />
        </div>
      )}

      {error && (
        <p className="card border-[rgb(var(--danger)/0.35)] p-4 text-sm font-semibold text-[rgb(var(--danger))]">
          {error}{' '}
          <button onClick={load} className="underline">
            {t('common.retry')}
          </button>
        </p>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="card flex flex-col items-center gap-3 px-6 py-14 text-center">
          <span className="icon-tile h-16 w-16">
            <CategoryIcon name="checklist" size={28} />
          </span>
          <p className="text-base font-bold">{t('request.empty')}</p>
          <Link href={`/${locale}/requests/new`} className="btn btn-primary">
            <CategoryIcon name="plus" size={18} />
            {t('request.createFirst')}
          </Link>
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <>
          <SectionTitle>{t('request.myTitle')}</SectionTitle>
          <ul className="space-y-2.5">
            {filtered.map((r, index) => (
              <li key={r.id}>
                <Link
                  href={`/${locale}/requests/${r.id}`}
                  className="card card-tap slide-in block p-4"
                  style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      <span className="icon-tile h-11 w-11">
                        <CategoryIcon name="checklist" size={21} />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[0.9375rem] font-bold">
                          {r.title || r.service_name}
                        </p>
                        <p className="tnum mt-0.5 truncate text-xs text-[rgb(var(--fg-subtle))]">
                          {r.code}
                          {r.pickup_city_name ? ` · ${r.pickup_city_name}` : ''}
                          {' · '}
                          {new Date(r.created_at).toLocaleDateString(locale)}
                        </p>
                      </div>
                    </div>
                    <StatusBadge status={r.status} />
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-[rgb(var(--line))] pt-3">
                    <span className="flex items-center gap-1.5 text-xs font-bold text-[rgb(var(--brand-700))]">
                      <CategoryIcon name="chat" size={14} />
                      {r.offer_count} {t('request.offer')}
                    </span>
                    {(r.budget_min_minor != null || r.budget_max_minor != null) && (
                      <Price
                        minor={r.budget_min_minor ?? r.budget_max_minor}
                        currency={r.currency}
                        size="sm"
                      />
                    )}
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

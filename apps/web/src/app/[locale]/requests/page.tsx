'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { requestsApi, type RequestSummary } from '@/lib/requests-api';
import { StatusBadge } from '@/lib/status-badge';

/**
 * The customer's own requests. The API scopes the query by the authenticated
 * user, so this list can never contain another customer's request.
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

  const OPEN = ['DRAFT', 'PUBLISHED', 'MATCHING', 'RECEIVING_OFFERS', 'PROVIDER_SELECTED', 'CONFIRMED', 'IN_PROGRESS'];
  const DONE = ['COMPLETED', 'CANCELLED', 'EXPIRED', 'REFUNDED', 'FAILED', 'DISPUTED'];
  const filtered =
    tab === 'open' ? items.filter((r) => OPEN.includes(r.status))
    : tab === 'done' ? items.filter((r) => DONE.includes(r.status))
    : items;

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t('request.myTitle')}</h1>
          <p className="mt-1 text-sm opacity-70">{t('request.mySubtitle')}</p>
        </div>
        <Link
          href={`/${locale}/requests/new`}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-slate-900"
        >
          {t('nav.newRequest')}
        </Link>
      </div>

      <div className="mt-5 flex flex-wrap gap-2 text-sm">
        {([
          ['all', t('dashboard.overview')],
          ['open', t('dashboard.openRequests')],
          ['done', t('status.COMPLETED')],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={
              tab === key
                ? 'rounded-full bg-slate-900 px-3 py-1 font-semibold text-white dark:bg-white dark:text-slate-900'
                : 'rounded-full border border-black/15 px-3 py-1 opacity-70 hover:opacity-100 dark:border-white/20'
            }
          >
            {label}
          </button>
        ))}
      </div>

      {loading && <p className="mt-6 opacity-60">{t('common.loading')}</p>}
      {error && (
        <p className="mt-6 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}{' '}
          <button onClick={load} className="underline">
            {t('common.retry')}
          </button>
        </p>
      )}

      {!loading && !error && filtered.length === 0 && (
        <div className="mt-10 rounded-2xl border border-dashed border-black/15 p-10 text-center dark:border-white/15">
          <p className="opacity-70">{t('request.empty')}</p>
          <Link href={`/${locale}/requests/new`} className="mt-3 inline-block text-sm font-medium underline">
            {t('request.createFirst')}
          </Link>
        </div>
      )}

      <ul className="mt-6 space-y-3">
        {filtered.map((r) => (
          <li key={r.id}>
            <Link
              href={`/${locale}/requests/${r.id}`}
              className="flex items-center justify-between gap-4 rounded-xl border border-black/10 p-4 transition hover:border-slate-900 dark:border-white/15 dark:hover:border-white"
            >
              <div className="min-w-0">
                <div className="truncate font-semibold">{r.title || r.service_name}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs opacity-60">
                  <span className="mono">{r.code}</span>
                  <span>{r.service_name}</span>
                  {r.pickup_city_name && <span>{r.pickup_city_name}</span>}
                  <span>
                    {t('request.createdAt')}: {new Date(r.created_at).toLocaleDateString(locale)}
                  </span>
                  {r.offer_count > 0 && (
                    <span>
                      {r.offer_count} {t('request.offer')}
                    </span>
                  )}
                </div>
              </div>
              <StatusBadge status={r.status} />
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

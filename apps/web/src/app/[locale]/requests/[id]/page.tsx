'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { requestsApi, type RequestDetail } from '@/lib/requests-api';
import { offersApi } from '@/lib/offers-api';
import { SearchRadar } from '@/lib/map/search-radar';
import { StatusBadge } from '@/lib/status-badge';

/**
 * Request detail for the owning customer.
 *
 * Ownership is enforced by the API: a non-owner gets 403 and this screen shows
 * a neutral "no access" message instead of any data. A draft request can be
 * published here (which is what starts matching) or cancelled.
 */
export default function RequestDetailPage() {
  return (
    <RequireAuth roles={['CUSTOMER']}>
      <RequestDetailView />
    </RequireAuth>
  );
}

const CANCELABLE = ['DRAFT', 'PUBLISHED', 'MATCHING', 'RECEIVING_OFFERS', 'PROVIDER_SELECTED', 'CONFIRMED', 'IN_PROGRESS'];

function RequestDetailView() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;
  const search = useSearchParams();

  const [data, setData] = useState<RequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(
    // Arriving from the create form: confirm the request was saved.
    search.get('created') === '1' ? t('request.created') : null,
  );
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await requestsApi.get(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError(t('request.forbidden'));
      else if (err instanceof ApiError && err.status === 404) setError(t('request.notFound'));
      else setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onPublish() {
    if (!data) return;
    setBusy(true);
    setNotice(null);
    try {
      const updated = await requestsApi.publish(data.request.id);
      setData({ ...data, request: { ...data.request, ...updated } });
      setNotice(t('request.published'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!data) return;
    setBusy(true);
    setNotice(null);
    try {
      const updated = await requestsApi.cancel(data.request.id, cancelReason || undefined);
      setData({ ...data, request: { ...data.request, ...updated } });
      setNotice(t('request.cancelled'));
      setShowCancel(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function onAcceptOffer(offerId: string) {
    if (!data) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await offersApi.accept(offerId);
      setNotice(`${t('offer.accepted')} (${result.jobCode})`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function onRejectOffer(offerId: string) {
    if (!data) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await offersApi.reject(offerId);
      setNotice(t('offer.rejected'));
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <main className="mx-auto max-w-3xl px-4 py-10 opacity-60">{t('common.loading')}</main>;

  if (error || !data) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error ?? t('request.notFound')}
        </p>
        <button onClick={() => router.push(`/${locale}/requests`)} className="mt-4 text-sm underline">
          ← {t('request.myTitle')}
        </button>
      </main>
    );
  }

  const { request, offers, media, answers } = data;
  const canCancel = CANCELABLE.includes(request.status);
  const canSelectOffer = ['PUBLISHED', 'MATCHING', 'RECEIVING_OFFERS', 'PROVIDER_SELECTED'].includes(request.status);
  const selectedOffer = offers.find((o) => o.id === request.selected_offer_id || o.status === 'ACCEPTED') ?? null;

  // The radar replaces the top of the page while the search is live: matching
  // is a server-side process the customer would otherwise see nothing of.
  const searching =
    !selectedOffer &&
    !request.cancelled_at &&
    ['PUBLISHED', 'MATCHING', 'RECEIVING_OFFERS'].includes(request.status);
  const requestPoint =
    request.pickup_lat != null && request.pickup_lng != null
      ? { lat: Number(request.pickup_lat), lng: Number(request.pickup_lng) }
      : null;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <button onClick={() => router.push(`/${locale}/requests`)} className="mb-4 text-sm opacity-60 hover:opacity-100">
        ← {t('request.myTitle')}
      </button>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{request.title || request.service_name}</h1>
          <p className="mt-1 text-sm opacity-60">
            <span className="mono">{request.code}</span> · {request.service_name}
          </p>
        </div>
        <StatusBadge status={request.status} />
      </div>

      {searching && (
        <div className="mt-5">
          <SearchRadar
            requestId={request.id}
            offers={offers}
            point={requestPoint}
            expiresAt={request.expires_at}
            candidateCount={offers.length}
            onViewOffers={() => {
              document.getElementById('bidly-offers')?.scrollIntoView({ behavior: 'smooth' });
            }}
            onStop={canCancel ? () => setShowCancel(true) : undefined}
          />
        </div>
      )}

      {/* Assigned provider — shown once an offer has been accepted. */}
      {selectedOffer && request.job_id && (
        <section className="mt-4 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-5">
          <h2 className="text-sm font-semibold opacity-70">{t('job.provider')}</h2>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-lg font-semibold">{selectedOffer.provider_name}</div>
              <div className="mt-0.5 text-xs opacity-70">
                {t('job.price')}: {(selectedOffer.price_minor / 100).toFixed(2)} {selectedOffer.currency}
                {selectedOffer.rating_avg != null && (
                  <> · {t('provider.rating')}: {Number(selectedOffer.rating_avg).toFixed(1)}</>
                )}
              </div>
              {selectedOffer.message && <div className="mt-1 text-sm opacity-80">{selectedOffer.message}</div>}
            </div>
            <Link
              href={`/${locale}/jobs`}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white dark:bg-white dark:text-slate-900"
            >
              {t('job.details')}
            </Link>
          </div>
        </section>
      )}

      {notice && (
        <p className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{notice}</p>
      )}

      <dl className="mt-6 grid grid-cols-2 gap-4 rounded-2xl border border-black/10 p-5 text-sm dark:border-white/15">
        <Info label={t('request.currentStatus')}>
          <StatusBadge status={request.status} />
        </Info>
        <Info label={t('request.createdAt')}>{new Date(request.created_at).toLocaleString(locale)}</Info>
        <Info label={t('request.urgency')}>{t(`urgency.${request.urgency}`)}</Info>
        <Info label={t('request.offersCount')}>{request.offer_count}</Info>
        {(request.budget_min_minor != null || request.budget_max_minor != null) && (
          <Info label={t('request.budget')}>
            {request.budget_min_minor != null ? (request.budget_min_minor / 100).toFixed(0) : '—'} –{' '}
            {request.budget_max_minor != null ? (request.budget_max_minor / 100).toFixed(0) : '—'} {request.currency}
          </Info>
        )}
        {request.pickup_line1 && (
          <Info label={t('request.pickup')}>
            {[request.pickup_line1, request.pickup_district, request.pickup_city_name].filter(Boolean).join(', ')}
          </Info>
        )}
        {request.destination_line1 && (
          <Info label={t('request.destination')}>
            {[request.destination_line1, request.destination_city_name].filter(Boolean).join(', ')}
          </Info>
        )}
      </dl>

      {request.description && (
        <section className="mt-5">
          <h2 className="text-sm font-semibold opacity-70">{t('request.description')}</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm">{request.description}</p>
        </section>
      )}

      {answers.length > 0 && (
        <section className="mt-5 space-y-2">
          {answers.map((a) => (
            <div key={a.id} className="rounded-lg border border-black/10 px-3 py-2 text-sm dark:border-white/15">
              <div className="text-xs opacity-60">{a.field_key}</div>
              <div>{formatAnswer(a)}</div>
            </div>
          ))}
        </section>
      )}

      {media.length > 0 && (
        <section className="mt-5">
          <h2 className="text-sm font-semibold opacity-70">{t('request.detailsTitle')}</h2>
          <div className="mt-2 flex flex-wrap gap-2">
            {media.map((m) => (
              <a key={m.id} href={m.url} target="_blank" rel="noreferrer" className="text-xs underline">
                {m.kind}
              </a>
            ))}
          </div>
        </section>
      )}

      <section id="bidly-offers" className="mt-8">
        <h2 className="font-semibold">{t('request.offers')}</h2>
        {offers.length === 0 ? (
          <p className="mt-2 text-sm opacity-60">{t('request.noOffers')}</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {[...offers]
              .sort((a, b) => {
                // Pending offers first, cheapest first — the natural comparison order.
                const rank = (s: string) => (s === 'PENDING' ? 0 : s === 'ACCEPTED' ? 1 : 2);
                if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
                return a.price_minor - b.price_minor;
              })
              .map((o, idx, arr) => {
                const pending = arr.filter((x) => x.status === 'PENDING');
                const isBest = pending.length > 1 && pending[0]?.id === o.id;
                return (
                  <li
                    key={o.id}
                    className={
                      'rounded-xl border p-4 text-sm ' +
                      (o.status === 'ACCEPTED'
                        ? 'border-emerald-500/40 bg-emerald-500/5 dark:border-emerald-500/40'
                        : 'border-black/10 dark:border-white/15')
                    }
                  >
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{o.provider_name}</span>
                          {isBest && (
                            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">
                              {t('offer.bestPrice')} ★
                            </span>
                          )}
                        </div>
                        {o.rating_avg != null && (
                          <div className="text-xs opacity-60">
                            ★ {Number(o.rating_avg).toFixed(1)}
                            {o.completed_jobs != null ? ` · ${t('provider.completedJobs')}: ${o.completed_jobs}` : ''}
                          </div>
                        )}
                        {o.message && <div className="mt-1 opacity-70">{o.message}</div>}
                        {o.eta_minutes != null && (
                          <div className="mt-0.5 text-xs opacity-60">
                            {t('request.eta')}: {o.eta_minutes} {t('request.minutes')}
                          </div>
                        )}
                      </div>
                      <div className="text-end">
                        <div className="text-base font-bold">
                          {(o.price_minor / 100).toFixed(2)} {o.currency}
                        </div>
                        <div className="mt-1">
                          <StatusBadge status={o.status} />
                        </div>
                      </div>
                    </div>

                    {o.status === 'PENDING' && canSelectOffer && (
                      <div className="mt-3 flex flex-wrap gap-2 border-t border-black/10 pt-3 dark:border-white/10">
                        <button
                          onClick={() => onAcceptOffer(o.id)}
                          disabled={busy}
                          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                        >
                          {t('offer.accept')}
                        </button>
                        <button
                          onClick={() => onRejectOffer(o.id)}
                          disabled={busy}
                          className="rounded-lg border border-black/15 px-4 py-2 text-sm font-medium disabled:opacity-50 dark:border-white/20"
                        >
                          {t('offer.reject')}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
          </ul>
        )}
      </section>

      <div className="mt-8 flex flex-wrap gap-3">
        {request.status === 'DRAFT' && (
          <button
            onClick={onPublish}
            disabled={busy}
            className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
          >
            {t('request.publish')}
          </button>
        )}
        {canCancel && (
          <button
            onClick={() => setShowCancel(true)}
            disabled={busy}
            className="rounded-lg border border-rose-300 px-5 py-2.5 text-sm font-medium text-rose-700 disabled:opacity-50 dark:border-rose-800 dark:text-rose-300"
          >
            {t('request.cancel')}
          </button>
        )}
      </div>

      {showCancel && (
        <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 dark:bg-slate-900">
            <h3 className="font-semibold">{t('request.cancelConfirm')}</h3>
            <input
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder={t('request.cancelReason')}
              className="mt-3 w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none dark:border-white/20"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setShowCancel(false)} className="rounded-lg px-4 py-2 text-sm">
                {t('common.close')}
              </button>
              <button
                onClick={onCancel}
                disabled={busy}
                className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {t('request.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs opacity-60">{label}</dt>
      <dd className="mt-0.5 font-medium">{children}</dd>
    </div>
  );
}

function formatAnswer(a: RequestDetail['answers'][number]): string {
  if (a.value_text != null) return a.value_text;
  if (a.value_number != null) return String(a.value_number);
  if (a.value_boolean != null) return a.value_boolean ? '✓' : '✗';
  if (a.value_date != null) return new Date(a.value_date).toLocaleString();
  if (a.value_json != null) return JSON.stringify(a.value_json);
  return '—';
}

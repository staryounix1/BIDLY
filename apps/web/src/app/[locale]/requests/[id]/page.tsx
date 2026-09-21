'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { useAutoRefresh } from '@/lib/hooks';
import { useRealtime } from '@/lib/realtime-client';
import { requestsApi, type RequestDetail } from '@/lib/requests-api';
import { offersApi } from '@/lib/offers-api';
import { SearchRadar } from '@/lib/map/search-radar';
import { TrackProvider } from '@/lib/map/track-provider';
import { StatusBadge } from '@/lib/status-badge';
import { CategoryIcon } from '@/lib/icons';
import { Avatar, Price, SectionTitle, Spinner, Stars } from '@/lib/ui';

/**
 * Request detail for the owning customer.
 *
 * Once the request is live this is the offers screen: one card per craftsman,
 * entering as offers arrive, with the price large enough to compare without
 * reading, and accept/decline where the thumb already is. The live radar stays
 * on top while the search is open, and becomes the tracking map once a
 * craftsman is chosen.
 *
 * Ownership is enforced by the API: a non-owner gets 403 and this screen shows
 * a neutral message instead of any data.
 */
export default function RequestDetailPage() {
  return (
    <RequireAuth roles={['CUSTOMER']}>
      <RequestDetailView />
    </RequireAuth>
  );
}

const CANCELABLE = [
  'DRAFT',
  'PUBLISHED',
  'MATCHING',
  'RECEIVING_OFFERS',
  'PROVIDER_SELECTED',
  'CONFIRMED',
  'IN_PROGRESS',
];

/**
 * Statuses whose screen should keep refreshing on its own.
 *
 * DRAFT is included on purpose: a draft is exactly the state that turns into a
 * live search (the customer publishes, or an admin does), and the screen has to
 * follow that transition without a manual reload. Terminal states are excluded
 * because nothing more will change.
 */
const LIVE_STATUSES = [
  'DRAFT',
  'PUBLISHED',
  'MATCHING',
  'RECEIVING_OFFERS',
  'PROVIDER_SELECTED',
  'CONFIRMED',
  'IN_PROGRESS',
];

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
    search.get('created') === '1' ? t('request.created') : null,
  );
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showDetails, setShowDetails] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      setData(await requestsApi.get(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setError(t('request.forbidden'));
      else if (err instanceof ApiError && err.status === 404) setError(t('request.notFound'));
      else setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep the screen current while the server works in the background: offers
  // arrive over SSE without a reload, and the slow poll covers a dropped stream.
  const [liveBump, setLiveBump] = useState(0);
  const status = data?.request.status;
  const { connected: liveConnected } = useRealtime(
    { requestId: id },
    { onEvent: (env) => {
        if (env.event === 'offer:created' || env.event === 'offer:updated'
          || env.event === 'request:updated' || env.event === 'job:status') {
          setLiveBump((n) => n + 1);
        }
      } },
  );
  const refresh = useCallback(() => load(true), [load]);
  useAutoRefresh(refresh, {
    enabled: Boolean(data) && status !== undefined && LIVE_STATUSES.includes(status),
    // SSE cannot be trusted through a buffering proxy, so the poll carries the
    // screen: fast while offers are landing, relaxed once a provider is chosen.
    intervalMs: status === 'PUBLISHED' || status === 'MATCHING' || status === 'RECEIVING_OFFERS'
      ? 5_000
      : status === 'DRAFT'
        ? 8_000
        : 30_000,
    bump: liveBump,
  });

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

  /**
   * The sheet's price steppers adjust the customer's offer while the search
   * runs, so a request can be made more attractive without cancelling it.
   */
  async function onChangePrice(nextMinor: number) {
    if (!data || busy) return;
    setBusy(true);
    setError(null);
    try {
      await requestsApi.update(data.request.id, {
        budgetMinMinor: nextMinor,
        budgetMaxMinor: nextMinor,
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="app-shell container-page flex items-center justify-center py-24">
        <Spinner size={28} />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="app-shell container-page py-8">
        <p className="card border-[rgb(var(--danger)/0.35)] p-4 text-sm font-semibold text-[rgb(var(--danger))]">
          {error ?? t('request.notFound')}
        </p>
        <button onClick={() => router.push(`/${locale}/requests`)} className="btn btn-secondary mt-4">
          <CategoryIcon name="chevron" size={16} className="rotate-180 rtl:rotate-0" />
          {t('request.myTitle')}
        </button>
      </div>
    );
  }
  const { request, offers, media, answers } = data;
  const canCancel = CANCELABLE.includes(request.status);
  const canSelectOffer = [
    'PUBLISHED',
    'MATCHING',
    'RECEIVING_OFFERS',
    'PROVIDER_SELECTED',
  ].includes(request.status);
  const selectedOffer =
    offers.find((o) => o.id === request.selected_offer_id || o.status === 'ACCEPTED') ?? null;

  /**
   * A draft is the same screen before the search starts: the map, the price and
   * the customer's own request, waiting on one tap to publish. Keeping the two
   * states on one layout means creating a request and waiting for craftsmen
   * read as one continuous flow instead of two different pages.
   */
  const isDraft = request.status === 'DRAFT';
  const searching =
    !selectedOffer &&
    !request.cancelled_at &&
    (isDraft || ['PUBLISHED', 'MATCHING', 'RECEIVING_OFFERS'].includes(request.status));

  const requestPoint =
    request.pickup_lat != null && request.pickup_lng != null
      ? { lat: Number(request.pickup_lat), lng: Number(request.pickup_lng) }
      : null;

  const pending = offers.filter((o) => o.status === 'PENDING');
  const cheapestId = pending.length > 1 ? pending.reduce((a, b) => (a.price_minor <= b.price_minor ? a : b)).id : null;

  const sortedOffers = [...offers].sort((a, b) => {
    const rank = (s: string) => (s === 'PENDING' ? 0 : s === 'ACCEPTED' ? 1 : 2);
    if (rank(a.status) !== rank(b.status)) return rank(a.status) - rank(b.status);
    return a.price_minor - b.price_minor;
  });

  // The searching state is its own full-screen instrument: the map owns the
  // viewport and the panel floats over it. Returning early keeps it out of the
  // document flow below (offers list, details, actions), which would otherwise
  // scroll behind the fixed stage.
  if (searching) {
    return (
      <>
        <SearchRadar
          requestId={request.id}
          offers={offers}
          point={requestPoint}
          expiresAt={request.expires_at}
          candidateCount={offers.length}
          connected={liveConnected}
          priceMinor={request.budget_max_minor ?? request.budget_min_minor ?? null}
          currency={request.currency}
          pickupLabel={shortPlace(request)}
          draft={isDraft}
          notice={notice}
          busy={busy}
          onPublish={onPublish}
          onViewOffers={() => router.push(`/${locale}/requests`)}
          onStop={canCancel ? () => setShowCancel(true) : undefined}
          onPriceChange={onChangePrice}
        />

        {showCancel && (
          <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
            <div className="sheet sheet-up w-full max-w-sm p-5 sm:rounded-2xl">
              <div className="sheet-handle sm:hidden" />
              <h3 className="mt-3 font-bold sm:mt-0">{t('request.cancelConfirm')}</h3>
              <input
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder={t('request.cancelReason')}
                className="input mt-3"
              />
              <div className="mt-4 flex gap-2">
                <button onClick={() => setShowCancel(false)} className="btn btn-secondary flex-1">
                  {t('common.close')}
                </button>
                <button onClick={onCancel} disabled={busy} className="btn btn-danger flex-1">
                  {t('request.cancel')}
                </button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="app-shell container-page py-4">
      {/* Compact header: what, where, status. */}
      <button
        onClick={() => router.push(`/${locale}/requests`)}
        className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-[rgb(var(--fg-muted))]"
      >
        <CategoryIcon name="chevron" size={16} className="rotate-180 rtl:rotate-0" />
        {t('request.myTitle')}
      </button>

      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-black tracking-tight">
            {request.title || request.service_name}
          </h1>
          <p className="tnum mt-0.5 text-xs text-[rgb(var(--fg-subtle))]">
            {request.code} · {request.service_name}
          </p>
        </div>
        <StatusBadge status={request.status} />
      </div>

      {/* Chosen craftsman: tracking map. */}
      {selectedOffer && request.job_id && (
        <div className="mb-4 space-y-3">
          {selectedOffer.provider_id && (
            <TrackProvider
              providerId={selectedOffer.provider_id}
              destination={requestPoint}
              providerName={selectedOffer.provider_name}
              height={220}
            />
          )}

          <div className="card card-featured p-4">
            <div className="flex items-center gap-3">
              <Avatar name={selectedOffer.provider_name} src={selectedOffer.provider_avatar} size={52} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-bold">{selectedOffer.provider_name}</p>
                <Stars value={selectedOffer.rating_avg} count={selectedOffer.completed_jobs} />
              </div>
              <Price minor={selectedOffer.price_minor} currency={selectedOffer.currency} size="md" />
            </div>

            {selectedOffer.message && (
              <p className="mt-3 rounded-xl bg-[rgb(var(--surface-3))] px-3 py-2 text-sm">
                {selectedOffer.message}
              </p>
            )}

            <div className="mt-3 flex gap-2">
              <Link href={`/${locale}/messages`} className="btn btn-primary flex-1">
                <CategoryIcon name="chat" size={18} />
                {t('tracking.message')}
              </Link>
              <Link href={`/${locale}/jobs`} className="btn btn-secondary flex-1">
                {t('job.details')}
              </Link>
            </div>
          </div>
        </div>
      )}

      {notice && (
        <p className="mb-4 rounded-xl border border-[rgb(var(--ok)/0.35)] bg-[rgb(var(--ok)/0.08)] px-4 py-3 text-sm font-semibold text-[rgb(5_150_105)]">
          {notice}
        </p>
      )}
      {error && (
        <p className="mb-4 rounded-xl border border-[rgb(var(--danger)/0.35)] bg-[rgb(var(--danger)/0.08)] px-4 py-3 text-sm font-semibold text-[rgb(var(--danger))]">
          {error}
        </p>
      )}

      {/* Offers: the main event. */}
      <section id="khdemli-offers" className="mt-2">
        <SectionTitle
          action={
            pending.length > 0 ? (
              <span className="chip chip-brand">{t('offers.newOffers')} {pending.length}</span>
            ) : undefined
          }
        >
          {t('offers.title')}
        </SectionTitle>

        {offers.length === 0 ? (
          <div className="card flex flex-col items-center gap-2 px-6 py-12 text-center">
            <span className="icon-tile h-14 w-14">
              <CategoryIcon name="radar" size={26} />
            </span>
            <p className="text-base font-bold">{t('offers.empty')}</p>
            <p className="text-sm text-[rgb(var(--fg-muted))]">{t('offers.emptyHint')}</p>
          </div>
        ) : (
          <ul className="space-y-2.5">
            {sortedOffers.map((o, index) => {
              const accepted = o.status === 'ACCEPTED';
              const isBest = o.id === cheapestId;
              return (
                <li
                  key={o.id}
                  className={`card slide-in p-4 ${accepted || isBest ? 'card-featured' : ''}`}
                  style={{ animationDelay: `${Math.min(index, 10) * 55}ms` }}
                >
                  <div className="flex items-start gap-3">
                    <Avatar name={o.provider_name} src={o.provider_avatar} size={48} />

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate text-[0.9375rem] font-bold">{o.provider_name}</span>
                        {isBest && (
                          <span className="chip chip-brand !px-2 !py-0.5 !text-[0.6875rem]">
                            {t('offer.bestPrice')}
                          </span>
                        )}
                        {accepted && (
                          <span className="chip chip-ok !px-2 !py-0.5 !text-[0.6875rem]">
                            <CategoryIcon name="check" size={12} />
                            {t('offer.accepted')}
                          </span>
                        )}
                      </div>

                      <div className="mt-1 flex items-center gap-2">
                        <Stars value={o.rating_avg} count={o.completed_jobs} />
                        {o.eta_minutes != null && (
                          <span className="text-xs text-[rgb(var(--fg-muted))]">
                            · {o.eta_minutes} {t('request.minutes')}
                          </span>
                        )}
                      </div>

                      {o.message && (
                        <p className="mt-2 line-clamp-2 text-sm text-[rgb(var(--fg-muted))]">
                          {o.message}
                        </p>
                      )}
                    </div>

                    <div className="flex-none text-end">
                      <Price minor={o.price_minor} currency={o.currency} size="lg" />
                    </div>
                  </div>

                  {o.status === 'PENDING' && canSelectOffer && (
                    <div className="mt-3.5 flex gap-2">
                      <button
                        onClick={() => onAcceptOffer(o.id)}
                        disabled={busy}
                        className="btn btn-primary flex-1"
                      >
                        <CategoryIcon name="check" size={18} />
                        {t('offers.accept')}
                      </button>
                      <button
                        onClick={() => onRejectOffer(o.id)}
                        disabled={busy}
                        className="btn btn-secondary flex-1"
                      >
                        {t('offers.decline')}
                      </button>
                    </div>
                  )}

                  {o.status !== 'PENDING' && (
                    <div className="mt-3">
                      <StatusBadge status={o.status} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Request facts, collapsed by default so the offers own the screen. */}
      <button
        type="button"
        onClick={() => setShowDetails((v) => !v)}
        className="card mt-5 flex w-full items-center justify-between p-4 text-start"
      >
        <span className="text-sm font-bold">{t('request.detailsTitle')}</span>
        <CategoryIcon
          name="chevron"
          size={20}
          className={`text-[rgb(var(--fg-subtle))] transition-transform rtl:rotate-180 ${showDetails ? 'rotate-90 rtl:-rotate-90' : ''}`}
        />
      </button>

      {showDetails && (
        <div className="fade-rise mt-2 space-y-3">
          <dl className="card grid grid-cols-2 gap-4 p-4 text-sm">
            <Info label={t('request.currentStatus')}>
              <StatusBadge status={request.status} />
            </Info>
            <Info label={t('request.createdAt')}>
              {new Date(request.created_at).toLocaleString(locale)}
            </Info>
            <Info label={t('request.urgency')}>{t(`urgency.${request.urgency}`)}</Info>
            <Info label={t('request.offersCount')}>{request.offer_count}</Info>
            {(request.budget_min_minor != null || request.budget_max_minor != null) && (
              <Info label={t('request.budget')}>
                <Price
                  minor={request.budget_min_minor ?? request.budget_max_minor}
                  currency={request.currency}
                  size="sm"
                />
              </Info>
            )}
            {request.pickup_line1 && (
              <Info label={t('request.pickup')}>
                {[request.pickup_line1, request.pickup_district, request.pickup_city_name]
                  .filter(Boolean)
                  .join(', ')}
              </Info>
            )}
            {request.destination_line1 && (
              <Info label={t('request.destination')}>
                {[request.destination_line1, request.destination_city_name].filter(Boolean).join(', ')}
              </Info>
            )}
          </dl>

          {request.description && (
            <div className="card p-4">
              <h2 className="label">{t('request.description')}</h2>
              <p className="whitespace-pre-wrap text-sm">{request.description}</p>
            </div>
          )}

          {answers.length > 0 && (
            <div className="card space-y-2 p-4">
              {answers.map((a) => (
                <div key={a.id} className="rounded-xl bg-[rgb(var(--surface-3))] px-3 py-2 text-sm">
                  <div className="text-xs font-semibold text-[rgb(var(--fg-subtle))]">{a.field_key}</div>
                  <div>{formatAnswer(a)}</div>
                </div>
              ))}
            </div>
          )}

          {media.length > 0 && (
            <div className="card p-4">
              <h2 className="label">{t('request.detailsTitle')}</h2>
              <div className="mt-2 flex flex-wrap gap-2">
                {media.map((m) => (
                  <a
                    key={m.id}
                    href={m.url}
                    target="_blank"
                    rel="noreferrer"
                    className="chip chip-neutral"
                  >
                    {m.kind}
                  </a>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Actions. */}
      <div className="mt-5 space-y-2.5">
        {request.status === 'DRAFT' && (
          <button onClick={onPublish} disabled={busy} className="btn btn-primary btn-block">
            {t('request.publish')}
          </button>
        )}
        {canCancel && (
          <button onClick={() => setShowCancel(true)} disabled={busy} className="btn btn-secondary btn-block !text-[rgb(var(--danger))]">
            {t('request.cancel')}
          </button>
        )}
      </div>

      {showCancel && (
        <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
          <div className="sheet sheet-up w-full max-w-sm p-5 sm:rounded-2xl">
            <div className="sheet-handle sm:hidden" />
            <h3 className="mt-3 font-bold sm:mt-0">{t('request.cancelConfirm')}</h3>
            <input
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              placeholder={t('request.cancelReason')}
              className="input mt-3"
            />
            <div className="mt-4 flex gap-2">
              <button onClick={() => setShowCancel(false)} className="btn btn-secondary flex-1">
                {t('common.close')}
              </button>
              <button onClick={onCancel} disabled={busy} className="btn btn-danger flex-1">
                {t('request.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * A short, human label for the request point.
 *
 * `pickup_line1` holds whatever Nominatim returned, which is often a full
 * postal string ("Zankat Sidi Soussane, Sidi Youb, المدينة, مقاطعة مراكش …").
 * That fills the sheet and tells the customer nothing new, so keep the street
 * and the district only and let the map carry the rest.
 */
function shortPlace(request: RequestDetail['request']): string | null {
  const parts = [request.pickup_line1, request.pickup_district, request.pickup_city_name]
    .filter((p): p is string => Boolean(p && p.trim()))
    .map((p) => p.trim());

  if (parts.length === 0) {
    // No reverse-geocoded text: the coordinates are still a usable label.
    if (request.pickup_lat != null && request.pickup_lng != null) {
      return `${Number(request.pickup_lat).toFixed(4)}, ${Number(request.pickup_lng).toFixed(4)}`;
    }
    return null;
  }

  // A geocode line is a comma-separated chain; the first two links are the
  // street and the neighbourhood, which is what a person recognises.
  const street = parts[0] ?? '';
  const firstSegment = street.split(',').map((s) => s.trim()).filter(Boolean);
  const head = firstSegment[0] ?? street;
  const next = firstSegment[1] ?? parts[1];
  if (!head) return null;
  return next && next !== head ? `${head}، ${next}` : head;
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[rgb(var(--fg-subtle))]">{label}</dt>
      <dd className="mt-0.5 font-semibold">{children}</dd>
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

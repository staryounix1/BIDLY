'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { requestsApi, type RequestDetail } from '@/lib/requests-api';
import { offersApi, type OfferOnRequest } from '@/lib/offers-api';
import { StatusBadge } from '@/lib/status-badge';

/**
 * Provider view of a single request, with the offer form (sprint 5).
 *
 * The provider sees the request once they are eligible (server-checked). If
 * they already have a pending offer it is shown with a withdraw action instead
 * of a second submit box, matching the API's one-active-offer rule.
 */
export default function ProviderRequestPage() {
  return (
    <RequireAuth roles={['PROVIDER', 'ADMIN']}>
      <ProviderRequestView />
    </RequireAuth>
  );
}

function ProviderRequestView() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [data, setData] = useState<RequestDetail | null>(null);
  const [myOffer, setMyOffer] = useState<OfferOnRequest | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const [price, setPrice] = useState('');
  const [message, setMessage] = useState('');
  const [eta, setEta] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail = await requestsApi.get(id);
      setData(detail);
      const mine = await offersApi.mine({ limit: 100 });
      setMyOffer(mine.items.find((o) => o.request_id === id && o.status === 'PENDING') ?? null);
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

  async function onSubmitOffer() {
    const priceMinor = Math.round(Number(price) * 100);
    if (!Number.isFinite(priceMinor) || priceMinor <= 0) {
      setError(t('offer.invalidPrice'));
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await offersApi.create({
        requestId: id,
        priceMinor,
        message: message.trim() || undefined,
        etaMinutes: eta.trim() ? Number(eta) : undefined,
      });
      setMyOffer({ ...created, request_code: data?.request.code, request_title: data?.request.title });
      setNotice(t('offer.submitted'));
      setPrice('');
      setMessage('');
      setEta('');
    } catch (err) {
      // A duplicate submission is rejected by the API with 409; refresh so the
      // provider sees the offer that already exists instead of a blank form.
      if (err instanceof ApiError && err.status === 409) {
        setNotice(t('offer.alreadyOffered'));
        await load();
      } else {
        setError(err instanceof ApiError ? err.message : t('common.error'));
      }
    } finally {
      setBusy(false);
    }
  }

  async function onWithdraw() {
    if (!myOffer) return;
    setBusy(true);
    setError(null);
    try {
      await offersApi.withdraw(myOffer.id);
      setMyOffer(null);
      setNotice(t('offer.withdrawn'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <main className="mx-auto max-w-3xl px-4 py-10 opacity-60">{t('common.loading')}</main>;
  }

  if (error && !data) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p className="rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
        <button onClick={() => router.push(`/${locale}/provider/requests`)} className="mt-4 text-sm underline">
          ← {t('feed.title')}
        </button>
      </main>
    );
  }

  if (!data) return null;
  const { request } = data;

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <button
        onClick={() => router.push(`/${locale}/provider/requests`)}
        className="mb-4 text-sm opacity-60 hover:opacity-100"
      >
        ← {t('feed.title')}
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

      {notice && (
        <p className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {error && (
        <p className="mt-4 rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}

      <dl className="mt-6 grid grid-cols-2 gap-4 rounded-2xl border border-black/10 p-5 text-sm dark:border-white/15 sm:grid-cols-3">
        <Info label={t('request.budget')}>
          {request.budget_min_minor != null || request.budget_max_minor != null
            ? `${request.budget_min_minor != null ? (request.budget_min_minor / 100).toFixed(0) : '—'} – ${
                request.budget_max_minor != null ? (request.budget_max_minor / 100).toFixed(0) : '—'
              } ${request.currency}`
            : '—'}
        </Info>
        <Info label={t('request.urgency')}>{t(`urgency.${request.urgency}`)}</Info>
        <Info label={t('request.offersCount')}>{request.offer_count}</Info>
        {request.pickup_line1 && (
          <Info label={t('request.pickup')}>
            {[request.pickup_line1, request.pickup_city_name].filter(Boolean).join(', ')}
          </Info>
        )}
        {request.destination_line1 && (
          <Info label={t('providerReq.destination')}>
            {[request.destination_line1, request.destination_city_name].filter(Boolean).join(', ')}
          </Info>
        )}
        {request.scheduled_at && (
          <Info label={t('providerReq.scheduled')}>
            {new Date(request.scheduled_at).toLocaleString(locale)}
          </Info>
        )}
        {request.item_count != null && (
          <Info label={t('providerReq.itemCount')}>{request.item_count}</Info>
        )}
        {request.requires_helper && <Info label={t('providerReq.requiresHelper')}>{t('common.yes')}</Info>}
      </dl>

      {data.answers.length > 0 && (
        <section className="mt-5 rounded-2xl border border-black/10 p-5 dark:border-white/15">
          <h2 className="text-sm font-semibold opacity-70">{t('providerReq.questionAnswers')}</h2>
          <dl className="mt-3 grid gap-3 sm:grid-cols-2">
            {data.answers.map((a) => (
              <div key={a.id}>
                <dt className="text-xs opacity-60">{a.field_key}</dt>
                <dd className="mt-0.5 text-sm font-medium">
                  {a.value_text ??
                    (a.value_number != null ? String(a.value_number) : null) ??
                    (a.value_boolean != null ? (a.value_boolean ? t('common.yes') : t('common.no')) : null) ??
                    (a.value_date ? new Date(a.value_date).toLocaleDateString(locale) : null) ??
                    (a.value_json != null ? JSON.stringify(a.value_json) : '—')}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {request.description && (
        <section className="mt-5">
          <h2 className="text-sm font-semibold opacity-70">{t('request.description')}</h2>
          <p className="mt-1 whitespace-pre-wrap text-sm">{request.description}</p>
        </section>
      )}

      <section className="mt-8 rounded-2xl border border-black/10 p-5 dark:border-white/15">
        <h2 className="font-semibold">{myOffer ? t('offer.details') : t('offer.newOffer')}</h2>

        {myOffer ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm">
            <div>
              <div className="font-bold">
                {(myOffer.price_minor / 100).toFixed(2)} {myOffer.currency}
              </div>
              {myOffer.message && <div className="mt-0.5 opacity-70">{myOffer.message}</div>}
              {myOffer.eta_minutes != null && (
                <div className="text-xs opacity-60">
                  {t('offer.eta')}: {myOffer.eta_minutes} {t('request.minutes')}
                </div>
              )}
            </div>
            <div className="flex items-center gap-3">
              <StatusBadge status={myOffer.status} />
              <button
                onClick={onWithdraw}
                disabled={busy}
                className="rounded-lg border border-rose-300 px-4 py-2 text-sm font-medium text-rose-700 disabled:opacity-50 dark:border-rose-800 dark:text-rose-300"
              >
                {t('offer.withdraw')}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <label className="block text-sm">
              <span className="opacity-70">{t('offer.priceLabel')}</span>
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  className="w-40 rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-slate-900 dark:border-white/20 dark:focus:border-white"
                />
                <span className="text-sm opacity-60">{request.currency}</span>
              </div>
            </label>

            <label className="block text-sm">
              <span className="opacity-70">{t('offer.etaLabel')}</span>
              <input
                type="number"
                min="0"
                value={eta}
                onChange={(e) => setEta(e.target.value)}
                className="mt-1 w-40 rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-slate-900 dark:border-white/20 dark:focus:border-white"
              />
            </label>

            <label className="block text-sm">
              <span className="opacity-70">{t('offer.messageLabel')}</span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                className="mt-1 w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-slate-900 dark:border-white/20 dark:focus:border-white"
              />
            </label>

            <button
              onClick={onSubmitOffer}
              disabled={busy}
              className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
            >
              {busy ? t('offer.submitting') : t('offer.submit')}
            </button>
          </div>
        )}
      </section>
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

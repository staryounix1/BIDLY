'use client';

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { requestsApi, type RequestDetail } from '@/lib/requests-api';
import { offersApi, type OfferOnRequest } from '@/lib/offers-api';
import { StatusBadge } from '@/lib/status-badge';
import { CategoryIcon } from '@/lib/icons';
import { Price, PriceStepper, SectionTitle, Spinner } from '@/lib/ui';

/**
 * Provider view of a single request, with the counter-offer composer.
 *
 * This is the provider's "set your fare" screen: the customer's budget is
 * stated up top, and the provider's own number is the loudest control. If a
 * pending offer already exists it replaces the form with a withdraw action,
 * matching the API's one-active-offer rule.
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

  const [price, setPrice] = useState(0);
  const [message, setMessage] = useState('');
  const [eta, setEta] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail = await requestsApi.get(id);
      setData(detail);
      // Seed the stepper from the customer's own budget band so the provider
      // starts from a real number rather than zero.
      const seed =
        detail.request.budget_min_minor ??
        detail.request.budget_max_minor ??
        10000;
      setPrice(Math.max(1, Math.round(seed / 100)));
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
    const priceMinor = Math.round(price * 100);
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
      setMessage('');
      setEta('');
    } catch (err) {
      // A duplicate submission is rejected with 409; refresh so the provider
      // sees the offer that already exists instead of a blank form.
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
    return (
      <div className="app-shell container-page flex items-center justify-center py-24">
        <Spinner size={28} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="app-shell container-page py-8">
        <p className="card border-[rgb(var(--danger)/0.35)] p-4 text-sm font-semibold text-[rgb(var(--danger))]">
          {error}
        </p>
        <button
          onClick={() => router.push(`/${locale}/provider/requests`)}
          className="btn btn-secondary mt-4"
        >
          <CategoryIcon name="chevron" size={16} className="rotate-180 rtl:rotate-0" />
          {t('feed.title')}
        </button>
      </div>
    );
  }

  if (!data) return null;
  const { request } = data;
  const budgetMinor = request.budget_min_minor ?? request.budget_max_minor;

  return (
    <div className="app-shell container-page py-4">
      <button
        onClick={() => router.push(`/${locale}/provider/requests`)}
        className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-[rgb(var(--fg-muted))]"
      >
        <CategoryIcon name="chevron" size={16} className="rotate-180 rtl:rotate-0" />
        {t('feed.title')}
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

      {/* Customer's budget leads — the provider is pricing against it. */}
      {budgetMinor != null && (
        <div className="card card-featured mb-4 flex items-center justify-between gap-3 p-4">
          <span>
            <span className="block text-xs font-bold text-[rgb(var(--fg-muted))]">
              {t('request.budget')}
            </span>
            <span className="mt-0.5 block text-base font-black">
              {t('offer.customerOffer')}
            </span>
          </span>
          <Price minor={budgetMinor} currency={request.currency} size="xl" />
        </div>
      )}

      {notice == null && (
        <div className="card mb-4 divide-y divide-[rgb(var(--line))]">
          <Info label={t('request.urgency')}>
            <span className="chip chip-neutral">{t(`urgency.${request.urgency}`)}</span>
          </Info>
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
            <Info label={t('providerReq.itemCount')}>{String(request.item_count)}</Info>
          )}
          <Info label={t('request.offersCount')}>{String(request.offer_count)}</Info>
        </div>
      )}

      {data.answers.length > 0 && (
        <div className="card mb-4 p-4">
          <h2 className="label">{t('providerReq.questionAnswers')}</h2>
          <dl className="mt-2 grid gap-3 sm:grid-cols-2">
            {data.answers.map((a) => (
              <div key={a.id}>
                <dt className="text-xs text-[rgb(var(--fg-subtle))]">{a.field_key}</dt>
                <dd className="mt-0.5 text-sm font-semibold">
                  {a.value_text ??
                    (a.value_number != null ? String(a.value_number) : null) ??
                    (a.value_boolean != null ? (a.value_boolean ? t('common.yes') : t('common.no')) : null) ??
                    (a.value_date ? new Date(a.value_date).toLocaleDateString(locale) : null) ??
                    (a.value_json != null ? JSON.stringify(a.value_json) : '—')}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {request.description && (
        <div className="card mb-4 p-4">
          <h2 className="label">{t('request.description')}</h2>
          <p className="whitespace-pre-wrap text-sm">{request.description}</p>
        </div>
      )}

      {/* Counter-offer composer. */}
      <SectionTitle>{myOffer ? t('offer.details') : t('offer.newOffer')}</SectionTitle>

      {myOffer ? (
        <div className="card card-featured p-4">
          <div className="flex items-center justify-between gap-3">
            <Price minor={myOffer.price_minor} currency={myOffer.currency} size="xl" />
            <StatusBadge status={myOffer.status} />
          </div>
          {myOffer.message && (
            <p className="mt-3 rounded-xl bg-[rgb(var(--surface-3))] px-3 py-2 text-sm">
              {myOffer.message}
            </p>
          )}
          {myOffer.eta_minutes != null && (
            <p className="mt-2 text-xs text-[rgb(var(--fg-muted))]">
              {t('offer.eta')}: {myOffer.eta_minutes} {t('request.minutes')}
            </p>
          )}
          <button onClick={onWithdraw} disabled={busy} className="btn btn-secondary btn-block mt-3.5 !text-[rgb(var(--danger))]">
            {t('offer.withdraw')}
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="card p-4">
            <PriceStepper
              value={price}
              onChange={setPrice}
              step={10}
              min={1}
              currency={request.currency}
              label={t('offer.priceLabel')}
            />
            <p className="mt-2 text-center text-xs text-[rgb(var(--fg-subtle))]">{t('compose.priceHint')}</p>
          </div>

          <div className="card p-4">
            <label className="block">
              <span className="label">{t('offer.etaLabel')}</span>
              <input
                type="number"
                min="0"
                inputMode="numeric"
                value={eta}
                onChange={(e) => setEta(e.target.value)}
                className="input"
              />
            </label>

            <label className="mt-3 block">
              <span className="label">{t('offer.messageLabel')}</span>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={3}
                className="input min-h-[76px] resize-none"
              />
            </label>
          </div>

          <button onClick={onSubmitOffer} disabled={busy || price <= 0} className="btn btn-primary btn-block">
            {busy ? (
              <>
                <Spinner size={18} />
                {t('offer.submitting')}
              </>
            ) : (
              <>
                <CategoryIcon name="arrow" size={19} className="rtl:rotate-180" />
                {t('offer.submit')}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}

function Info({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 p-3.5">
      <span className="text-xs font-semibold text-[rgb(var(--fg-muted))]">{label}</span>
      <span className="text-end text-sm font-bold">{children}</span>
    </div>
  );
}

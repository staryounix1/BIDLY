'use client';

import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { useAuth } from '@/lib/auth-provider';
import { ApiError } from '@/lib/auth-api';
import { paymentsApi, formatMinor, type LedgerEntry, type Payout, type TopUpPackage, type TopUpRequest, type Wallet } from '@/lib/payments-api';
import { CategoryIcon } from '@/lib/icons';
import { EmptyState, SectionTitle, Spinner } from '@/lib/ui';

/**
 * Wallet and payments.
 *
 * Every signed-in account owns a balance — a customer tops up to pay for work,
 * a provider collects earnings — so all roles may open this page. Only a
 * provider can *withdraw*, because a payout needs a provider entity, so the
 * request form is shown for that role alone and the balance is read-only for
 * everyone else.
 */
export default function WalletPage() {
  return (
    <RequireAuth>
      <WalletView />
    </RequireAuth>
  );
}

function WalletView() {
  const { t, locale } = useI18n();
  const { user } = useAuth();
  const isProvider = user?.role === 'PROVIDER';
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('BANK_TRANSFER');
  const [busy, setBusy] = useState(false);
  const [packages, setPackages] = useState<TopUpPackage[]>([]);
  const [topUps, setTopUps] = useState<TopUpRequest[]>([]);
  const [selectedPackage, setSelectedPackage] = useState<string | null>(null);
  const [topUpAmount, setTopUpAmount] = useState('');
  const [topUpMethod, setTopUpMethod] = useState('BANK_TRANSFER');
  const [topUpRef, setTopUpRef] = useState('');
  const [topUpBusy, setTopUpBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [w, l, p] = await Promise.all([
        paymentsApi.myWallet(),
        paymentsApi.myLedger({ limit: 50 }),
        paymentsApi.myPayouts(),
      ]);
      setWallet(w);
      setLedger(l ?? []);
      setPayouts(p ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Top-ups are requests, not charges: money is credited only once an operator
   * confirms it was received. Loading the catalogue and my own requests is
   * therefore part of drawing the card, not of submitting it.
   */
  useEffect(() => {
    if (!isProvider) return;
    let alive = true;
    (async () => {
      try {
        const [pk, ru] = await Promise.all([
          paymentsApi.topUpPackages(),
          paymentsApi.myTopUpRequests(),
        ]);
        if (!alive) return;
        setPackages(pk ?? []);
        setTopUps(ru ?? []);
      } catch {
        // The card degrades to the free-amount form; no need to scare the user.
      }
    })();
    return () => { alive = false; };
  }, [isProvider, wallet?.available_minor]);

  const openTopUp = topUps.find((r) => r.status === 'PENDING') ?? null;
  const chosenPack = packages.find((p) => p.id === selectedPackage) ?? null;
  const packLabel = (p: TopUpPackage) =>
    (locale === 'ar' ? p.label_ar : locale === 'fr' ? p.label_fr : p.label_en) || p.code;

  async function onTopUp(e: React.FormEvent) {
    e.preventDefault();
    setTopUpBusy(true);
    setNotice(null);
    setError(null);
    try {
      if (chosenPack) {
        await paymentsApi.requestTopUp({
          packageId: chosenPack.id,
          method: topUpMethod,
          reference: topUpRef || undefined,
        });
      } else {
        const amountMinor = Math.round(Number(topUpAmount) * 100);
        if (!Number.isFinite(amountMinor) || amountMinor < 1000) throw new Error(t('payment.topUpAmount'));
        await paymentsApi.requestTopUp({
          amountMinor,
          method: topUpMethod,
          reference: topUpRef || undefined,
        });
      }
      setNotice(t('payment.topUpRequested'));
      setTopUpAmount('');
      setTopUpRef('');
      setSelectedPackage(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : t('common.error'));
    } finally {
      setTopUpBusy(false);
    }
  }

  async function onCancelTopUp(id: string) {
    setTopUpBusy(true);
    setError(null);
    try {
      await paymentsApi.cancelTopUpRequest(id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setTopUpBusy(false);
    }
  }

  async function onRequestPayout(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      const amountMinor = Math.round(Number(amount) * 100);
      if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error(t('payment.payoutAmount'));
      await paymentsApi.requestPayout({ amountMinor, method });
      setNotice(t('payment.payoutRequested'));
      setAmount('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell container-page py-5">
      <h1 className="mb-5 text-2xl font-extrabold tracking-tight">{t('payment.title')}</h1>

      {error && (
        <div className="card mb-4 flex items-center gap-2 border-[rgb(var(--danger)/0.35)] p-3 text-sm text-[rgb(var(--danger))]">
          <CategoryIcon name="shield" size={16} />
          <span className="flex-1">{error}</span>
        </div>
      )}
      {notice && (
        <div className="card mb-4 flex items-center gap-2 border-[rgb(var(--ok)/0.35)] p-3 text-sm text-[rgb(var(--ok))]">
          <CategoryIcon name="check" size={16} />
          <span className="flex-1">{notice}</span>
        </div>
      )}

      {loading ? (
        <div className="card flex items-center justify-center gap-2 px-5 py-10 text-sm text-[rgb(var(--fg-muted))]">
          <Spinner size={18} />
          {t('common.loading')}
        </div>
      ) : (
        <>
          <section className="mb-6 grid grid-cols-2 gap-3">
            <Stat label={t('payment.availableBalance')} value={formatMinor(wallet?.available_minor ?? 0, wallet?.currency, locale)} accent />
            <Stat label={t('payment.reservedBalance')} value={formatMinor(wallet?.reserved_minor ?? 0, wallet?.currency, locale)} />
            <Stat label={t('payment.lifetimeIn')} value={formatMinor(wallet?.lifetime_in_minor ?? 0, wallet?.currency, locale)} />
            <Stat label={t('payment.lifetimeOut')} value={formatMinor(wallet?.lifetime_out_minor ?? 0, wallet?.currency, locale)} />
          </section>

          {/*
            Providers only. A craftsman settles the platform commission from
            this balance when a deal is agreed, so an empty wallet blocks his
            first agreement and nothing else can fund it. Customers never see
            this: a customer's money reaches a provider through the job payment.
          */}
          {isProvider && (
            <section className="card card-featured mb-6 p-5">
              <SectionTitle>{t('payment.topUp')}</SectionTitle>
              <p className="mb-3 text-sm text-[rgb(var(--fg-muted))]">{t('payment.topUpHint')}</p>

              {openTopUp ? (
                /*
                  One request at a time: while it waits, the form is replaced by
                  the request's own status so nobody files a duplicate. The admin
                  queue approves against this exact row.
                */
                <div className="rounded-xl border border-[rgb(var(--line))] bg-[rgb(var(--surface-2))] p-4">
                  <div className="flex items-center justify-between gap-3">
                    <span className="chip chip-pending">{t('payment.topUpPending')}</span>
                    <span className="tnum font-black">
                      {formatMinor(openTopUp.credit_minor, openTopUp.currency, locale)}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-[rgb(var(--fg-muted))]">
                    {t('payment.topUpRequestedOn')}{' '}
                    {new Date(openTopUp.created_at).toLocaleDateString(locale)}
                    {openTopUp.method ? ` · ${openTopUp.method}` : ''}
                  </p>
                  <button
                    type="button" disabled={topUpBusy}
                    onClick={() => void onCancelTopUp(openTopUp.id)}
                    className="btn btn-ghost mt-3"
                  >
                    {t('payment.topUpCancel')}
                  </button>
                </div>
              ) : (
                <form onSubmit={onTopUp} className="space-y-3">
                  {packages.length > 0 && (
                    <div className="grid gap-2 sm:grid-cols-3">
                      {packages.map((p) => {
                        const active = selectedPackage === p.id;
                        return (
                          <button
                            key={p.id}
                            type="button"
                            onClick={() => {
                              setSelectedPackage(active ? null : p.id);
                              setTopUpAmount('');
                            }}
                            className={`relative rounded-xl border p-3 text-start transition ${
                              active
                                ? 'border-[rgb(var(--brand))] bg-[rgb(var(--brand)/0.08)]'
                                : 'border-[rgb(var(--line))] hover:border-[rgb(var(--brand)/0.5)]'
                            }`}
                          >
                            {p.bonus_minor > 0 && (
                              <span className="absolute end-2 top-2 chip chip-ok text-[0.625rem]">
                                +{formatMinor(p.bonus_minor, p.currency, locale)}
                              </span>
                            )}
                            <p className="text-xs font-semibold text-[rgb(var(--fg-muted))]">{packLabel(p)}</p>
                            <p className="tnum mt-1 text-lg font-black">
                              {formatMinor(p.pay_minor, p.currency, locale)}
                            </p>
                            <p className="tnum text-xs text-[rgb(var(--ok))]">
                              → {formatMinor(p.credit_minor, p.currency, locale)}
                            </p>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {!chosenPack && (
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="block">
                        <span className="label">{t('payment.topUpAmount')}</span>
                        <input
                          type="number" min="10" step="0.01" value={topUpAmount}
                          onChange={(e) => setTopUpAmount(e.target.value)}
                          className="input tnum w-40"
                          placeholder="100"
                        />
                      </label>
                      <div className="flex flex-wrap gap-2 pb-2">
                        {[50, 100, 200, 500].map((v) => (
                          <button
                            key={v} type="button"
                            className="chip chip-neutral tnum"
                            onClick={() => setTopUpAmount(String(v))}
                          >
                            +{v}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex flex-wrap items-end gap-3">
                    <label className="block">
                      <span className="label">{t('payment.method')}</span>
                      <select
                        value={topUpMethod} onChange={(e) => setTopUpMethod(e.target.value)}
                        className="input w-auto"
                      >
                        <option value="BANK_TRANSFER">BANK_TRANSFER</option>
                        <option value="CASH">CASH</option>
                        <option value="CARD">CARD</option>
                      </select>
                    </label>
                    <label className="block flex-1 min-w-[10rem]">
                      <span className="label">{t('payment.topUpReference')}</span>
                      <input
                        type="text" value={topUpRef} maxLength={100}
                        onChange={(e) => setTopUpRef(e.target.value)}
                        className="input"
                        placeholder={t('payment.topUpReferenceHint')}
                      />
                    </label>
                    <button type="submit" disabled={topUpBusy} className="btn btn-primary">
                      {topUpBusy ? <Spinner size={18} /> : <CategoryIcon name="wallet" size={18} />}
                      {topUpBusy ? t('payment.paying') : t('payment.topUpSubmit')}
                    </button>
                  </div>
                  <p className="text-xs text-[rgb(var(--fg-subtle))]">{t('payment.topUpApprovalNote')}</p>
                </form>
              )}

              {topUps.length > 0 && (
                <div className="mt-4 border-t border-[rgb(var(--line))] pt-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[rgb(var(--fg-subtle))]">
                    {t('payment.topUpHistory')}
                  </p>
                  <ul className="space-y-1.5">
                    {topUps.map((r) => (
                      <li key={r.id} className="flex items-center justify-between gap-3 text-sm">
                        <span className="tnum font-bold">
                          {formatMinor(r.credit_minor, r.currency, locale)}
                        </span>
                        <span className="text-xs text-[rgb(var(--fg-subtle))]">
                          {new Date(r.created_at).toLocaleDateString(locale)}
                        </span>
                        <span className={r.status === 'COMPLETED' ? 'chip chip-ok' : r.status === 'PENDING' ? 'chip chip-pending' : 'chip chip-neutral'}>
                          {t(`payment.topUpStatus.${r.status}`)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {isProvider && (
            <section className="card mb-6 p-5">
              <SectionTitle>{t('payment.requestPayout')}</SectionTitle>
              <form onSubmit={onRequestPayout} className="flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className="label">{t('payment.payoutAmount')}</span>
                  <input
                    type="number" min="1" step="0.01" required value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="input tnum w-40"
                  />
                </label>
                <label className="block">
                  <span className="label">{t('payment.payoutMethod')}</span>
                  <select
                    value={method} onChange={(e) => setMethod(e.target.value)}
                    className="input w-auto"
                  >
                    <option value="BANK_TRANSFER">BANK_TRANSFER</option>
                    <option value="CASH">CASH</option>
                    <option value="WALLET">WALLET</option>
                  </select>
                </label>
                <button type="submit" disabled={busy} className="btn btn-primary">
                  {busy ? <Spinner size={18} /> : <CategoryIcon name="wallet" size={18} />}
                  {busy ? t('payment.paying') : t('payment.requestPayout')}
                </button>
              </form>
            </section>
          )}

          <section className="mb-6">
            <SectionTitle>{t('payment.ledger')}</SectionTitle>
            {ledger.length === 0 ? (
              <EmptyState title={t('payment.noLedger')} icon={<CategoryIcon name="wallet" size={26} />} />
            ) : (
              <div className="card overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[rgb(var(--surface-3))] text-start">
                    <tr>
                      <th className="px-4 py-2.5 text-start font-semibold text-[rgb(var(--fg-muted))]">{t('payment.method')}</th>
                      <th className="px-4 py-2.5 text-start font-semibold text-[rgb(var(--fg-muted))]">{t('payment.amount')}</th>
                      <th className="px-4 py-2.5 text-start font-semibold text-[rgb(var(--fg-muted))]">{t('payment.availableBalance')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((e) => (
                      <tr key={e.id} className="border-t border-[rgb(var(--line))]">
                        <td className="px-4 py-2.5">{e.description ?? e.type}</td>
                        <td className={`tnum px-4 py-2.5 font-bold ${e.direction === 'CREDIT' ? 'text-[rgb(var(--ok))]' : 'text-[rgb(var(--danger))]'}`}>
                          {e.direction === 'CREDIT' ? '+' : '−'}{formatMinor(e.amount_minor, e.currency, locale)}
                        </td>
                        <td className="tnum px-4 py-2.5 text-[rgb(var(--fg-muted))]">{formatMinor(e.balance_after_minor, e.currency, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <SectionTitle>{t('payment.payouts')}</SectionTitle>
            {payouts.length === 0 ? (
              <EmptyState title={t('payment.noPayouts')} icon={<CategoryIcon name="wallet" size={26} />} />
            ) : (
              <ul className="space-y-2">
                {payouts.map((p) => (
                  <li key={p.id} className="card flex items-center justify-between gap-3 p-4 text-sm">
                    <span className="tnum font-bold">{formatMinor(p.amount_minor, p.currency, locale)}</span>
                    <span className="text-[rgb(var(--fg-muted))]">{p.method}</span>
                    <span className="chip chip-neutral">{p.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`card p-4 ${accent ? 'card-featured' : ''}`}>
      <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[rgb(var(--fg-subtle))]">{label}</p>
      <p className="tnum mt-1 text-lg font-black">{value}</p>
    </div>
  );
}

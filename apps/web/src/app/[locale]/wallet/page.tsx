'use client';

import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { useAuth } from '@/lib/auth-provider';
import { ApiError } from '@/lib/auth-api';
import { paymentsApi, formatMinor, type LedgerEntry, type Payout, type Wallet } from '@/lib/payments-api';
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
  const [topUpAmount, setTopUpAmount] = useState('');
  const [topUpMethod, setTopUpMethod] = useState('CARD');
  const [topUpBusy, setTopUpBusy] = useState(false);

  /**
   * A stable key per top-up attempt, regenerated only after a credit lands, so
   * a double tap or a retry on a flaky connection cannot credit twice.
   */
  const [topUpKeyState, setTopUpKeyState] = useState(
    () => `topup-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

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

  async function onTopUp(e: React.FormEvent) {
    e.preventDefault();
    setTopUpBusy(true);
    setNotice(null);
    setError(null);
    try {
      const amountMinor = Math.round(Number(topUpAmount) * 100);
      if (!Number.isFinite(amountMinor) || amountMinor <= 0) throw new Error(t('payment.topUpAmount'));
      await paymentsApi.topUpWallet({
        amountMinor,
        method: topUpMethod,
        idempotencyKey: topUpKeyState,
      });
      setNotice(t('payment.topUpDone'));
      setTopUpAmount('');
      // Fresh key: the next top-up is a genuinely new charge.
      setTopUpKeyState(`topup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : t('common.error'));
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
              <form onSubmit={onTopUp} className="flex flex-wrap items-end gap-3">
                <label className="block">
                  <span className="label">{t('payment.topUpAmount')}</span>
                  <input
                    type="number" min="10" step="0.01" required value={topUpAmount}
                    onChange={(e) => setTopUpAmount(e.target.value)}
                    className="input tnum w-40"
                    placeholder="100"
                  />
                </label>
                <label className="block">
                  <span className="label">{t('payment.method')}</span>
                  <select
                    value={topUpMethod} onChange={(e) => setTopUpMethod(e.target.value)}
                    className="input w-auto"
                  >
                    <option value="CARD">CARD</option>
                    <option value="CASH">CASH</option>
                    <option value="BANK_TRANSFER">BANK_TRANSFER</option>
                  </select>
                </label>
                <button type="submit" disabled={topUpBusy} className="btn btn-primary">
                  {topUpBusy ? <Spinner size={18} /> : <CategoryIcon name="wallet" size={18} />}
                  {topUpBusy ? t('payment.paying') : t('payment.topUp')}
                </button>
              </form>
              <div className="mt-3 flex flex-wrap gap-2">
                {[50, 100, 200, 500].map((v) => (
                  <button
                    key={v}
                    type="button"
                    className="chip chip-neutral tnum"
                    onClick={() => setTopUpAmount(String(v))}
                  >
                    +{v}
                  </button>
                ))}
              </div>
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

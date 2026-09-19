'use client';

import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { paymentsApi, formatMinor, type LedgerEntry, type Payout, type Wallet } from '@/lib/payments-api';

/**
 * Provider wallet.
 *
 * The balance is the ledger's running total: available is spendable, reserved
 * is committed to a pending payout. Actions here only request a payout; moving
 * money is always the server's decision, so the UI never edits a balance.
 */
export default function WalletPage() {
  return (
    <RequireAuth roles={['PROVIDER', 'ADMIN']}>
      <WalletView />
    </RequireAuth>
  );
}

function WalletView() {
  const { t, locale } = useI18n();
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('BANK_TRANSFER');
  const [busy, setBusy] = useState(false);

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
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-black tracking-tight">{t('payment.title')}</h1>

      {error && <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/50">{error}</p>}
      {notice && <p className="mb-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700 dark:bg-emerald-950/50">{notice}</p>}

      {loading ? (
        <p className="opacity-60">…</p>
      ) : (
        <>
          <section className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t('payment.availableBalance')} value={formatMinor(wallet?.available_minor ?? 0, wallet?.currency, locale)} accent />
            <Stat label={t('payment.reservedBalance')} value={formatMinor(wallet?.reserved_minor ?? 0, wallet?.currency, locale)} />
            <Stat label={t('payment.lifetimeIn')} value={formatMinor(wallet?.lifetime_in_minor ?? 0, wallet?.currency, locale)} />
            <Stat label={t('payment.lifetimeOut')} value={formatMinor(wallet?.lifetime_out_minor ?? 0, wallet?.currency, locale)} />
          </section>

          <section className="mb-8 rounded-2xl border border-black/10 p-5 dark:border-white/10">
            <h2 className="mb-4 text-lg font-bold">{t('payment.requestPayout')}</h2>
            <form onSubmit={onRequestPayout} className="flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-1 text-sm">
                <span className="opacity-70">{t('payment.payoutAmount')}</span>
                <input
                  type="number" min="1" step="0.01" required value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-40 rounded-lg border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="opacity-70">{t('payment.payoutMethod')}</span>
                <select
                  value={method} onChange={(e) => setMethod(e.target.value)}
                  className="rounded-lg border border-black/15 bg-transparent px-3 py-2 dark:border-white/20"
                >
                  <option value="BANK_TRANSFER">BANK_TRANSFER</option>
                  <option value="CASH">CASH</option>
                  <option value="WALLET">WALLET</option>
                </select>
              </label>
              <button
                type="submit" disabled={busy}
                className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50 dark:bg-white dark:text-slate-900"
              >
                {busy ? t('payment.paying') : t('payment.requestPayout')}
              </button>
            </form>
          </section>

          <section className="mb-8">
            <h2 className="mb-3 text-lg font-bold">{t('payment.ledger')}</h2>
            {ledger.length === 0 ? (
              <p className="opacity-60">{t('payment.noLedger')}</p>
            ) : (
              <div className="overflow-x-auto rounded-2xl border border-black/10 dark:border-white/10">
                <table className="w-full text-sm">
                  <thead className="bg-black/5 text-left dark:bg-white/5">
                    <tr>
                      <th className="px-4 py-2">{t('payment.method')}</th>
                      <th className="px-4 py-2">{t('payment.amount')}</th>
                      <th className="px-4 py-2">{t('payment.availableBalance')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((e) => (
                      <tr key={e.id} className="border-t border-black/5 dark:border-white/5">
                        <td className="px-4 py-2">{e.description ?? e.type}</td>
                        <td className={`px-4 py-2 font-medium ${e.direction === 'CREDIT' ? 'text-emerald-600' : 'text-red-600'}`}>
                          {e.direction === 'CREDIT' ? '+' : '−'}{formatMinor(e.amount_minor, e.currency, locale)}
                        </td>
                        <td className="px-4 py-2 opacity-70">{formatMinor(e.balance_after_minor, e.currency, locale)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h2 className="mb-3 text-lg font-bold">{t('payment.payouts')}</h2>
            {payouts.length === 0 ? (
              <p className="opacity-60">{t('payment.noPayouts')}</p>
            ) : (
              <ul className="space-y-2">
                {payouts.map((p) => (
                  <li key={p.id} className="flex items-center justify-between rounded-xl border border-black/10 px-4 py-3 text-sm dark:border-white/10">
                    <span className="font-medium">{formatMinor(p.amount_minor, p.currency, locale)}</span>
                    <span className="opacity-70">{p.method}</span>
                    <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">{p.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${accent ? 'border-emerald-500/40 bg-emerald-50/60 dark:bg-emerald-950/20' : 'border-black/10 dark:border-white/10'}`}>
      <p className="text-xs uppercase tracking-wide opacity-60">{label}</p>
      <p className="mt-1 text-xl font-black">{value}</p>
    </div>
  );
}

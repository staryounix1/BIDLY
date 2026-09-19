'use client';

import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import {
  adminApi,
  type AdminAuditEntry,
  type AdminPayment,
  type AdminPayout,
  type AdminRequest,
  type AdminStats,
  type AdminTransaction,
  type AdminWallet,
  type PendingProvider,
} from '@/lib/admin-api';
import { formatMinor } from '@/lib/payments-api';
import { StatusBadge } from '@/lib/status-badge';

/**
 * Admin console.
 *
 * Read-first: the overview and money views are the daily drivers. Mutating
 * actions (verify a provider, settle a payout, adjust a wallet) are explicit,
 * reason-bearing, and recorded in the append-only audit log by the server.
 * A role that lacks a permission gets a clean denial from the API and the tab
 * simply shows the error — the UI never pretends to have authority.
 */

type Tab = 'overview' | 'payments' | 'transactions' | 'wallets' | 'payouts' | 'providers' | 'requests' | 'audit';

export default function AdminPage() {
  return (
    <RequireAuth roles={['ADMIN']}>
      <AdminView />
    </RequireAuth>
  );
}

function AdminView() {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState<Tab>('overview');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [payments, setPayments] = useState<AdminPayment[]>([]);
  const [transactions, setTransactions] = useState<AdminTransaction[]>([]);
  const [wallets, setWallets] = useState<AdminWallet[]>([]);
  const [payouts, setPayouts] = useState<AdminPayout[]>([]);
  const [providers, setProviders] = useState<PendingProvider[]>([]);
  const [requests, setRequests] = useState<AdminRequest[]>([]);
  const [audit, setAudit] = useState<AdminAuditEntry[]>([]);

  const load = useCallback(async (which: Tab) => {
    setLoading(true);
    setError(null);
    try {
      switch (which) {
        case 'overview': setStats(await adminApi.stats()); break;
        case 'payments': setPayments(await adminApi.payments()); break;
        case 'transactions': setTransactions(await adminApi.transactions()); break;
        case 'wallets': setWallets(await adminApi.wallets()); break;
        case 'payouts': setPayouts(await adminApi.payouts()); break;
        case 'providers': setProviders(await adminApi.pendingProviders()); break;
        case 'requests': setRequests(await adminApi.requests()); break;
        case 'audit': setAudit(await adminApi.auditLog()); break;
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load(tab);
  }, [tab, load]);

  async function act(fn: () => Promise<unknown>, done: string) {
    setNotice(null);
    setError(null);
    try {
      await fn();
      setNotice(done);
      await load(tab);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    }
  }

  const tabs: Tab[] = ['overview', 'payments', 'transactions', 'wallets', 'payouts', 'providers', 'requests', 'audit'];

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-black tracking-tight">{t('admin.title')}</h1>

      <nav className="mb-6 flex flex-wrap gap-2 text-sm">
        {tabs.map((x) => (
          <button
            key={x} onClick={() => setTab(x)}
            className={`rounded-full px-3 py-1.5 ${tab === x ? 'bg-slate-900 text-white dark:bg-white dark:text-slate-900' : 'border border-black/15 dark:border-white/20'}`}
          >
            {t(`admin.${x}`)}
          </button>
        ))}
      </nav>

      {error && <p className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/50">{error}</p>}
      {notice && <p className="mb-4 rounded-lg bg-emerald-50 p-3 text-sm text-emerald-700 dark:bg-emerald-950/50">{notice}</p>}

      {loading ? (
        <p className="opacity-60">…</p>
      ) : (
        <>
          {tab === 'overview' && stats && (
            <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Card label={t('admin.activeUsers')} value={String(stats.active_users)} />
              <Card label={t('admin.activeProviders')} value={String(stats.active_providers)} />
              <Card label={t('admin.requests7d')} value={String(stats.requests_7d)} />
              <Card label={t('admin.jobs7d')} value={String(stats.jobs_7d)} />
              <Card label={t('admin.openDisputes')} value={String(stats.open_disputes)} />
              <Card label={t('admin.pendingPayouts')} value={String(stats.pending_payouts)} />
              <Card label={t('admin.gmv30d')} value={formatMinor(Number(stats.gmv_30d_minor), 'MAD', locale)} />
              <Card label={t('admin.revenue30d')} value={formatMinor(Number(stats.revenue_30d_minor), 'MAD', locale)} accent />
            </section>
          )}

          {tab === 'payments' && (
            <Table head={[t('payment.amount'), t('payment.commission'), 'Status', 'Customer']}
              rows={payments.map((p) => [
                formatMinor(p.amount_minor, p.currency, locale),
                formatMinor(p.commission_minor, p.currency, locale),
                <StatusBadge key={p.id} status={p.status} />,
                p.customer_name ?? p.customer_email ?? '—',
              ])} empty={t('admin.empty')} />
          )}

          {tab === 'transactions' && (
            <Table head={['Type', 'Status', t('payment.amount')]}
              rows={transactions.map((x) => [
                x.type,
                <StatusBadge key={x.id} status={x.status} />,
                formatMinor(x.amount_minor, x.currency, locale),
              ])} empty={t('admin.empty')} />
          )}

          {tab === 'wallets' && (
            <div className="overflow-x-auto rounded-2xl border border-black/10 dark:border-white/10">
              <table className="w-full text-sm">
                <thead className="bg-black/5 text-left dark:bg-white/5">
                  <tr>
                    <th className="px-4 py-2">Owner</th>
                    <th className="px-4 py-2">{t('payment.availableBalance')}</th>
                    <th className="px-4 py-2">{t('payment.reservedBalance')}</th>
                    <th className="px-4 py-2">{t('admin.adjust')}</th>
                  </tr>
                </thead>
                <tbody>
                  {wallets.map((w) => (
                    <tr key={w.id} className="border-t border-black/5 dark:border-white/5">
                      <td className="px-4 py-2">{w.owner_name ?? w.owner_email ?? w.owner_id.slice(0, 8)}<span className="ml-2 text-xs opacity-50">{w.owner_type}</span></td>
                      <td className="px-4 py-2 font-medium">{formatMinor(w.available_minor, w.currency, locale)}</td>
                      <td className="px-4 py-2 opacity-70">{formatMinor(w.reserved_minor, w.currency, locale)}</td>
                      <td className="px-4 py-2">
                        <button
                          className="rounded-lg border border-black/15 px-2 py-1 text-xs dark:border-white/20"
                          onClick={() => {
                            const input = window.prompt(t('payment.amount') + ' (MAD)');
                            if (!input) return;
                            const amountMinor = Math.round(Number(input) * 100);
                            if (!Number.isFinite(amountMinor) || amountMinor <= 0) return;
                            const reason = window.prompt(t('admin.reason')) ?? 'Manual adjustment';
                            void act(() => adminApi.adjustWallet(w.id, { direction: 'CREDIT', amountMinor, reason }), t('admin.adjust'));
                          }}
                        >
                          + {t('admin.credit')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'payouts' && (
            <div className="space-y-2">
              {payouts.length === 0 && <p className="opacity-60">{t('admin.empty')}</p>}
              {payouts.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/10 px-4 py-3 text-sm dark:border-white/10">
                  <span className="font-medium">{formatMinor(p.amount_minor, p.currency, locale)}</span>
                  <span className="opacity-70">{p.provider_name ?? p.provider_email}</span>
                  <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">{p.status}</span>
                  {p.status === 'REQUESTED' && (
                    <span className="flex gap-2">
                      <button className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white"
                        onClick={() => act(() => adminApi.processPayout(p.id, 'APPROVE'), t('admin.process'))}>
                        {t('admin.approve')}
                      </button>
                      <button className="rounded-lg border border-red-400 px-3 py-1 text-xs font-medium text-red-600"
                        onClick={() => {
                          const reason = window.prompt(t('admin.reason')) ?? 'Rejected';
                          void act(() => adminApi.processPayout(p.id, 'REJECT', reason), t('admin.process'));
                        }}>
                        {t('admin.reject')}
                      </button>
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {tab === 'providers' && (
            <div className="space-y-2">
              {providers.length === 0 && <p className="opacity-60">{t('admin.empty')}</p>}
              {providers.map((p) => (
                <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-black/10 px-4 py-3 text-sm dark:border-white/10">
                  <span className="font-medium">{p.display_name ?? p.owner_name ?? p.owner_email}</span>
                  <span className="opacity-70">{p.owner_email ?? p.owner_phone}</span>
                  <span className="rounded-full bg-black/5 px-2 py-0.5 text-xs dark:bg-white/10">{p.verification_status}</span>
                  <span className="flex gap-2">
                    <button className="rounded-lg bg-emerald-600 px-3 py-1 text-xs font-medium text-white"
                      onClick={() => act(() => adminApi.verifyProvider(p.id, 'APPROVE'), t('admin.approve'))}>
                      {t('admin.approve')}
                    </button>
                    <button className="rounded-lg border border-red-400 px-3 py-1 text-xs font-medium text-red-600"
                      onClick={() => {
                        const reason = window.prompt(t('admin.reason')) ?? 'Rejected';
                        void act(() => adminApi.verifyProvider(p.id, 'REJECT', reason), t('admin.reject'));
                      }}>
                      {t('admin.reject')}
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}

          {tab === 'requests' && (
            <Table head={['Code', 'Title', 'Status', 'Offers']}
              rows={requests.map((r) => [
                r.code,
                r.title ?? '—',
                <StatusBadge key={r.id} status={r.status} />,
                String(r.offer_count),
              ])} empty={t('admin.empty')} />
          )}

          {tab === 'audit' && (
            <Table head={['Action', 'Target', 'Admin']}
              rows={audit.map((a) => [
                a.action,
                `${a.target_type ?? ''} ${a.target_id?.slice(0, 8) ?? ''}`.trim() || '—',
                a.admin_name ?? '—',
              ])} empty={t('admin.empty')} />
          )}
        </>
      )}
    </main>
  );
}

function Card({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className={`rounded-2xl border p-4 ${accent ? 'border-emerald-500/40 bg-emerald-50/60 dark:bg-emerald-950/20' : 'border-black/10 dark:border-white/10'}`}>
      <p className="text-xs uppercase tracking-wide opacity-60">{label}</p>
      <p className="mt-1 text-xl font-black">{value}</p>
    </div>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (rows.length === 0) return <p className="opacity-60">{empty}</p>;
  return (
    <div className="overflow-x-auto rounded-2xl border border-black/10 dark:border-white/10">
      <table className="w-full text-sm">
        <thead className="bg-black/5 text-left dark:bg-white/5">
          <tr>{head.map((h) => <th key={h} className="px-4 py-2">{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-black/5 dark:border-white/5">
              {r.map((c, j) => <td key={j} className="px-4 py-2">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

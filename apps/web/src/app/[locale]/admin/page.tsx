'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
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
  type AdminTopUpRequest,
  type AdminTransaction,
  type AdminWallet,
  type PendingProvider,
} from '@/lib/admin-api';
import { formatMinor } from '@/lib/payments-api';
import { StatusBadge } from '@/lib/status-badge';
import { CategoryIcon } from '@/lib/icons';
import { EmptyState, SectionTitle, Spinner } from '@/lib/ui';

/**
 * Admin console.
 *
 * Read-first: the overview and money views are the daily drivers. Mutating
 * actions (verify a provider, settle a payout, adjust a wallet) are explicit,
 * reason-bearing, and recorded in the append-only audit log by the server.
 * A role that lacks a permission gets a clean denial from the API and the tab
 * simply shows the error — the UI never pretends to have authority.
 */

type Tab = 'overview' | 'payments' | 'transactions' | 'wallets' | 'topups' | 'payouts' | 'providers' | 'requests' | 'audit';

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
  const [topUps, setTopUps] = useState<AdminTopUpRequest[]>([]);
  const [topUpPending, setTopUpPending] = useState(0);
  const [topUpFilter, setTopUpFilter] = useState<string>('PENDING');
  const [payouts, setPayouts] = useState<AdminPayout[]>([]);
  const [providers, setProviders] = useState<PendingProvider[]>([]);
  const [requests, setRequests] = useState<AdminRequest[]>([]);
  const [audit, setAudit] = useState<AdminAuditEntry[]>([]);

  const load = useCallback(async (which: Tab, filter?: string) => {
    setLoading(true);
    setError(null);
    try {
      switch (which) {
        case 'overview': setStats(await adminApi.stats()); break;
        case 'payments': setPayments(await adminApi.payments()); break;
        case 'transactions': setTransactions(await adminApi.transactions()); break;
        case 'wallets': setWallets(await adminApi.wallets()); break;
        case 'topups': {
          const { rows, pending } = await adminApi.topUpRequests({
            status: (filter ?? topUpFilter) === 'ALL' ? undefined : (filter ?? topUpFilter),
          });
          setTopUps(rows);
          setTopUpPending(pending);
          break;
        }
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
    // topUpFilter is read but intentionally not a dependency: switching the
    // filter triggers an explicit reload so we never double-fetch on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  const tabs: Tab[] = ['overview', 'payments', 'transactions', 'wallets', 'topups', 'payouts', 'providers', 'requests', 'audit'];

  return (
    <div className="app-shell container-page py-5">
      <h1 className="mb-5 text-2xl font-extrabold tracking-tight">{t('admin.title')}</h1>

      <nav className="mb-5 flex flex-wrap gap-2 text-sm">
        {tabs.map((x) => (
          <button
            key={x} onClick={() => setTab(x)}
            className={`chip ${tab === x ? 'chip-brand' : 'chip-neutral'}`}
          >
            {t(`admin.${x}`)}
            {x === 'topups' && topUpPending > 0 && (
              <span className="ms-1 rounded-full bg-[rgb(var(--warn))] px-1.5 text-[0.625rem] font-bold text-white">
                {topUpPending}
              </span>
            )}
          </button>
        ))}
        {/* Settings lives on its own page: it is an editor, not a table view. */}
        <Link href={`/${locale}/admin/settings`} className="chip chip-neutral">
          {t('admin.settings')}
        </Link>
      </nav>

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
          {tab === 'overview' && stats && (
            <section className="grid grid-cols-2 gap-3">
              <Card label={t('admin.activeUsers')} value={String(stats.active_users)} icon="user" />
              <Card label={t('admin.activeProviders')} value={String(stats.active_providers)} icon="badge" />
              <Card label={t('admin.requests7d')} value={String(stats.requests_7d)} icon="checklist" />
              <Card label={t('admin.jobs7d')} value={String(stats.jobs_7d)} icon="wrench" />
              <Card label={t('admin.openDisputes')} value={String(stats.open_disputes)} icon="shield" />
              <Card label={t('admin.pendingPayouts')} value={String(stats.pending_payouts)} icon="wallet" />
              <Card label={t('admin.gmv30d')} value={formatMinor(Number(stats.gmv_30d_minor), 'MAD', locale)} icon="radar" />
              <Card label={t('admin.revenue30d')} value={formatMinor(Number(stats.revenue_30d_minor), 'MAD', locale)} icon="crown" accent />
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
            wallets.length === 0 ? (
              <EmptyState title={t('admin.empty')} icon={<CategoryIcon name="wallet" size={26} />} />
            ) : (
              <ul className="space-y-2">
                {wallets.map((w, index) => (
                  <li
                    key={w.id}
                    className="card card-tap slide-in p-4 text-sm"
                    style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
                  >
                    <div className="flex items-center gap-3">
                      <span className="icon-tile icon-tile-neutral h-10 w-10">
                        <CategoryIcon name="wallet" size={20} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-bold">
                          {w.owner_name ?? w.owner_email ?? w.owner_id.slice(0, 8)}
                        </p>
                        <p className="text-xs text-[rgb(var(--fg-subtle))]">{w.owner_type}</p>
                      </div>
                      <span className="chip chip-neutral">{t('admin.adjust')}</span>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <div>
                        <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[rgb(var(--fg-subtle))]">
                          {t('payment.availableBalance')}
                        </p>
                        <p className="tnum mt-0.5 font-bold">{formatMinor(w.available_minor, w.currency, locale)}</p>
                      </div>
                      <div>
                        <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[rgb(var(--fg-subtle))]">
                          {t('payment.reservedBalance')}
                        </p>
                        <p className="tnum mt-0.5 text-[rgb(var(--fg-muted))]">{formatMinor(w.reserved_minor, w.currency, locale)}</p>
                      </div>
                    </div>

                    <button
                      className="btn btn-secondary mt-3 w-full"
                      onClick={() => {
                        const input = window.prompt(t('payment.amount') + ' (MAD)');
                        if (!input) return;
                        const amountMinor = Math.round(Number(input) * 100);
                        if (!Number.isFinite(amountMinor) || amountMinor <= 0) return;
                        const reason = window.prompt(t('admin.reason')) ?? 'Manual adjustment';
                        void act(() => adminApi.adjustWallet(w.id, { direction: 'CREDIT', amountMinor, reason }), t('admin.adjust'));
                      }}
                    >
                      <CategoryIcon name="plus" size={16} />
                      {t('admin.credit')}
                    </button>
                  </li>
                ))}
              </ul>
            )
          )}

          {tab === 'topups' && (
            <div>
              {/*
                The queue spans hundreds of requests over time, so a status
                filter replaces paging: operators triage PENDING, and the other
                buckets are for lookups.
              */}
              <div className="mb-4 flex flex-wrap gap-2">
                {['PENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'ALL'].map((s) => (
                  <button
                    key={s}
                    className={`chip ${topUpFilter === s ? 'chip-brand' : 'chip-neutral'}`}
                    onClick={() => {
                      setTopUpFilter(s);
                      void load('topups', s);
                    }}
                  >
                    {s === 'ALL' ? t('admin.all') : t(`payment.topUpStatus.${s}`)}
                    {s === 'PENDING' && topUpPending > 0 ? ` (${topUpPending})` : ''}
                  </button>
                ))}
              </div>

              {topUps.length === 0 ? (
                <EmptyState title={t('admin.empty')} icon={<CategoryIcon name="wallet" size={26} />} />
              ) : (
                <ul className="space-y-2">
                  {topUps.map((r, index) => (
                    <li
                      key={r.id}
                      className="card card-tap slide-in p-4 text-sm"
                      style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="truncate font-bold">
                            {r.provider_name ?? r.user_email ?? r.user_id.slice(0, 8)}
                          </p>
                          <p className="truncate text-xs text-[rgb(var(--fg-muted))]">
                            {r.user_email}{r.user_phone ? ` · ${r.user_phone}` : ''}
                          </p>
                        </div>
                        <span className={
                          r.status === 'COMPLETED' ? 'chip chip-ok'
                            : r.status === 'PENDING' ? 'chip chip-pending'
                            : 'chip chip-neutral'
                        }>
                          {t(`payment.topUpStatus.${r.status}`)}
                        </span>
                      </div>

                      <div className="mt-3 grid grid-cols-3 gap-3">
                        <div>
                          <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[rgb(var(--fg-subtle))]">
                            {t('admin.topUpPaid')}
                          </p>
                          <p className="tnum mt-0.5 font-bold">{formatMinor(r.pay_minor, r.currency, locale)}</p>
                        </div>
                        <div>
                          <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[rgb(var(--fg-subtle))]">
                            {t('admin.topUpCredit')}
                          </p>
                          <p className="tnum mt-0.5 font-bold text-[rgb(var(--ok))]">
                            {formatMinor(r.credit_minor, r.currency, locale)}
                          </p>
                        </div>
                        <div>
                          <p className="text-[0.6875rem] font-semibold uppercase tracking-wide text-[rgb(var(--fg-subtle))]">
                            {t('payment.method')}
                          </p>
                          <p className="mt-0.5">{r.method}</p>
                        </div>
                      </div>

                      <p className="mt-2 text-xs text-[rgb(var(--fg-subtle))]">
                        {new Date(r.created_at).toLocaleString(locale)}
                        {r.reference ? ` · ${r.reference}` : ''}
                        {r.package_code ? ` · ${r.package_code}` : ''}
                      </p>

                      {r.status === 'PENDING' && (
                        <div className="mt-3 flex gap-2">
                          <button
                            className="btn btn-primary flex-1"
                            onClick={() => {
                              // Operatives often receive a different amount than
                              // was asked; the default is the requested credit
                              // but it can be corrected before it hits the ledger.
                              const input = window.prompt(
                                `${t('admin.topUpCredit')} (MAD)`,
                                String(r.credit_minor / 100),
                              );
                              if (input === null) return;
                              const creditMinor = Math.round(Number(input) * 100);
                              if (!Number.isFinite(creditMinor) || creditMinor <= 0) return;
                              const ref = window.prompt(t('admin.topUpExternalRef')) ?? undefined;
                              void act(
                                () => adminApi.processTopUpRequest(r.id, 'APPROVE', {
                                  creditMinor, externalRef: ref || undefined,
                                }),
                                t('admin.topUpApproved'),
                              );
                            }}
                          >
                            <CategoryIcon name="check" size={16} />
                            {t('admin.approve')}
                          </button>
                          <button
                            className="btn btn-danger flex-1"
                            onClick={() => {
                              const reason = window.prompt(t('admin.reason')) ?? 'Rejected';
                              void act(
                                () => adminApi.processTopUpRequest(r.id, 'REJECT', { reason }),
                                t('admin.topUpRejected'),
                              );
                            }}
                          >
                            <CategoryIcon name="x" size={16} />
                            {t('admin.reject')}
                          </button>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {tab === 'payouts' && (
            payouts.length === 0 ? (
              <EmptyState title={t('admin.empty')} icon={<CategoryIcon name="wallet" size={26} />} />
            ) : (
              <ul className="space-y-2">
                {payouts.map((p, index) => (
                  <li
                    key={p.id}
                    className="card card-tap slide-in p-4 text-sm"
                    style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="tnum text-lg font-black">{formatMinor(p.amount_minor, p.currency, locale)}</span>
                      <span className="chip chip-neutral">{p.status}</span>
                    </div>
                    <p className="mt-1 truncate text-[rgb(var(--fg-muted))]">{p.provider_name ?? p.provider_email}</p>
                    {p.status === 'REQUESTED' && (
                      <div className="mt-3 flex gap-2">
                        <button className="btn btn-primary flex-1"
                          onClick={() => act(() => adminApi.processPayout(p.id, 'APPROVE'), t('admin.process'))}>
                          <CategoryIcon name="check" size={16} />
                          {t('admin.approve')}
                        </button>
                        <button className="btn btn-danger flex-1"
                          onClick={() => {
                            const reason = window.prompt(t('admin.reason')) ?? 'Rejected';
                            void act(() => adminApi.processPayout(p.id, 'REJECT', reason), t('admin.process'));
                          }}>
                          <CategoryIcon name="x" size={16} />
                          {t('admin.reject')}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )
          )}

          {tab === 'providers' && (
            providers.length === 0 ? (
              <EmptyState title={t('admin.empty')} icon={<CategoryIcon name="badge" size={26} />} />
            ) : (
              <ul className="space-y-2">
                {providers.map((p, index) => (
                  <li
                    key={p.id}
                    className="card card-tap slide-in p-4 text-sm"
                    style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
                  >
                    <div className="flex items-center gap-3">
                      <span className="icon-tile h-10 w-10">
                        <CategoryIcon name="badge" size={20} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-bold">{p.display_name ?? p.owner_name ?? p.owner_email}</p>
                        <p className="truncate text-xs text-[rgb(var(--fg-muted))]">{p.owner_email ?? p.owner_phone}</p>
                      </div>
                      <span className="chip chip-warn">{p.verification_status}</span>
                    </div>
                    <div className="mt-3 flex gap-2">
                      <button className="btn btn-primary flex-1"
                        onClick={() => act(() => adminApi.verifyProvider(p.id, 'APPROVE'), t('admin.approve'))}>
                        <CategoryIcon name="check" size={16} />
                        {t('admin.approve')}
                      </button>
                      <button className="btn btn-danger flex-1"
                        onClick={() => {
                          const reason = window.prompt(t('admin.reason')) ?? 'Rejected';
                          void act(() => adminApi.verifyProvider(p.id, 'REJECT', reason), t('admin.reject'));
                        }}>
                        <CategoryIcon name="x" size={16} />
                        {t('admin.reject')}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )
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
    </div>
  );
}

function Card({ label, value, icon, accent }: { label: string; value: string; icon: Parameters<typeof CategoryIcon>[0]['name']; accent?: boolean }) {
  return (
    <div className={`card p-4 ${accent ? 'card-featured' : ''}`}>
      <span className={`icon-tile h-9 w-9 ${accent ? '' : 'icon-tile-neutral'}`}>
        <CategoryIcon name={icon} size={18} />
      </span>
      <p className="mt-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-[rgb(var(--fg-subtle))]">{label}</p>
      <p className="tnum mt-0.5 text-lg font-black">{value}</p>
    </div>
  );
}

function Table({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  if (rows.length === 0) {
    return <EmptyState title={empty} icon={<CategoryIcon name="doc" size={26} />} />;
  }
  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-[rgb(var(--surface-3))]">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-4 py-2.5 text-start font-semibold text-[rgb(var(--fg-muted))]">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-[rgb(var(--line))]">
              {r.map((c, j) => <td key={j} className="px-4 py-2.5">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

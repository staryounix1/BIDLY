import { api } from './auth-api';

/**
 * Admin console API.
 *
 * Mirrors the `/admin/*` endpoints: KPIs, the money views (payments,
 * transactions, wallets), the provider verification queue, requests and the
 * catalog, payouts, and the append-only audit log. Every mutating call is
 * recorded server-side in the same transaction as the change it makes.
 */

export interface AdminStats {
  active_users: number;
  active_providers: number;
  requests_7d: number;
  jobs_7d: number;
  open_disputes: number;
  pending_payouts: number;
  open_tickets: number;
  gmv_30d_minor: string;
  revenue_30d_minor: string;
}

export interface AdminPayment {
  id: string;
  job_id: string;
  status: string;
  method: string;
  amount_minor: number;
  captured_minor: number;
  refunded_minor: number;
  commission_minor: number;
  currency: string;
  provider_name: string;
  provider_ref: string | null;
  created_at: string;
  customer_name: string | null;
  customer_email: string | null;
}

export interface AdminTransaction {
  id: string;
  payment_id: string;
  job_id: string | null;
  type: string;
  status: string;
  provider_name: string;
  provider_ref: string | null;
  amount_minor: number;
  currency: string;
  error_code: string | null;
  created_at: string;
}

export interface AdminWallet {
  id: string;
  owner_type: string;
  owner_id: string;
  currency: string;
  available_minor: number;
  pending_minor: number;
  reserved_minor: number;
  is_frozen: boolean;
  owner_name: string | null;
  owner_email: string | null;
  updated_at: string;
}

export interface AdminPayout {
  id: string;
  amount_minor: number;
  currency: string;
  method: string;
  destination_masked: string | null;
  status: string;
  provider_name: string | null;
  provider_email: string | null;
  requested_at: string;
  processed_at: string | null;
}

export interface PendingProvider {
  id: string;
  display_name: string | null;
  status: string;
  verification_status: string;
  created_at: string;
  owner_name: string | null;
  owner_email: string | null;
  owner_phone: string | null;
}

export interface AdminAuditEntry {
  id: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  admin_name: string | null;
  created_at: string;
}

export interface AdminRequest {
  id: string;
  code: string;
  title: string | null;
  status: string;
  budget_min_minor: number | null;
  budget_max_minor: number | null;
  currency: string;
  created_at: string;
  customer_name: string | null;
  customer_email: string | null;
  offer_count: number;
}

function qs(params: Record<string, unknown>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

export const adminApi = {
  async stats(): Promise<AdminStats> {
    return (await api.get<AdminStats>('/admin/stats')).data;
  },
  async auditLog(page = 1): Promise<AdminAuditEntry[]> {
    return (await api.get<AdminAuditEntry[]>(`/admin/audit-log${qs({ page, limit: 50 })}`)).data;
  },
  async payments(params: { page?: number; status?: string; q?: string } = {}): Promise<AdminPayment[]> {
    return (await api.get<AdminPayment[]>(`/admin/payments${qs({ ...params, limit: 50 })}`)).data;
  },
  async paymentSummary(): Promise<Record<string, string>> {
    return (await api.get<Record<string, string>>('/admin/payments/summary')).data;
  },
  async paymentDetail(id: string): Promise<{ payment: AdminPayment; transactions: AdminTransaction[]; refunds: unknown[] }> {
    return (await api.get<{ payment: AdminPayment; transactions: AdminTransaction[]; refunds: unknown[] }>(`/admin/payments/${id}`)).data;
  },
  async transactions(params: { page?: number; type?: string; status?: string } = {}): Promise<AdminTransaction[]> {
    return (await api.get<AdminTransaction[]>(`/admin/transactions${qs({ ...params, limit: 50 })}`)).data;
  },
  async wallets(params: { page?: number; ownerType?: string } = {}): Promise<AdminWallet[]> {
    return (await api.get<AdminWallet[]>(`/admin/wallets${qs({ ...params, limit: 50 })}`)).data;
  },
  async walletLedger(id: string): Promise<{ wallet: AdminWallet; entries: unknown[] }> {
    return (await api.get<{ wallet: AdminWallet; entries: unknown[] }>(`/admin/wallets/${id}/ledger`)).data;
  },
  async adjustWallet(id: string, input: { direction: 'CREDIT' | 'DEBIT'; amountMinor: number; reason: string }) {
    return (await api.post(`/admin/wallets/${id}/adjust`, input)).data;
  },
  async pendingProviders(): Promise<PendingProvider[]> {
    return (await api.get<PendingProvider[]>('/admin/providers/pending')).data;
  },
  async verifyProvider(id: string, decision: 'APPROVE' | 'REJECT', reason?: string) {
    return (await api.post(`/admin/providers/${id}/verify`, { decision, reason })).data;
  },
  async payouts(params: { status?: string; page?: number } = {}): Promise<AdminPayout[]> {
    return (await api.get<AdminPayout[]>(`/admin/payouts${qs({ ...params, limit: 50 })}`)).data;
  },
  async processPayout(id: string, decision: 'APPROVE' | 'REJECT', reason?: string, externalRef?: string) {
    return (await api.post(`/admin/payouts/${id}/process`, { decision, reason, externalRef })).data;
  },
  async requests(params: { page?: number; status?: string; q?: string } = {}): Promise<AdminRequest[]> {
    return (await api.get<AdminRequest[]>(`/admin/requests${qs({ ...params, limit: 50 })}`)).data;
  },
  async users(params: { page?: number; q?: string; role?: string } = {}) {
    return (await api.get<Array<Record<string, unknown>>>(`/admin/users${qs({ ...params, limit: 50 })}`)).data;
  },
  async suspendUser(id: string, reason: string) {
    return (await api.post(`/admin/users/${id}/suspend`, { reason })).data;
  },
  async services(params: { q?: string } = {}) {
    return (await api.get<Array<Record<string, unknown>>>(`/admin/services${qs(params)}`)).data;
  },
  async settings() {
    return (await api.get<Array<Record<string, unknown>>>('/admin/settings')).data;
  },
  async featureFlags(): Promise<AdminFeatureFlag[]> {
    return (await api.get<AdminFeatureFlag[]>('/admin/feature-flags')).data;
  },
  async setFeatureFlag(key: string, enabled: boolean, rolloutPercent?: number) {
    const body: { enabled: boolean; rolloutPercent?: number } = { enabled };
    if (typeof rolloutPercent === 'number') body.rolloutPercent = rolloutPercent;
    return (await api.put<AdminFeatureFlag>(`/admin/feature-flags/${encodeURIComponent(key)}`, body)).data;
  },
  async updateSetting(key: string, value: unknown) {
    return (await api.put(`/admin/settings/${encodeURIComponent(key)}`, { value })).data;
  },
  async accounts(params: { page?: number; q?: string; role?: string } = {}): Promise<{ items: AdminAccount[]; meta: { total: number } }> {
    return (await api.get<{ items: AdminAccount[]; meta: { total: number } }>(`/admin/accounts${qs({ ...params, limit: 50 })}`)).data;
  },
  async setVerification(id: string, kind: VerificationKind, enabled: boolean, reason?: string) {
    return (await api.put(`/admin/accounts/${encodeURIComponent(id)}/verify/${kind}`, { enabled, reason })).data;
  },
};

/** The three checks an operator can flip from the accounts view. */
export type VerificationKind = 'EMAIL' | 'WHATSAPP' | 'IDENTITY';

/** A platform account as returned by `GET /admin/accounts`. */
export interface AdminAccount {
  id: string;
  email: string | null;
  phone: string | null;
  role: string;
  status: string;
  locale: string;
  created_at: string;
  last_login_at: string | null;
  display_name: string | null;
  provider_id: string | null;
  verification_status: string | null;
  email_verified: boolean;
  phone_verified: boolean;
  identity_verified: boolean;
  whatsapp_verified: boolean;
}

/**
 * A platform setting as returned by `GET /admin/settings`.
 *
 * `value` is whatever JSON the key holds (string, number, boolean, array or
 * object), so the settings page inspects `value_type` to pick an editor rather
 * than guessing from the runtime shape.
 */
export interface AdminSetting {
  key: string;
  value: unknown;
  value_type?: string | null;
  description?: string | null;
  group_name?: string | null;
  is_public?: boolean;
  is_editable?: boolean;
  updated_at?: string;
}

/** A switchable platform module from `GET /admin/feature-flags`. */
export interface AdminFeatureFlag {
  key: string;
  enabled: boolean;
  rollout_percent: number;
  description?: string | null;
  updated_at?: string;
}

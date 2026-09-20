'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import {
  adminApi,
  type AdminAccount,
  type AdminFeatureFlag,
  type AdminSetting,
  type VerificationKind,
} from '@/lib/admin-api';
import { CategoryIcon } from '@/lib/icons';
import { EmptyState, SectionTitle, Spinner } from '@/lib/ui';

/**
 * Admin → Settings.
 *
 * Three jobs, one page:
 *   1. Feature switches — the `feature_flags` table, one toggle per module.
 *   2. Site settings — the `settings` table grouped by `group_name`.
 *   3. Accounts — every account with its three verification checks (email,
 *      WhatsApp, identity) side by side, each one flippable in place.
 *
 * The page is deliberately a thin editor over those tables rather than a
 * bespoke form per value: the API owns the schema, so a setting added on the
 * server shows up here without a frontend change. Edits are staged locally and
 * only written on Save, so a half-typed number never reaches the database.
 */

type Tab = 'features' | 'settings' | 'accounts';

const GROUP_ORDER = [
  'features',
  'general',
  'marketplace',
  'matching',
  'payments',
  'providers',
  'security',
  'support',
  'uploads',
];

/** Settings that hold a list of values rather than a scalar. */
const LIST_TYPES = new Set(['array']);

/** Rough Arabic/French/English label for a setting key, e.g. `platform.name`. */
function humanize(key: string): string {
  const leaf = key.split('.').pop() ?? key;
  return leaf
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

/** Label for a feature flag key, e.g. `sos_requests` → `Sos requests`. */
function humanizeFlag(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());
}

export default function AdminSettingsPage() {
  return (
    <RequireAuth roles={['ADMIN']}>
      <SettingsView />
    </RequireAuth>
  );
}

function SettingsView() {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('features');

  const [flags, setFlags] = useState<AdminFeatureFlag[]>([]);
  const [settings, setSettings] = useState<AdminSetting[]>([]);
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);

  // Staged setting edits, keyed by setting key. Holding the raw string keeps
  // in-progress typing intact; it is parsed back to JSON on save.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [busyFlag, setBusyFlag] = useState<string | null>(null);
  const [busyAccount, setBusyAccount] = useState<string | null>(null);
  const [accountQuery, setAccountQuery] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [f, s, a] = await Promise.all([
        adminApi.featureFlags(),
        adminApi.settings(),
        adminApi.accounts().catch(() => ({ items: [], meta: { total: 0 } })),
      ]);
      setFlags(f);
      setSettings(s as unknown as AdminSetting[]);
      setAccounts(a.items);
      setDraft({});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Group settings for rendering, preserving a deliberate group order. */
  const grouped = useMemo(() => {
    const map = new Map<string, AdminSetting[]>();
    for (const s of settings) {
      const g = s.group_name ?? 'other';
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(s);
    }
    const keys = [...map.keys()].sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a), ib = GROUP_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    return keys.map((k) => [k, map.get(k)!.sort((x, y) => x.key.localeCompare(y.key))] as const);
  }, [settings]);

  const dirtyKeys = useMemo(
    () => Object.keys(draft).filter((k) => draft[k] !== serialize(settings.find((s) => s.key === k)?.value)),
    [draft, settings],
  );

  async function toggleFlag(flag: AdminFeatureFlag) {
    setBusyFlag(flag.key);
    setNotice(null);
    setError(null);
    // Optimistic: the switch should feel instant. Reverted below on failure.
    const next = !flag.enabled;
    setFlags((prev) => prev.map((f) => (f.key === flag.key ? { ...f, enabled: next } : f)));
    try {
      const updated = await adminApi.setFeatureFlag(flag.key, next);
      setFlags((prev) => prev.map((f) => (f.key === flag.key ? updated : f)));
      setNotice(`${humanizeFlag(flag.key)} — ${next ? t('admin.enabled') : t('admin.disabled')}`);
    } catch (err) {
      setFlags((prev) => prev.map((f) => (f.key === flag.key ? { ...f, enabled: flag.enabled } : f)));
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusyFlag(null);
    }
  }

  async function saveSetting(s: AdminSetting) {
    const raw = draft[s.key];
    if (raw === undefined) return;
    setSavingKey(s.key);
    setNotice(null);
    setError(null);
    try {
      const parsed = parseValue(raw, s.value_type ?? inferType(s.value));
      await adminApi.updateSetting(s.key, parsed);
      setSettings((prev) => prev.map((x) => (x.key === s.key ? { ...x, value: parsed } : x)));
      setDraft((prev) => {
        const next = { ...prev };
        delete next[s.key];
        return next;
      });
      setNotice(`${humanize(s.key)} — ${t('admin.saved')}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setSavingKey(null);
    }
  }

  /** The account field a given check writes to, for the local echo. */
  const accountFlagKey: Record<VerificationKind, keyof AdminAccount> = {
    EMAIL: 'email_verified',
    WHATSAPP: 'whatsapp_verified',
    IDENTITY: 'identity_verified',
  };

  async function toggleVerification(account: AdminAccount, kind: VerificationKind, next: boolean) {
    const key = accountFlagKey[kind];
    setBusyAccount(`${account.id}:${kind}`);
    setNotice(null);
    setError(null);
    // Optimistic: flipping three checks down a list should feel instant.
    setAccounts((prev) => prev.map((a) => (a.id === account.id ? { ...a, [key]: next } : a)));
    try {
      await adminApi.setVerification(account.id, kind, next);
      setNotice(`${account.email ?? account.phone ?? account.id} — ${t(
        next ? `admin.verify_${kind}_on` : `admin.verify_${kind}_off`,
      )}`);
    } catch (err) {
      setAccounts((prev) => prev.map((a) => (a.id === account.id ? { ...a, [key]: !next } : a)));
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusyAccount(null);
    }
  }

  const visibleAccounts = useMemo(() => {
    const q = accountQuery.trim().toLowerCase();
    if (!q) return accounts;
    return accounts.filter((a) =>
      [a.email, a.phone, a.display_name, a.role, a.status]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q)),
    );
  }, [accounts, accountQuery]);

  return (
    <div className="app-shell container-page py-5">
      <div className="mb-5">
        <h1 className="text-2xl font-extrabold tracking-tight">{t('admin.settings')}</h1>
        <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('admin.settingsSubtitle')}</p>
      </div>

      <div className="mb-5 flex flex-wrap gap-2">
        {(['features', 'settings', 'accounts'] as Tab[]).map((x) => (
          <button
            key={x}
            type="button"
            onClick={() => setTab(x)}
            className={`chip ${tab === x ? 'chip-brand' : 'chip-neutral'}`}
          >
            {t(`admin.tab_${x}` as never)}
            {x === 'features' ? ` (${flags.filter((f) => f.enabled).length}/${flags.length})` : ''}
            {x === 'accounts' ? ` (${accounts.length})` : ''}
          </button>
        ))}
      </div>

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
        <div className="flex flex-col gap-6">
          {tab === 'features' && (
            <FeaturesSection
              flags={flags}
              busy={busyFlag}
              onToggle={toggleFlag}
              labelForKey={humanizeFlag}
            />
          )}

          {tab === 'settings' && (
            <section>
              <SectionTitle>
                <div>
                  <h2 className="text-base font-bold">{t('admin.settingsSection')}</h2>
                  <p className="text-xs text-[rgb(var(--fg-muted))]">{t('admin.settingsHint')}</p>
                </div>
              </SectionTitle>
              <div className="flex flex-col gap-5">
                {grouped.map(([group, rows]) => (
                  <div key={group} className="card p-4">
                    <h3 className="mb-3 text-sm font-bold text-[rgb(var(--brand-500))]">
                      {t(`admin.group_${group}` as never)}
                    </h3>
                    <div className="flex flex-col gap-3">
                      {rows.map((s) => (
                        <SettingRow
                          key={s.key}
                          setting={s}
                          draft={draft[s.key]}
                          saving={savingKey === s.key}
                          dirty={dirtyKeys.includes(s.key)}
                          onEdit={(v) => setDraft((prev) => ({ ...prev, [s.key]: v }))}
                          onSave={() => saveSetting(s)}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {tab === 'accounts' && (
            <AccountsSection
              accounts={visibleAccounts}
              total={accounts.length}
              query={accountQuery}
              onQuery={setAccountQuery}
              busy={busyAccount}
              onToggle={toggleVerification}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Feature switches                                                     */
/* ------------------------------------------------------------------ */

function FeaturesSection({
  flags, busy, onToggle, labelForKey,
}: {
  flags: AdminFeatureFlag[];
  busy: string | null;
  onToggle: (f: AdminFeatureFlag) => void;
  labelForKey: (k: string) => string;
}) {
  const { t } = useI18n();
  const on = flags.filter((f) => f.enabled).length;

  return (
    <section>
      <SectionTitle>
        <div>
          <h2 className="text-base font-bold">{t('admin.featuresSection')}</h2>
          <p className="text-xs text-[rgb(var(--fg-muted))]">
            {t('admin.featuresHint')} ({on}/{flags.length})
          </p>
        </div>
      </SectionTitle>
      {flags.length === 0 ? (
        <div className="card p-4">
          <EmptyState title={t('admin.flagsLoadFailed')} />
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {flags.map((f) => (
            <div key={f.key} className="card flex items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{labelForKey(f.key)}</div>
                {f.description ? (
                  <div className="mt-0.5 line-clamp-2 text-xs text-[rgb(var(--fg-muted))]">
                    {f.description}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={f.enabled}
                aria-label={labelForKey(f.key)}
                disabled={busy === f.key}
                onClick={() => onToggle(f)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                  f.enabled ? 'bg-[rgb(var(--brand-500))]' : 'bg-[rgb(var(--line-strong))]'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                    f.enabled ? 'start-[22px]' : 'start-0.5'
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* One setting row                                                      */
/* ------------------------------------------------------------------ */

function SettingRow({
  setting, draft, saving, dirty, onEdit, onSave,
}: {
  setting: AdminSetting;
  draft: string | undefined;
  saving: boolean;
  dirty: boolean;
  onEdit: (v: string) => void;
  onSave: () => void;
}) {
  const { t } = useI18n();
  const type = setting.value_type ?? inferType(setting.value);
  const readOnly = setting.is_editable === false;
  const current = draft ?? serialize(setting.value);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <label className="min-w-0 flex-1">
        <span className="block text-xs font-semibold">{humanize(setting.key)}</span>
        <span className="block truncate text-[10px] text-[rgb(var(--fg-subtle))]" dir="ltr">
          {setting.key}
        </span>
        {setting.description ? (
          <span className="mt-1 block text-[11px] text-[rgb(var(--fg-muted))]">{setting.description}</span>
        ) : null}

        {type === 'boolean' ? (
          <select
            className="input mt-1.5"
            value={current}
            disabled={readOnly}
            onChange={(e) => onEdit(e.target.value)}
          >
            <option value="true">{t('admin.enabled')}</option>
            <option value="false">{t('admin.disabled')}</option>
          </select>
        ) : LIST_TYPES.has(type) ? (
          <textarea
            className="input mt-1.5 font-mono text-xs"
            dir="ltr"
            rows={3}
            value={listToText(current)}
            disabled={readOnly}
            placeholder={t('admin.listHint')}
            onChange={(e) => onEdit(textToList(e.target.value))}
          />
        ) : type === 'json' || type === 'object' ? (
          <textarea
            className="input mt-1.5 font-mono text-xs"
            dir="ltr"
            rows={3}
            value={current}
            disabled={readOnly}
            placeholder={t('admin.jsonHint')}
            onChange={(e) => onEdit(e.target.value)}
          />
        ) : (
          <input
            className="input mt-1.5"
            dir="ltr"
            type={type === 'number' ? 'number' : 'text'}
            value={current}
            disabled={readOnly}
            onChange={(e) => onEdit(e.target.value)}
          />
        )}
      </label>

      <div className="flex shrink-0 items-center gap-2">
        {readOnly ? (
          <span className="text-xs text-[rgb(var(--fg-subtle))]">{t('admin.readOnlyValue')}</span>
        ) : (
          <button
            type="button"
            className="btn btn-brand btn-sm"
            disabled={!dirty || saving}
            onClick={onSave}
          >
            {saving ? t('admin.saving') : dirty ? t('admin.save') : t('admin.noChanges')}
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Accounts + verification                                              */
/* ------------------------------------------------------------------ */

/** The checks shown per account, in the order operators work through them. */
const VERIFICATION_COLUMNS: { kind: VerificationKind; flag: keyof AdminAccount }[] = [
  { kind: 'EMAIL', flag: 'email_verified' },
  { kind: 'WHATSAPP', flag: 'whatsapp_verified' },
  { kind: 'IDENTITY', flag: 'identity_verified' },
];

function AccountsSection({
  accounts, total, query, onQuery, busy, onToggle,
}: {
  accounts: AdminAccount[];
  total: number;
  query: string;
  onQuery: (v: string) => void;
  busy: string | null;
  onToggle: (a: AdminAccount, kind: VerificationKind, next: boolean) => void;
}) {
  const { t } = useI18n();

  return (
    <section>
      <SectionTitle>
        <div>
          <h2 className="text-base font-bold">{t('admin.accountsSection')}</h2>
          <p className="text-xs text-[rgb(var(--fg-muted))]">
            {t('admin.accountsHint')} ({accounts.length}/{total})
          </p>
        </div>
      </SectionTitle>

      <input
        className="input mb-4"
        placeholder={t('admin.accountsSearch')}
        value={query}
        onChange={(e) => onQuery(e.target.value)}
      />

      {accounts.length === 0 ? (
        <div className="card p-4">
          <EmptyState title={t('admin.accountsEmpty')} />
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {accounts.map((a) => (
            <div key={a.id} className="card p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-bold" dir="ltr">
                  {a.display_name || a.email || a.phone || a.id}
                </span>
                <span className="chip chip-neutral text-[10px]">{a.role}</span>
                <span
                  className={`chip text-[10px] ${
                    a.status === 'ACTIVE' ? 'chip-brand' : 'chip-neutral'
                  }`}
                >
                  {a.status}
                </span>
                {a.verification_status ? (
                  <span className="chip chip-neutral text-[10px]">{a.verification_status}</span>
                ) : null}
              </div>

              <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[rgb(var(--fg-muted))]">
                {a.email ? <span dir="ltr">{a.email}</span> : null}
                {a.phone ? <span dir="ltr">{a.phone}</span> : null}
                <span dir="ltr">{new Date(a.created_at).toLocaleDateString()}</span>
              </div>

              <div className="grid gap-2 sm:grid-cols-3">
                {VERIFICATION_COLUMNS.map(({ kind, flag }) => {
                  const on = Boolean(a[flag]);
                  const key = `${a.id}:${kind}`;
                  return (
                    <button
                      key={kind}
                      type="button"
                      role="switch"
                      aria-checked={on}
                      disabled={busy === key}
                      onClick={() => onToggle(a, kind, !on)}
                      className={`flex items-center justify-between gap-2 rounded-[var(--radius)] border px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-50 ${
                        on
                          ? 'border-[rgb(var(--ok)/0.45)] bg-[rgb(var(--ok)/0.12)] text-[rgb(var(--ok))]'
                          : 'border-[rgb(var(--line-strong))] text-[rgb(var(--fg-muted))]'
                      }`}
                    >
                      <span>{t(`admin.verify_${kind}` as never)}</span>
                      <span className="text-sm">{on ? '✓' : '—'}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Value <-> string helpers                                             */
/* ------------------------------------------------------------------ */

/**
 * Render a stored JSON value as the text shown in an input.
 *
 * Strings are shown bare (a plain word reads better than `"word"`), while
 * numbers, booleans and objects keep their JSON form so they round-trip
 * through `parseValue` unchanged.
 */
function serialize(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/**
 * Turn an edited string back into the JSON the API expects.
 *
 * The target type comes from `value_type`, not from how the text happens to
 * look, so entering `123` into a string setting stores `"123"` and not `123`.
 */
function parseValue(raw: string, type: string): unknown {
  if (type === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error('not a number');
    return n;
  }
  if (type === 'boolean') return raw === 'true';
  if (type === 'json' || type === 'object') return JSON.parse(raw);
  if (LIST_TYPES.has(type)) return textToList(raw);
  return raw;
}

function inferType(value: unknown): string {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'array';
  if (value !== null && typeof value === 'object') return 'json';
  return 'string';
}

/** Arrays are edited as newline-separated text; stored back as a JSON array. */
function textToList(text: string): string {
  const items = text
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean);
  return JSON.stringify(items);
}

function listToText(current: string): string {
  try {
    const parsed = JSON.parse(current);
    if (Array.isArray(parsed)) return parsed.join('\n');
  } catch {
    // Fall through: the stored value was not an array, show it verbatim.
  }
  return current;
}

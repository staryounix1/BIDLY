'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import {
  adminApi,
  type AdminFeatureFlag,
  type AdminSetting,
} from '@/lib/admin-api';
import { CategoryIcon } from '@/lib/icons';
import { EmptyState, SectionTitle, Spinner } from '@/lib/ui';

/**
 * Admin → Settings.
 *
 * Two jobs, one page:
 *   1. Feature switches — the `feature_flags` table, one toggle per module.
 *   2. Site settings — the `settings` table grouped by `group_name`.
 *
 * The page is deliberately a thin editor over those two tables rather than a
 * bespoke form per value: the API owns the schema, so a setting added on the
 * server shows up here without a frontend change. Edits are staged locally and
 * only written on Save, so a half-typed number never reaches the database.
 */

const GROUP_ORDER = [
  'features',
  'verification',
  'general',
  'marketplace',
  'matching',
  'payments',
  'providers',
  'security',
  'support',
  'uploads',
];

/** The site-wide verification policy switches, shown as their own section. */
const VERIFICATION_KEYS = [
  'verification.email_enabled',
  'verification.whatsapp_enabled',
  'verification.identity_enabled',
] as const;

/** Label for a verification setting, e.g. `whatsapp_enabled` → the WhatsApp check. */
function settingLabel(key: string): string {
  const leaf = key.split('.').pop() ?? key;
  return leaf === 'email_enabled'
    ? 'تحقق الإيميل'
    : leaf === 'whatsapp_enabled'
      ? 'تحقق واتساب'
      : leaf === 'identity_enabled'
        ? 'تحقق الهوية'
        : humanize(key);
}

/** Settings that hold a list of values rather than a scalar. */
const LIST_TYPES = new Set(['array']);

/**
 * The page's three views, in the order the tab strip renders them.
 *
 * `verification` is its own tab rather than a band inside the features grid:
 * it is site-wide policy with one-click switches, not a feature module.
 */
type Tab = 'features' | 'verification' | 'settings';

/** Tab order, kept next to the type so the two can never drift apart. */
const TABS: Tab[] = ['features', 'verification', 'settings'];

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

  // Staged setting edits, keyed by setting key. Holding the raw string keeps
  // in-progress typing intact; it is parsed back to JSON on save.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [busyFlag, setBusyFlag] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [f, s] = await Promise.all([adminApi.featureFlags(), adminApi.settings()]);
      setFlags(f);
      setSettings(s as unknown as AdminSetting[]);
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
      // The verification policy has its own section with one-click switches.
      if ((VERIFICATION_KEYS as readonly string[]).includes(s.key)) continue;
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

  /** The three site-wide verification switches, in a fixed order. */
  const verification = useMemo(
    () =>
      VERIFICATION_KEYS.map((k) => settings.find((s) => s.key === k)).filter(
        (s): s is AdminSetting => Boolean(s),
      ),
    [settings],
  );

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

  /**
   * Flip a boolean setting with one click, without the staged draft flow.
   *
   * The verification switches are site-wide policy, not free text, so a click
   * is the whole edit. Optimistic, reverted on failure, like the feature flags.
   */
  async function toggleBooleanSetting(s: AdminSetting) {
    const next = !(s.value === true);
    setSavingKey(s.key);
    setNotice(null);
    setError(null);
    setSettings((prev) => prev.map((x) => (x.key === s.key ? { ...x, value: next } : x)));
    try {
      await adminApi.updateSetting(s.key, next);
      setNotice(`${settingLabel(s.key)} — ${next ? t('admin.enabled') : t('admin.disabled')}`);
    } catch (err) {
      setSettings((prev) => prev.map((x) => (x.key === s.key ? { ...x, value: s.value } : x)));
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setSavingKey(null);
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

  return (
    <div className="app-shell container-page py-5">
      <div className="mb-5">
        <h1 className="text-2xl font-extrabold tracking-tight">{t('admin.settings')}</h1>
        <p className="mt-1 text-sm text-[rgb(var(--fg-muted))]">{t('admin.settingsSubtitle')}</p>
      </div>

      {/* The tab counts are the same numbers the sections show, so the strip
          tells you the state of the page before you open each tab. */}
      <div className="mb-5 flex flex-wrap gap-2">
        {TABS.map((x) => {
          const count =
            x === 'features'
              ? ` (${flags.filter((f) => f.enabled).length}/${flags.length})`
              : x === 'verification'
                ? ` (${verification.filter((s) => s.value === true).length}/${verification.length})`
                : '';
          return (
            <button
              key={x}
              type="button"
              onClick={() => setTab(x)}
              className={`chip ${tab === x ? 'chip-brand' : 'chip-neutral'}`}
            >
              {t(`admin.tab_${x}` as never)}
              {count}
            </button>
          );
        })}
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

          {tab === 'verification' && (
            <VerificationSection
              settings={verification}
              busy={savingKey}
              onToggle={toggleBooleanSetting}
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
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Verification policy                                                  */
/* ------------------------------------------------------------------ */

/**
 * The site-wide verification policy, as three switches.
 *
 * These are not per-account: turning one on makes the whole platform require
 * that check. Rendering them separately from the generic settings grid keeps
 * the intent obvious — one click, no Save button.
 */
function VerificationSection({
  settings, busy, onToggle,
}: {
  settings: AdminSetting[];
  busy: string | null;
  onToggle: (s: AdminSetting) => void;
}) {
  const { t } = useI18n();
  const on = settings.filter((s) => s.value === true).length;

  return (
    <section>
      <SectionTitle>
        <div>
          <h2 className="text-base font-bold">{t('admin.verificationSection')}</h2>
          <p className="text-xs text-[rgb(var(--fg-muted))]">
            {t('admin.verificationHint')} ({on}/{settings.length})
          </p>
        </div>
      </SectionTitle>
      <div className="grid gap-3 sm:grid-cols-3">
        {settings.map((s) => {
          const enabled = s.value === true;
          return (
            <button
              key={s.key}
              type="button"
              role="switch"
              aria-checked={enabled}
              disabled={busy === s.key}
              onClick={() => onToggle(s)}
              className={`card flex items-center justify-between gap-3 p-4 text-start transition-colors disabled:opacity-50 ${
                enabled ? 'border-[rgb(var(--brand-500)/0.5)]' : ''
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">{settingLabel(s.key)}</span>
                <span
                  className={`mt-0.5 block text-xs ${
                    enabled ? 'text-[rgb(var(--brand-500))]' : 'text-[rgb(var(--fg-muted))]'
                  }`}
                >
                  {enabled ? t('admin.enabled') : t('admin.disabled')}
                </span>
              </span>
              <span
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                  enabled ? 'bg-[rgb(var(--brand-500))]' : 'bg-[rgb(var(--line-strong))]'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-all ${
                    enabled ? 'start-[22px]' : 'start-0.5'
                  }`}
                />
              </span>
            </button>
          );
        })}
      </div>
    </section>
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

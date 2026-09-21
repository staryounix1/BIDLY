'use client';

import { useCallback, useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { RequireAuth } from '@/lib/require-auth';
import { ApiError } from '@/lib/auth-api';
import { referralsApi, type MyReferrals } from '@/lib/referrals-api';
import { CategoryIcon } from '@/lib/icons';
import { Price, Spinner } from '@/lib/ui';

/**
 * Invite a friend: one code per user, rewards paid to both wallets once the
 * invited person *completes their first job*. The page is honest about that
 * condition so nobody expects instant credit.
 */
export default function ReferralsPage() {
  return (
    <RequireAuth>
      <ReferralsView />
    </RequireAuth>
  );
}

function ReferralsView() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<MyReferrals | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await referralsApi.me());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  async function claim() {
    if (code.trim().length < 4) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await referralsApi.claim(code.trim());
      setNotice(t('referral.claimed'));
      setCode('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!data?.code) return;
    try {
      await navigator.clipboard.writeText(data.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked: the code is on screen anyway */
    }
  }

  if (loading) {
    return (
      <div className="app-shell container-page flex items-center justify-center py-24">
        <Spinner size={28} />
      </div>
    );
  }

  if (!data?.enabled) {
    return (
      <div className="app-shell container-page py-8">
        <p className="card p-4 text-sm font-semibold" style={{ color: 'rgb(var(--fg-muted))' }}>
          {t('referral.disabled')}
        </p>
      </div>
    );
  }

  return (
    <div className="app-shell container-page py-6">
      <header className="mb-4">
        <h1 className="text-2xl font-extrabold">{t('referral.title')}</h1>
        <p className="mt-1 text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>{t('referral.subtitle')}</p>
      </header>

      {error && (
        <p className="card mb-4 p-3 text-sm font-semibold" style={{ color: 'rgb(var(--danger))' }}>
          {error}
        </p>
      )}
      {notice && (
        <p className="card mb-4 p-3 text-sm font-semibold" style={{ color: 'rgb(var(--ok))' }}>{notice}</p>
      )}

      <section className="card p-4">
        <h2 className="text-sm font-extrabold">{t('referral.myCode')}</h2>
        <div className="mt-3 flex items-center gap-2">
          <span className="mono flex-1 rounded-xl px-4 py-3 text-lg font-extrabold tracking-widest"
                style={{ background: 'rgb(var(--card-2))', border: '1px solid rgb(var(--line))' }}>
            {data.code ?? '—'}
          </span>
          <button onClick={() => void copy()} className="btn btn-secondary">
            {copied ? t('referral.copied') : t('referral.copy')}
          </button>
        </div>
        <p className="mt-2 text-xs" style={{ color: 'rgb(var(--fg-subtle))' }}>{t('referral.rule')}</p>

        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs font-semibold" style={{ color: 'rgb(var(--fg-subtle))' }}>
              {t('referral.youGet')}
            </div>
            <div className="mt-0.5 font-bold">
              {data.rewardMinor.referrer != null
                ? <Price minor={data.rewardMinor.referrer} size="sm" />
                : '—'}
            </div>
          </div>
          <div>
            <div className="text-xs font-semibold" style={{ color: 'rgb(var(--fg-subtle))' }}>
              {t('referral.theyGet')}
            </div>
            <div className="mt-0.5 font-bold">
              {data.rewardMinor.referee != null
                ? <Price minor={data.rewardMinor.referee} size="sm" />
                : '—'}
            </div>
          </div>
        </div>
      </section>

      <section className="card mt-4 p-4">
        <h2 className="text-sm font-extrabold">{t('referral.haveCode')}</h2>
        <div className="mt-3 flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="KHXXXXXX"
            maxLength={16}
            className="input mono flex-1 tracking-widest"
          />
          <button onClick={() => void claim()} disabled={busy || code.trim().length < 4} className="btn btn-primary">
            {busy ? <Spinner size={16} /> : <CategoryIcon name="check" size={16} />}
            {t('referral.apply')}
          </button>
        </div>
        <p className="mt-2 text-xs" style={{ color: 'rgb(var(--fg-subtle))' }}>{t('referral.claimRule')}</p>
      </section>

      <section className="card mt-4 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-extrabold">{t('referral.invited')}</h2>
          <span className="tnum text-xs" style={{ color: 'rgb(var(--fg-subtle))' }}>
            {t('referral.rewardedCount', { count: data.rewarded })}
          </span>
        </div>

        {data.referrals.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>{t('referral.empty')}</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {data.referrals.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 rounded-xl p-2.5"
                  style={{ background: 'rgb(var(--card-2))', border: '1px solid rgb(var(--line))' }}>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-semibold">
                    {(r.referee_email ?? '—').replace(/(.{2}).*(@.*)/, '$1•••$2')}
                  </span>
                  <span className="tnum text-xs" style={{ color: 'rgb(var(--fg-subtle))' }}>
                    {new Date(r.created_at).toLocaleDateString(locale)}
                  </span>
                </span>
                <span className="chip" style={{
                  background: r.status === 'REWARDED' ? 'rgb(var(--ok)/0.12)' : 'rgb(var(--card-2))',
                  color: r.status === 'REWARDED' ? 'rgb(var(--ok))' : 'rgb(var(--fg-muted))',
                  border: '1px solid rgb(var(--line))',
                }}>
                  {t(`referral.status.${r.status}`)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

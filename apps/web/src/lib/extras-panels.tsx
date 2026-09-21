'use client';

import { useCallback, useEffect, useState } from 'react';
import { useI18n } from './i18n-provider';
import { ApiError } from './auth-api';
import {
  extrasApi, type BoostOption, type ComplaintEligibility, type TrackingLink,
} from './extras-api';
import { CategoryIcon } from './icons';
import { Price, Spinner } from './ui';

function errText(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Buy a visibility boost with the wallet balance.
 *
 * Hidden entirely when the operator has the module switched off, rather than
 * shown disabled: a module that is off should not look like a broken feature.
 */
export function BoostPanel() {
  const { t } = useI18n();
  const [options, setOptions] = useState<BoostOption[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void extrasApi.boostPrices()
      .then((d) => { setEnabled(d.enabled); setOptions(d.options); })
      .catch(() => setEnabled(false))
      .finally(() => setLoading(false));
  }, []);

  async function buy(hours: number) {
    setBusy(hours);
    setError(null);
    setNotice(null);
    try {
      await extrasApi.buyBoost(hours);
      setNotice(t('boost.bought'));
    } catch (err) {
      setError(errText(err, t('common.error')));
    } finally {
      setBusy(null);
    }
  }

  if (loading || !enabled || options.length === 0) return null;

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <CategoryIcon name="bolt" size={18} />
        <h3 className="text-sm font-extrabold">{t('boost.title')}</h3>
      </div>
      <p className="mt-1 text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>{t('boost.hint')}</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.hours}
            onClick={() => void buy(o.hours)}
            disabled={busy !== null}
            className="btn btn-secondary flex-1"
          >
            {busy === o.hours ? <Spinner size={16} /> : <CategoryIcon name="bolt" size={16} />}
            {t('boost.forHours', { hours: o.hours })}
            {' · '}
            <Price minor={o.priceMinor} size="sm" />
          </button>
        ))}
      </div>

      {notice && <p className="mt-2 text-xs font-semibold" style={{ color: 'rgb(var(--ok))' }}>{notice}</p>}
      {error && <p className="mt-2 text-xs font-semibold" style={{ color: 'rgb(var(--danger))' }}>{error}</p>}
    </div>
  );
}

/**
 * Open a complaint inside the guarantee window, or explain why you cannot.
 * The window and the server-side enforcement both come from the API.
 */
export function ComplaintPanel({ jobId }: { jobId: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<ComplaintEligibility | null>(null);
  const [open, setOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void extrasApi.complaintEligibility(jobId).then(setState).catch(() => setState(null));
  }, [jobId]);

  async function submit() {
    if (subject.trim().length < 3 || body.trim().length < 10) {
      setError(t('complaint.tooShort'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await extrasApi.complain({ jobId, subject: subject.trim(), body: body.trim() });
      setNotice(t('complaint.opened', { code: r.code }));
      setOpen(false);
      setSubject('');
      setBody('');
      setState(await extrasApi.complaintEligibility(jobId));
    } catch (err) {
      setError(errText(err, t('common.error')));
    } finally {
      setBusy(false);
    }
  }

  if (!state?.enabled) return null;

  if (state.hasOpenComplaint) {
    return (
      <div className="card p-4">
        <p className="text-sm font-semibold" style={{ color: 'rgb(var(--warn))' }}>
          {t('complaint.alreadyOpen')}
        </p>
      </div>
    );
  }

  if (!state.canComplain) return null;

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <CategoryIcon name="shield" size={18} />
        <h3 className="text-sm font-extrabold">{t('complaint.title')}</h3>
      </div>
      <p className="mt-1 text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
        {t('complaint.window', { days: state.guaranteeDays })}
      </p>

      {!open ? (
        <button onClick={() => setOpen(true)} className="btn btn-secondary mt-3 w-full">
          <CategoryIcon name="shield" size={16} />
          {t('complaint.open')}
        </button>
      ) : (
        <div className="mt-3 space-y-2">
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={t('complaint.subject')}
            maxLength={200}
            className="input w-full"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('complaint.body')}
            rows={4}
            maxLength={4000}
            className="input w-full resize-none"
          />
          <div className="flex gap-2">
            <button onClick={() => setOpen(false)} className="btn btn-secondary flex-1">
              {t('common.cancel')}
            </button>
            <button onClick={() => void submit()} disabled={busy} className="btn btn-primary flex-1">
              {busy ? <Spinner size={16} /> : <CategoryIcon name="check" size={16} />}
              {t('complaint.submit')}
            </button>
          </div>
        </div>
      )}

      {notice && <p className="mt-2 text-xs font-semibold" style={{ color: 'rgb(var(--ok))' }}>{notice}</p>}
      {error && <p className="mt-2 text-xs font-semibold" style={{ color: 'rgb(var(--danger))' }}>{error}</p>}
    </div>
  );
}

/**
 * Share a temporary, revocable tracking link with someone the customer trusts.
 * The link reveals position only, and dies with the job or the expiry.
 */
export function TrackingSharePanel({ jobId }: { jobId: string }) {
  const { t } = useI18n();
  const [links, setLinks] = useState<TrackingLink[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);

  const load = useCallback(async () => {
    try {
      setLinks(await extrasApi.trackingLinks(jobId));
    } catch {
      setAvailable(false);
    }
  }, [jobId]);

  useEffect(() => { void load(); }, [load]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await extrasApi.createTrackingLink(jobId, 12);
      await load();
    } catch (err) {
      const msg = errText(err, t('common.error'));
      // The module being off is not an error worth shouting about.
      if (/not available/i.test(msg)) setAvailable(false);
      else setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function copy(link: TrackingLink) {
    const url = `${window.location.origin}/track/${link.token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(link.id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError(url);
    }
  }

  if (!available) return null;

  const live = links.filter((l) => !l.revoked_at && new Date(l.expires_at).getTime() > Date.now());

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2">
        <CategoryIcon name="pin" size={18} />
        <h3 className="text-sm font-extrabold">{t('tracking.title')}</h3>
      </div>
      <p className="mt-1 text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>{t('tracking.hint')}</p>

      <button onClick={() => void create()} disabled={busy} className="btn btn-secondary mt-3 w-full">
        {busy ? <Spinner size={16} /> : <CategoryIcon name="pin" size={16} />}
        {t('tracking.create')}
      </button>

      {live.length > 0 && (
        <ul className="mt-3 space-y-2">
          {live.map((l) => (
            <li key={l.id} className="flex items-center justify-between gap-2 rounded-xl p-2"
                style={{ background: 'rgb(var(--card-2))', border: '1px solid rgb(var(--line))' }}>
              <span className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
                {t('tracking.views', { count: l.view_count })}
              </span>
              <span className="flex gap-1.5">
                <button onClick={() => void copy(l)} className="btn btn-secondary !py-1 !text-xs">
                  {copied === l.id ? t('tracking.copied') : t('tracking.copy')}
                </button>
                <button
                  onClick={() => void extrasApi.revokeTrackingLink(l.id).then(load)}
                  className="btn btn-danger !py-1 !text-xs"
                >
                  {t('tracking.revoke')}
                </button>
              </span>            </li>
          ))}
        </ul>
      )}

      {error && <p className="mt-2 text-xs font-semibold" style={{ color: 'rgb(var(--danger))' }}>{error}</p>}
    </div>
  );
}

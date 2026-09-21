'use client';

import { useState } from 'react';
import { useI18n } from './i18n-provider';
import { ApiError } from './auth-api';
import { reviewsApi, type RatingStatus } from './reviews-api';
import { CategoryIcon } from './icons';
import { Spinner } from './ui';

/**
 * Rating panel shown on a finished job.
 *
 * Both sides rate each other. The customer's rating is public and builds the
 * provider's reputation; the provider's rating of the customer is internal.
 * Rating is what closes the job, but it never blocks the other party: whoever
 * has not rated yet still sees their own form.
 */

const SCORE_KEYS = [
  'punctuality',
  'quality',
  'communication',
  'value',
] as const;
type ScoreKey = (typeof SCORE_KEYS)[number];

export function RatingPanel({
  jobId,
  status,
  onRated,
  opponentName,
}: {
  jobId: string;
  status: RatingStatus;
  onRated: () => void;
  opponentName?: string | null;
}) {
  const { t } = useI18n();
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState('');
  const [scores, setScores] = useState<Record<ScoreKey, number>>({
    punctuality: 0, quality: 0, communication: 0, value: 0,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isCustomer = status.role === 'CUSTOMER';

  async function submit() {
    if (rating < 1) {
      setError(t('rating.needStars'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await reviewsApi.create({
        jobId,
        rating,
        comment: comment.trim() || undefined,
        ...Object.fromEntries(
          SCORE_KEYS.filter((k) => scores[k] > 0).map((k) => [k, scores[k]]),
        ),
      });
      onRated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }

  // Already rated by me: show the counterparty's state instead of the form.
  if (status.iRated) {
    return (
      <div className="card p-4">
        <div className="flex items-center gap-2">
          <span className="chip chip-ok">
            <CategoryIcon name="check" size={13} />
            {t('rating.done')}
          </span>
        </div>
        <p className="mt-2 text-sm" style={{ color: 'rgb(var(--fg-muted))' }}>
          {status.fullyRated
            ? t('rating.bothDone')
            : t('rating.waitingOther')}
        </p>
      </div>
    );
  }

  // The counterparty already rated me — nudge, but never block.
  const nudge = status.theyRated ? t('rating.otherRatedYou') : null;

  return (
    <div className="card p-4">
      <h3 className="text-sm font-extrabold">
        {isCustomer ? t('rating.titleCustomer') : t('rating.titleProvider')}
      </h3>
      <p className="mt-1 text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
        {isCustomer ? t('rating.subCustomer') : t('rating.subProvider')}
        {opponentName ? ` — ${opponentName}` : ''}
      </p>

      {nudge && (
        <p className="mt-2 rounded-lg px-3 py-2 text-xs font-semibold"
           style={{ background: 'rgb(var(--brand)/0.1)', color: 'rgb(var(--brand))' }}>
          {nudge}
        </p>
      )}

      {/* Overall stars — big and tappable. */}
      <div className="mt-3 flex items-center gap-1.5" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => {
          const active = n <= (hover || rating);
          return (
            <button
              key={n}
              type="button"
              aria-label={String(n)}
              onMouseEnter={() => setHover(n)}
              onClick={() => setRating(n)}
              className="transition-transform active:scale-90"
              style={{ lineHeight: 0 }}
            >
              <svg width="32" height="32" viewBox="0 0 24 24"
                   fill={active ? 'rgb(var(--brand))' : 'transparent'}
                   stroke={active ? 'rgb(var(--brand))' : 'rgb(var(--line-strong))'}
                   strokeWidth="1.6">
                <path d="M12 2.6l2.9 5.9 6.5.95-4.7 4.6 1.1 6.45L12 17.4l-5.8 3.05 1.1-6.45-4.7-4.6 6.5-.95z" />
              </svg>
            </button>
          );
        })}
        <span className="ms-1 text-lg font-extrabold tnum">{rating || '—'}</span>
      </div>

      {/* Sub-scores, optional but they make the aggregate meaningful. */}
      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        {SCORE_KEYS.map((k) => (
          <div key={k} className="flex items-center justify-between gap-2">
            <span className="text-xs" style={{ color: 'rgb(var(--fg-muted))' }}>
              {t(`rating.dim.${k}`)}
            </span>
            <span className="flex gap-0.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  aria-label={`${k}-${n}`}
                  onClick={() => setScores((s) => ({ ...s, [k]: n }))}
                  className="h-2.5 w-2.5 rounded-full transition-colors"
                  style={{
                    background: n <= scores[k] ? 'rgb(var(--brand))' : 'rgb(var(--line-strong))',
                  }}
                />
              ))}
            </span>
          </div>
        ))}
      </div>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={t('rating.commentPlaceholder')}
        rows={3}
        maxLength={2000}
        className="input mt-3 w-full resize-none"
      />

      {error && (
        <p className="mt-2 text-sm font-semibold" style={{ color: 'rgb(var(--danger))' }}>
          {error}
        </p>
      )}

      <button onClick={submit} disabled={busy} className="btn btn-primary btn-lg mt-3 w-full">
        {busy ? <Spinner size={18} /> : <CategoryIcon name="check" size={18} />}
        {t('rating.submit')}
      </button>
    </div>
  );
}

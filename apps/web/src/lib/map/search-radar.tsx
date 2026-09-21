'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { useRealtime } from '@/lib/realtime-client';
import { MapView, ThemedMarker, DEFAULT_MAP_STYLE } from '@/lib/map/map-view';
import { CategoryIcon } from '@/lib/icons';

/**
 * The "finding craftsmen" screen.
 *
 * The inDrive moment: the request is published, matching fans out, and the
 * customer watches a radar over a full-bleed map while offers stream in. The
 * screen decides nothing — it makes an invisible server-side process feel alive
 * and honest about how long the search runs.
 *
 * The map owns the whole viewport and the panel floats over it as a dark sheet,
 * which is what makes this read as a live request rather than a form result.
 */

export interface RadarOffer {
  id: string;
  price_minor?: number;
  currency?: string;
  status?: string;
  provider_name?: string;
  provider_avatar?: string | null;
}

export interface SearchRadarProps {
  requestId: string;
  offers: RadarOffer[];
  point: { lat: number; lng: number } | null;
  expiresAt?: string | null;
  radiusKm?: number;
  candidateCount?: number;
  priceMinor?: number | null;
  currency?: string;
  pickupLabel?: string | null;
  onViewOffers: () => void;
  onStop?: () => void;
  /** Quick price adjustment straight from the sheet. */
  onPriceChange?: (nextMinor: number) => void;
}

const RADIUS_MIN_KM = 5;
const RADIUS_MAX_KM = 25;

export function SearchRadar({
  requestId,
  offers,
  point,
  expiresAt,
  candidateCount = 0,
  priceMinor = null,
  currency = 'MAD',
  pickupLabel = null,
  onViewOffers,
  onStop,
  onPriceChange,
}: SearchRadarProps) {
  const { t, locale } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const [flash, setFlash] = useState(false);
  const [liveOffers, setLiveOffers] = useState<RadarOffer[]>(offers);
  const [autoAccept, setAutoAccept] = useState(false);
  const seenOffers = useRef<number>(offers.length);

  // A new offer is the payoff for the whole screen, so pulse the counter and
  // re-seed the list when realtime pushes one in.
  useEffect(() => {
    setLiveOffers(offers);
    if (offers.length > seenOffers.current) {
      seenOffers.current = offers.length;
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 1400);
      return () => clearTimeout(id);
    }
    seenOffers.current = offers.length;
  }, [offers]);

  const { connected } = useRealtime(
    { requestId },
    {
      onEvent: (env) => {
        if (env.event === 'offer:created' || env.event === 'offer:updated') {
          setFlash(true);
          setTimeout(() => setFlash(false), 1400);
        }
      },
    },
  );

  // Tick once a second so the elapsed time reads as motion, not a stall.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const startedAt = useRef(Date.now());
  const elapsedSeconds = Math.max(0, Math.floor((now - startedAt.current) / 1000));

  const remainingMs = useMemo(() => {
    if (!expiresAt) return null;
    return Math.max(0, new Date(expiresAt).getTime() - now);
  }, [expiresAt, now]);

  const expired = remainingMs !== null && remainingMs === 0;

  /**
   * The search window is 72 hours, so a mm:ss clock would read "4319:53". Show
   * hours once the window is longer than an hour, and the elapsed clock only
   * while the search is genuinely in its first minutes.
   */
  const timeLabel = useMemo(() => {
    if (remainingMs !== null) return formatRemaining(Math.ceil(remainingMs / 1000));
    return formatClock(elapsedSeconds);
  }, [remainingMs, elapsedSeconds]);

  /**
   * The bar is the search's own progress, not a countdown to the deadline:
   * filling it over 72 hours would look stuck. It tracks how far the search has
   * widened from the initial radius toward the maximum, so it visibly moves.
   */
  const progress = useMemo(() => {
    if (expired) return 1;
    if (remainingMs === null) return 0.35;
    // Reaches full over roughly the first 6 minutes, then waits.
    const window = 6 * 60 * 1000;
    const elapsedMs = window - Math.min(window, remainingMs % window || 0);
    return Math.min(0.92, 0.12 + (elapsedMs / window) * 0.8);
  }, [remainingMs, expired]);

  const radiusKm = useMemo(() => {
    const span = RADIUS_MAX_KM - RADIUS_MIN_KM;
    return Math.round(RADIUS_MIN_KM + span * progress);
  }, [progress]);

  const price = priceMinor != null ? formatMoney(priceMinor, currency, locale) : null;

  return (
    <div className="live-stage">
      {/* The map is the screen. */}
      <div className="live-map">
        {point ? (
          <MapView
            center={[point.lat, point.lng]}
            zoom={14}
            style={DEFAULT_MAP_STYLE}
            className="h-full w-full"
          >
            <ThemedMarker position={[point.lat, point.lng]} kind="me" />
            {liveOffers.map((o, i) => {
              const angle = (i / Math.max(liveOffers.length, 1)) * Math.PI * 2;
              return (
                <ThemedMarker
                  key={o.id}
                  position={[
                    point.lat + Math.cos(angle) * 0.012,
                    point.lng + Math.sin(angle) * 0.012,
                  ]}
                  kind="provider"
                  dim
                />
              );
            })}
          </MapView>
        ) : (
          <div className="live-map-blank" />
        )}

        {/* The radar sweep, centred on the request point. */}
        <div className="live-radar" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="live-radar-ring"
              style={{ animationDelay: `${i * 0.9}s` }}
            />
          ))}
        </div>
      </div>

      {/* Partners strip, floating just above the sheet. */}
      <div className="live-partners">
        <DriverStack offers={liveOffers} />
        <p className="live-partners-text">
          {liveOffers.length === 1
            ? t('searching.partnersOne')
            : t('searching.partners', { count: liveOffers.length })}
        </p>
      </div>

      {/* The dark sheet. */}
      <div className="live-sheet">
        <div className="live-grip" aria-hidden />

        <div className="live-row-head">
          <span className="live-clock tnum">{expired ? '0:00' : timeLabel}</span>
          <div className="live-status">
            <p className="live-status-title">
              {expired ? t('search.expired') : t('searching.waitingReplies')}
            </p>
            <p className="live-status-sub">
              {expired ? '' : t('searching.youChoose')}
            </p>
          </div>
        </div>

        <div className="live-progress" aria-hidden>
          <span className="live-progress-fill" style={{ width: `${progress * 100}%` }} />
        </div>

        <p className="live-hint">
          {expired ? t('search.expired') : t('searching.expanding')}
        </p>

        {/* Price with steppers — the inDrive bargaining affordance. */}
        {priceMinor != null && (
          <div className="live-price">
            <button
              type="button"
              className="live-step"
              disabled={!onPriceChange}
              onClick={() => onPriceChange?.(Math.max(100, priceMinor - 500))}
              aria-label={t('offer.price')}
            >
              <CategoryIcon name="minus" size={20} />
            </button>
            <div className="live-price-value">
              <span className="live-price-label">{t('searching.offerPrice')}</span>
              <span className="live-price-amount tnum">{price}</span>
            </div>
            <button
              type="button"
              className="live-step"
              disabled={!onPriceChange}
              onClick={() => onPriceChange?.(priceMinor + 500)}
              aria-label={t('offer.price')}
            >
              <CategoryIcon name="plus" size={20} />
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={onViewOffers}
          disabled={liveOffers.length === 0}
          className="live-confirm"
        >
          {liveOffers.length > 0
            ? `${t('searching.confirm')} · ${liveOffers.length}`
            : t('searching.confirm')}
        </button>

        {/* Auto-accept: the switch from the reference screen. */}
        <button
          type="button"
          role="switch"
          aria-checked={autoAccept}
          onClick={() => setAutoAccept((v) => !v)}
          className="live-toggle-row"
        >
          <span className={`live-switch ${autoAccept ? 'is-on' : ''}`} aria-hidden>
            <span className="live-switch-knob" />
          </span>
          <span className="live-toggle-text">
            {price
              ? t('searching.autoAccept', { price })
              : t('searching.autoAccept', { price: '—' })}
          </span>
          <CategoryIcon name="arrow" size={19} className="live-toggle-icon" />
        </button>

        <div className="live-facts">
          {price && (
            <div className="live-fact">
              <span className="live-fact-icon live-fact-icon--cash">
                <CategoryIcon name="wallet" size={17} />
              </span>
              <span className="live-fact-text tnum">
                {price} {t('searching.cash')}
              </span>
            </div>
          )}
          {pickupLabel && (
            <div className="live-fact live-fact--wide">
              <span className="live-fact-icon">
                <CategoryIcon name="pin" size={17} />
              </span>
              <span className="live-fact-text live-fact-text--strong">{pickupLabel}</span>
            </div>
          )}
        </div>

        <p className="live-scanning">
          {t('search.scanning', { km: radiusKm })}
          {candidateCount > 0 && <> · {t('search.found', { count: candidateCount })}</>}
          {' · '}
          <span className={connected ? 'live-dot is-on' : 'live-dot'} aria-hidden />
        </p>

        {onStop && !expired && (
          <button type="button" onClick={onStop} className="live-cancel">
            {t('searching.cancelRequest')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Overlapping avatars, newest first, capped so the row never wraps. */
function DriverStack({ offers }: { offers: RadarOffer[] }) {
  const shown = offers.slice(0, 4);
  if (shown.length === 0) {
    return (
      <span className="live-stack live-stack--empty" aria-hidden>
        <CategoryIcon name="radar" size={18} />
      </span>
    );
  }
  return (
    <span className="live-stack" aria-hidden>
      {shown.map((o, i) => (
        <span key={o.id} className="live-avatar" style={{ zIndex: shown.length - i }}>
          {o.provider_avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={o.provider_avatar} alt="" />
          ) : (
            (o.provider_name ?? '?').trim().charAt(0)
          )}
        </span>
      ))}
    </span>
  );
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * A remaining window, at the scale it deserves: the deadline is 72 hours out, so
 * mm:ss is meaningless. Under an hour stays a clock; above that reads in hours.
 */
export function formatRemaining(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  if (safe < 3600) return formatClock(safe);
  const hours = Math.floor(safe / 3600);
  if (hours < 24) return `${hours}:${String(Math.floor((safe % 3600) / 60)).padStart(2, '0')}`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

/** Minor units to a short localized label, e.g. "52 د.م.". */
function formatMoney(minor: number, currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: minor % 100 === 0 ? 0 : 2,
    }).format(minor / 100);
  } catch {
    return `${minor / 100} ${currency}`;
  }
}

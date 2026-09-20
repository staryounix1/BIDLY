'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { useRealtime } from '@/lib/realtime-client';
import { useMap, TILE_URL, TILE_ATTRIBUTION } from '@/lib/map/leaflet';

/**
 * The "finding providers" screen.
 *
 * This is the inDrive moment: the request is published, the matching engine is
 * fanning out, and the customer watches a live radar while offers stream in
 * one after another. Nothing here decides anything — it only makes an
 * otherwise invisible server-side process feel alive and honest about how many
 * providers were reached and how long the search will run.
 */

/** Only the count matters here, so accept any offer shape the pages already have. */
export interface RadarOffer {
  id: string;
}

export interface SearchRadarProps {
  requestId: string;
  offers: RadarOffer[];
  point: { lat: number; lng: number } | null;
  expiresAt?: string | null;
  radiusKm?: number;
  candidateCount?: number;
  onViewOffers: () => void;
  onStop?: () => void;
}

export function SearchRadar({
  requestId,
  offers,
  point,
  expiresAt,
  radiusKm = 25,
  candidateCount = 0,
  onViewOffers,
  onStop,
}: SearchRadarProps) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  const [flash, setFlash] = useState(false);
  const seenOffers = useRef<number>(offers.length);
  const [liveOffers, setLiveOffers] = useState<RadarOffer[]>(offers);

  // A new offer arriving is the payoff for the whole screen, so pulse the
  // counter and re-seed the visible list when realtime pushes one in.
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

  const { connected } = useRealtime({ requestId }, {
    onEvent: (env) => {
      if (env.event === 'offer:created' || env.event === 'offer:updated') {
        setFlash(true);
        setTimeout(() => setFlash(false), 1400);
      }
    },
  });

  // Tick once a second so the countdown is smooth and the radar sweep reads as
  // motion rather than a stall.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const remainingMs = useMemo(() => {
    if (!expiresAt) return null;
    return Math.max(0, new Date(expiresAt).getTime() - now);
  }, [expiresAt, now]);

  const expired = remainingMs !== null && remainingMs === 0;
  const secondsLeft = remainingMs === null ? null : Math.ceil(remainingMs / 1000);

  return (
    <div className="space-y-4">
      <div className="relative overflow-hidden rounded-2xl border border-black/10 bg-gradient-to-b from-sky-50 to-white p-6 text-center dark:border-white/15 dark:from-slate-900 dark:to-slate-950">
        <RadarSweep active={!expired} />

        <div className="relative">
          <p className="text-lg font-bold">{t('search.title')}</p>
          <p className="mt-1 text-sm opacity-70">{t('search.subtitle')}</p>

          <div
            className={`mt-5 inline-flex items-baseline gap-2 rounded-2xl px-5 py-3 transition-colors ${
              flash ? 'bg-emerald-500/15 ring-2 ring-emerald-500/40' : 'bg-black/5 dark:bg-white/10'
            }`}
          >
            <span className="text-3xl font-black tabular-nums">{liveOffers.length}</span>
            <span className="text-sm opacity-70">{t('offer.offers')}</span>
          </div>

          <p className="mt-3 text-xs opacity-60">
            {t('search.scanning', { km: radiusKm })}
            {candidateCount > 0 && <> · {t('search.found', { count: candidateCount })}</>}
          </p>

          {secondsLeft !== null && (
            <p className="mt-2 text-xs opacity-50">
              {t('search.expiresIn')} {formatClock(secondsLeft)}
            </p>
          )}

          <div className="mt-3 flex items-center justify-center gap-2 text-[11px]">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                connected ? 'bg-emerald-500' : 'bg-amber-500'
              }`}
            />
            <span className="opacity-60">
              {connected ? t('search.waiting') : t('common.loading')}
            </span>
          </div>
        </div>
      </div>

      {point && <MiniMap point={point} offers={liveOffers} height={200} />}

      {liveOffers.length > 0 ? (
        <button
          type="button"
          onClick={onViewOffers}
          className="w-full rounded-lg bg-slate-900 px-5 py-3 text-sm font-semibold text-white dark:bg-white dark:text-slate-900"
        >
          {t('search.viewOffers')} ({liveOffers.length})
        </button>
      ) : (
        <div className="rounded-2xl border border-dashed border-black/15 p-5 text-center dark:border-white/15">
          <p className="text-sm opacity-70">
            {expired
              ? t('search.expired')
              : t('search.noOneYet', { expires: expiresAt ? formatWhen(expiresAt) : '—' })}
          </p>
          {onStop && !expired && (
            <button
              type="button"
              onClick={onStop}
              className="mt-3 text-xs underline opacity-60 hover:opacity-100"
            >
              {t('search.stop')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Concentric rings pulsing outward — the visual shorthand for "scanning". */
function RadarSweep({ active }: { active: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="absolute rounded-full border border-sky-400/30"
          style={{
            width: 90,
            height: 90,
            animation: active ? `bidly-radar 2.4s ${i * 0.8}s ease-out infinite` : 'none',
          }}
        />
      ))}
      <style>{`
        @keyframes bidly-radar {
          0%   { transform: scale(0.4); opacity: 0.75; }
          100% { transform: scale(3.2); opacity: 0; }
        }
      `}</style>
    </div>
  );
}

/** Small map showing the request point and the pin of every offer received. */
function MiniMap({
  point,
  offers,
  height = 200,
}: {
  point: { lat: number; lng: number };
  offers: RadarOffer[];
  height?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Offers do not carry coordinates: an offer is a price, and the provider's
  // position lives in `provider_locations`. Until the tracking step feeds real
  // provider pins in, draw one marker per offer fanned around the request point
  // so the map still communicates "N providers engaged".
  const ring = useMemo(() => {
    const n = Math.max(offers.length, 0);
    const out: Array<{ lat: number; lng: number }> = [];
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2;
      out.push({
        lat: point.lat + Math.cos(angle) * 0.012,
        lng: point.lng + Math.sin(angle) * 0.012,
      });
    }
    return out;
  }, [offers.length, point.lat, point.lng]);
  const ringKey = ring.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|');

  useMap(
    ref,
    (L, map) => {
      L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);
      map.setView([point.lat, point.lng], 12);

      L.circle([point.lat, point.lng], {
        radius: 700,
        color: '#0ea5e9',
        fillColor: '#0ea5e9',
        fillOpacity: 0.25,
      }).addTo(map);
      L.marker([point.lat, point.lng]).addTo(map);

      for (const p of ring) {
        L.circle([p.lat, p.lng], {
          radius: 350,
          color: '#10b981',
          fillColor: '#10b981',
          fillOpacity: 0.5,
        }).addTo(map);
      }
      return undefined;
    },
    [point.lat, point.lng, ringKey],
  );

  return (
    <div
      ref={ref}
      style={{ height }}
      className="w-full overflow-hidden rounded-2xl border border-black/10 dark:border-white/15"
      dir="ltr"
    />
  );
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}

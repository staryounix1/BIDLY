'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n-provider';
import { useRealtime } from '@/lib/realtime-client';
import { useMap, addTileLayer } from '@/lib/map/leaflet';
import { CategoryIcon } from '@/lib/icons';

/**
 * The "finding craftsmen" screen.
 *
 * The inDrive moment: the request is published, matching is fanning out, and
 * the customer watches a radar while offers stream in one after another. The
 * screen decides nothing — it makes an otherwise invisible server-side process
 * feel alive and honest about how long the search runs.
 */

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
  const [liveOffers, setLiveOffers] = useState<RadarOffer[]>(offers);
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

  return (
    <div className="flex min-h-[68vh] flex-col">
      {/* Radar stage */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden">
        <RadarStage active={!expired} />

        <div className="relative z-10 flex flex-col items-center text-center">
          <CounterPill count={liveOffers.length} flash={flash} />

          {/* Moving dots imply the search is still running. */}
          <p className="mt-6 flex items-center gap-1.5 text-[0.9375rem] font-bold">
            {expired ? t('search.expired') : t('searching.looking')}
            {!expired && <Dots />}
          </p>

          {!expired && (
            <p className="tnum mt-2 text-xs font-semibold text-[rgb(var(--fg-subtle))]">
              {t('searching.elapsed', { seconds: elapsedSeconds })}
            </p>
          )}

          <p className="mt-3 text-xs text-[rgb(var(--fg-subtle))]">
            {t('search.scanning', { km: radiusKm })}
            {candidateCount > 0 && <> · {t('search.found', { count: candidateCount })}</>}
          </p>

          <span className="mt-4 inline-flex items-center gap-2 text-[11px] font-semibold text-[rgb(var(--fg-subtle))]">
            <span
              className={`inline-block h-2 w-2 rounded-full ${
                connected ? 'bg-[rgb(var(--brand-600))]' : 'bg-[rgb(var(--warn))]'
              }`}
            />
            {connected ? t('search.waiting') : t('common.loading')}
          </span>
        </div>
      </div>

      {point && <MiniMap point={point} offers={liveOffers} height={160} />}

      {/* Bottom actions: the loud path is offers, the quiet one is cancel. */}
      <div className="mt-4 space-y-2.5">
        {liveOffers.length > 0 ? (
          <button type="button" onClick={onViewOffers} className="btn btn-primary btn-block">
            {t('searching.viewOffers')}
            <span className="tnum rounded-full bg-[rgb(var(--brand-ink)/0.16)] px-2.5 py-0.5 text-sm">
              {liveOffers.length}
            </span>
          </button>
        ) : (
          <div className="card p-4 text-center">
            <p className="text-sm text-[rgb(var(--fg-muted))]">
              {expired
                ? t('search.expired')
                : t('search.noOneYet', { expires: expiresAt ? formatWhen(expiresAt) : '—' })}
            </p>
          </div>
        )}

        {onStop && !expired && (
          <button type="button" onClick={onStop} className="btn btn-secondary btn-block">
            <CategoryIcon name="x" size={18} />
            {t('searching.cancel')}
          </button>
        )}
      </div>
    </div>
  );
}

/** Concentric rings pulsing out from the customer's dot. */
function RadarStage({ active }: { active: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="absolute rounded-full border-2"
          style={{
            width: 120,
            height: 120,
            borderColor: 'rgb(50 244 186 / 0.45)',
            animation: active ? `khdemli-pulse 2.4s ${i * 0.8}s cubic-bezier(0.24,0,0.38,1) infinite` : 'none',
          }}
        />
      ))}

      {/* The customer's own position. */}
      <span
        className="relative grid h-16 w-16 place-items-center rounded-full"
        style={{ background: 'rgb(50 244 186 / 0.18)' }}
      >
        <span
          className="grid h-11 w-11 place-items-center rounded-full text-[rgb(var(--brand-ink))]"
          style={{ background: 'rgb(50 244 186)' }}
        >
          <CategoryIcon name="pin" size={22} strokeWidth={2.2} />
        </span>
      </span>
    </div>
  );
}

function CounterPill({ count, flash }: { count: number; flash: boolean }) {
  const { t } = useI18n();
  return (
    <div
      className="inline-flex items-baseline gap-2 rounded-2xl px-5 py-3 transition-all duration-300"
      style={{
        background: flash ? 'rgb(50 244 186 / 0.28)' : 'rgb(var(--surface))',
        boxShadow: flash
          ? '0 0 0 4px rgb(50 244 186 / 0.35), var(--shadow-md)'
          : 'var(--shadow-md)',
      }}
    >
      <span className="tnum text-4xl font-black tracking-tight">{count}</span>
      <span className="text-sm font-bold text-[rgb(var(--fg-muted))]">{t('offer.offers')}</span>
    </div>
  );
}

/** Three animated dots — "still working" without a spinner. */
function Dots() {
  return (
    <span className="inline-flex items-end gap-0.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="bounce-soft inline-block h-1.5 w-1.5 rounded-full bg-[rgb(var(--brand-600))]"
          style={{ animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </span>
  );
}

/** Small map showing the request point and every offer fanning around it. */
function MiniMap({
  point,
  offers,
  height = 160,
}: {
  point: { lat: number; lng: number };
  offers: RadarOffer[];
  height?: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  // Offers carry no coordinates: an offer is a price, and the provider's
  // position lives in `provider_locations`. Until tracking feeds real pins in,
  // draw one marker per offer fanned around the request point so the map still
  // communicates "N providers engaged".
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
      addTileLayer(L, map);
      map.setView([point.lat, point.lng], 12);

      L.circle([point.lat, point.lng], {
        radius: 700,
        color: '#10cd99',
        fillColor: '#32f4ba',
        fillOpacity: 0.3,
      }).addTo(map);
      L.marker([point.lat, point.lng]).addTo(map);

      for (const p of ring) {
        L.circle([p.lat, p.lng], {
          radius: 350,
          color: '#10cd99',
          fillColor: '#32f4ba',
          fillOpacity: 0.55,
        }).addTo(map);
      }
      return undefined;
    },
    [point.lat, point.lng, ringKey],
  );

  return (
    <div
      ref={ref}
      className="map-canvas mt-4 w-full overflow-hidden rounded-2xl border border-[rgb(var(--line))]"
      style={{ height }}
    />
  );
}

function formatClock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return formatClock(Math.max(0, Math.ceil((d.getTime() - Date.now()) / 1000)));
}

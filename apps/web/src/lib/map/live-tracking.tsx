'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n-provider';
import { TrackProvider } from '@/lib/map/track-provider';
import { CategoryIcon } from '@/lib/icons';
import { Avatar, Stars } from '@/lib/ui';

/**
 * Full-screen live tracking with a sliding bottom sheet.
 *
 * The map owns the whole viewport — that is the point of this screen — and the
 * provider card slides up over it, the same shape as every ride-hailing app.
 * The sheet carries the only three things a waiting customer wants: who is
 * coming, how far away, and how to reach them.
 */

export interface LiveTrackingProps {
  providerId: string;
  providerName: string;
  providerAvatar?: string | null;
  ratingAvg?: number | null;
  completedJobs?: number | null;
  priceMinor?: number | null;
  currency?: string | null;
  etaMinutes?: number | null;
  destination?: { lat: number; lng: number } | null;
  jobHref?: string;
  messageHref?: string;
  /** Immediate first paint: map height in px. */
  mapHeight?: number;
}

export function LiveTracking({
  providerId,
  providerName,
  providerAvatar,
  ratingAvg,
  completedJobs,
  priceMinor,
  currency,
  etaMinutes,
  destination = null,
  jobHref,
  messageHref,
  mapHeight = 420,
}: LiveTrackingProps) {
  const { t } = useI18n();

  return (
    <section className="relative">
      {/* Map fills the stage. */}
      <div className="card map-canvas overflow-hidden !rounded-none !border-x-0 sm:!rounded-2xl sm:!border-x">
        <div className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-2">
          <span className="flex items-center gap-2 text-sm font-bold">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[rgb(var(--brand-500))] opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[rgb(var(--brand-600))]" />
            </span>
            {t('tracking.providerComing')}
          </span>
          {etaMinutes != null && (
            <span className="chip chip-brand tnum">{t('tracking.eta', { minutes: etaMinutes })}</span>
          )}
        </div>

        <TrackProvider
          providerId={providerId}
          destination={destination}
          providerName={providerName}
          height={mapHeight}
        />
      </div>

      {/* Bottom sheet: who, and how to reach them. */}
      <div className="sheet sheet-up">
        <div className="sheet-handle" />

        <div className="app-shell px-4 pb-4 pt-3">
          <div className="flex items-center gap-3">
            <Avatar name={providerName} src={providerAvatar} size={54} />

            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-black tracking-tight">{providerName}</p>
              <div className="mt-0.5 flex items-center gap-2">
                <Stars value={ratingAvg} count={completedJobs} />
                {etaMinutes != null && (
                  <span className="text-xs font-semibold text-[rgb(var(--brand-700))]">
                    · {t('tracking.eta', { minutes: etaMinutes })}
                  </span>
                )}
              </div>
            </div>

            {priceMinor != null && (
              <span className="text-end">
                <span className="price block text-xl text-[rgb(var(--fg))]">
                  {Math.round(priceMinor / 100).toLocaleString()}
                </span>
                <span className="text-xs font-bold text-[rgb(var(--fg-muted))]">
                  {currency ?? 'MAD'}
                </span>
              </span>
            )}
          </div>

          <div className="mt-3.5 flex gap-2">
            <Link href={messageHref ?? '#'} className="btn btn-primary flex-1">
              <CategoryIcon name="chat" size={19} />
              {t('tracking.message')}
            </Link>
            <Link href={jobHref ?? '#'} className="btn btn-secondary flex-1">
              <CategoryIcon name="route" size={19} />
              {t('job.details')}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

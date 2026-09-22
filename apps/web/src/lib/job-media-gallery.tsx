'use client';

import { useState } from 'react';
import { useI18n } from './i18n-provider';
import { CategoryIcon } from './icons';

/**
 * Read-only view of the media a customer attached to their brief.
 *
 * This is what makes the price an informed one: the craftsman sees the wall,
 * the leak or the damaged tile before quoting, instead of pricing a sentence.
 * Rendered on both the customer's own request and the provider's offer screen,
 * from the same `request.media` rows, so the two never drift.
 *
 * A row's `kind` decides the element — photos open in a full-size overlay and a
 * video plays inline. Anything that is not renderable media stays a plain link,
 * so an unknown kind can never break the screen.
 */
export function JobMediaGallery({
  media,
  title,
}: {
  media: Array<{ id: string; url: string; kind: string }>;
  title?: string;
}) {
  const { t } = useI18n();
  const [zoomed, setZoomed] = useState<string | null>(null);

  if (media.length === 0) return null;

  const videos = media.filter((m) => m.kind === 'VIDEO');
  const photos = media.filter((m) => m.kind === 'IMAGE' || m.kind === 'AUDIO');
  const other = media.filter(
    (m) => m.kind !== 'IMAGE' && m.kind !== 'VIDEO' && m.kind !== 'AUDIO',
  );

  return (
    <div className="card mb-4 p-4">
      <h2 className="label flex items-center gap-2">
        <CategoryIcon name="camera" size={16} />
        {title ?? t('media.attachedTitle')}
      </h2>

      {photos.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          {photos.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setZoomed(m.url)}
              className="overflow-hidden rounded-xl"
              style={{ border: '1px solid rgb(var(--line))' }}
              aria-label={t('media.enlarge')}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={m.url} alt="" className="h-24 w-24 object-cover" />
            </button>
          ))}
        </div>
      )}

      {videos.map((m) => (
        <div key={m.id} className="mt-3">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
          <video
            src={m.url}
            className="w-full rounded-xl"
            style={{ border: '1px solid rgb(var(--line))', maxHeight: 320 }}
            controls
            playsInline
          />
        </div>
      ))}

      {other.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {other.map((m) => (
            <a key={m.id} href={m.url} target="_blank" rel="noreferrer" className="chip chip-neutral">
              {m.kind}
            </a>
          ))}
        </div>
      )}

      {zoomed && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          style={{ background: 'rgb(0 0 0 / 0.88)' }}
          onClick={() => setZoomed(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoomed} alt="" className="max-h-full max-w-full rounded-xl object-contain" />
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={() => setZoomed(null)}
            className="absolute end-4 top-4 flex h-10 w-10 items-center justify-center rounded-full text-white"
            style={{ background: 'rgb(255 255 255 / 0.18)' }}
          >
            <CategoryIcon name="x" size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

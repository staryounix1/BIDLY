'use client';

import { useId, useState } from 'react';
import { useI18n } from './i18n-provider';
import { CategoryIcon } from './icons';

/**
 * Before/after job photos.
 *
 * Photos are the evidence trail the spec wants for disputes, so both sides can
 * see them on a finished job. There is no binary upload service: the browser
 * downscales the picture and sends a compact JPEG data URL, exactly like the
 * identity documents. Swapping in object storage later only changes this file.
 */

const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.72;
const MAX_PHOTOS = 6;
/** Keep the request body sane: ~6 photos of this size stay well under 1 MB. */
const MAX_BYTES = 900_000;

async function toCompressedDataUrl(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas unavailable');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', JPEG_QUALITY);
}

function approxBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  return Math.round(((dataUrl.length - comma - 1) * 3) / 4);
}

/** Thumbnail strip + a picker. Used both to capture and to review photos. */
export function JobPhotos({
  photos,
  onChange,
  readOnly = false,
  label,
  hint,
}: {
  photos: string[];
  onChange?: (next: string[]) => void;
  readOnly?: boolean;
  label?: string;
  hint?: string;
}) {
  const { t } = useI18n();
  const inputId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pick(files: FileList | null) {
    if (!files?.length || !onChange) return;
    setError(null);
    setBusy(true);
    try {
      const next = [...photos];
      const budget = photos.reduce((n, p) => n + approxBytes(p), 0);
      let spent = budget;
      for (const file of Array.from(files).slice(0, MAX_PHOTOS - next.length)) {
        const dataUrl = await toCompressedDataUrl(file);
        const size = approxBytes(dataUrl);
        if (spent + size > MAX_BYTES) {
          setError(t('photos.tooBig'));
          break;
        }
        next.push(dataUrl);
        spent += size;
      }
      onChange(next);
    } catch {
      setError(t('photos.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold" style={{ color: 'rgb(var(--fg-muted))' }}>
          {label ?? t('photos.before')}
        </span>
        {!readOnly && onChange && (
          <span className="text-xs tnum" style={{ color: 'rgb(var(--fg-subtle))' }}>
            {photos.length}/{MAX_PHOTOS}
          </span>
        )}
      </div>

      {hint && (
        <p className="mb-2 text-xs" style={{ color: 'rgb(var(--fg-subtle))' }}>{hint}</p>
      )}

      <div className="flex flex-wrap gap-2">
        {photos.map((src, i) => (
          <div key={i} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              className="h-20 w-20 rounded-xl object-cover"
              style={{ border: '1px solid rgb(var(--line))' }}
            />
            {!readOnly && onChange && (
              <button
                type="button"
                aria-label={t('photos.remove')}
                onClick={() => onChange(photos.filter((_, j) => j !== i))}
                className="absolute -end-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full"
                style={{ background: 'rgb(var(--danger))', color: '#fff' }}
              >
                <CategoryIcon name="x" size={12} />
              </button>
            )}
          </div>
        ))}

        {!readOnly && onChange && photos.length < MAX_PHOTOS && (
          <label
            htmlFor={inputId}
            className="flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl text-xs font-semibold"
            style={{
              border: '1.5px dashed rgb(var(--line-strong))',
              color: 'rgb(var(--fg-muted))',
            }}
          >
            {busy ? <span className="tnum">…</span> : (
              <>
                <CategoryIcon name="camera" size={18} />
                {t('photos.add')}
              </>
            )}
            <input
              id={inputId}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="hidden"
              onChange={(e) => void pick(e.target.files)}
            />
          </label>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs font-semibold" style={{ color: 'rgb(var(--danger))' }}>{error}</p>
      )}
    </div>
  );
}

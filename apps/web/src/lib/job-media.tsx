'use client';

import { useId, useState } from 'react';
import { useI18n } from './i18n-provider';
import { CategoryIcon } from './icons';

/**
 * Job media — photos and a short video, captured by the customer when they
 * describe the problem.
 *
 * The craftsman's price is the point of this: a wall that needs plastering and
 * a wall that needs washing look identical in words and completely different in
 * a photo, so the brief travels with evidence and the offer is priced against
 * what is actually there. Nothing here is a link field — the customer picks
 * files from their phone and the browser does the work, which is the only
 * interaction that is realistic on a phone camera roll.
 *
 * There is no binary upload service yet (see `job-photos.tsx`): photos are
 * downscaled to a compact JPEG data URL and the video is kept only if it fits
 * the request body, so the API's `mediaUrls` array carries everything and
 * swapping in object storage later changes only this file.
 */

const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.72;
const MAX_PHOTOS = 6;
/** Photos ride in `mediaUrls`; ~6 of this size stay well under 1 MB total. */
const MAX_PHOTO_BYTES = 900_000;
/** Videos are far heavier, so one short clip with a hard ceiling. */
const MAX_VIDEO_BYTES = 2_400_000;
const MAX_VIDEO_SECONDS = 20;

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

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/** Video duration, read from metadata so an over-long clip is refused up front. */
function videoDuration(file: File): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    el.preload = 'metadata';
    el.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(el.duration) ? el.duration : 0);
    };
    el.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(0);
    };
    el.src = url;
  });
}

export function JobMedia({
  photos,
  video,
  onPhotosChange,
  onVideoChange,
}: {
  photos: string[];
  video: string | null;
  onPhotosChange: (next: string[]) => void;
  onVideoChange: (next: string | null) => void;
}) {
  const { t } = useI18n();
  const photoId = useId();
  const videoId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pickPhotos(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setBusy(true);
    try {
      const next = [...photos];
      let spent = photos.reduce((n, p) => n + approxBytes(p), 0);
      for (const file of Array.from(files).slice(0, MAX_PHOTOS - next.length)) {
        const dataUrl = await toCompressedDataUrl(file);
        const size = approxBytes(dataUrl);
        if (spent + size > MAX_PHOTO_BYTES) {
          setError(t('media.photoTooBig'));
          break;
        }
        next.push(dataUrl);
        spent += size;
      }
      onPhotosChange(next);
    } catch {
      setError(t('media.failed'));
    } finally {
      setBusy(false);
    }
  }

  async function pickVideo(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const seconds = await videoDuration(file);
      if (seconds && seconds > MAX_VIDEO_SECONDS + 1) {
        setError(t('media.videoTooLong', { seconds: MAX_VIDEO_SECONDS }));
        return;
      }
      const dataUrl = await fileToDataUrl(file);
      if (approxBytes(dataUrl) > MAX_VIDEO_BYTES) {
        setError(t('media.videoTooBig'));
        return;
      }
      onVideoChange(dataUrl);
    } catch {
      setError(t('media.failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-[rgb(var(--line))] p-3.5">
      <div className="mb-1 flex items-start gap-2">
        <span className="mt-0.5 text-[rgb(var(--accent))]">
          <CategoryIcon name="camera" size={17} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-bold">{t('media.title')}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-[rgb(var(--fg-subtle))]">
            {t('media.hint')}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {photos.map((src, i) => (
          <div key={i} className="relative">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              className="h-20 w-20 rounded-xl object-cover"
              style={{ border: '1px solid rgb(var(--line))' }}
            />
            <button
              type="button"
              aria-label={t('media.remove')}
              onClick={() => onPhotosChange(photos.filter((_, j) => j !== i))}
              className="absolute -end-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full"
              style={{ background: 'rgb(var(--danger))', color: '#fff' }}
            >
              <CategoryIcon name="x" size={12} />
            </button>
          </div>
        ))}

        {photos.length < MAX_PHOTOS && (
          <label
            htmlFor={photoId}
            className="flex h-20 w-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl text-xs font-semibold"
            style={{
              border: '1.5px dashed rgb(var(--line-strong))',
              color: 'rgb(var(--fg-muted))',
            }}
          >
            {busy ? (
              <span className="tnum">…</span>
            ) : (
              <>
                <CategoryIcon name="camera" size={18} />
                {t('media.addPhoto')}
                <span className="tnum text-[10px] text-[rgb(var(--fg-subtle))]">
                  {photos.length}/{MAX_PHOTOS}
                </span>
              </>
            )}
            <input
              id={photoId}
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              className="hidden"
              onChange={(e) => {
                void pickPhotos(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>

      {/* Video: one clip, or none. A poster frame is not available without
          decoding the file, so this shows a compact "attached" row with a
          play-through preview instead of a thumbnail. */}
      <div className="mt-3">
        {video ? (
          <div className="flex items-center gap-2.5 rounded-xl border border-[rgb(var(--line))] p-2">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video src={video} className="h-14 w-20 rounded-lg object-cover" muted playsInline />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold">
              {t('media.videoAttached')}
            </span>
            <button
              type="button"
              aria-label={t('media.remove')}
              onClick={() => onVideoChange(null)}
              className="flex h-7 w-7 flex-none items-center justify-center rounded-full"
              style={{ background: 'rgb(var(--danger))', color: '#fff' }}
            >
              <CategoryIcon name="x" size={13} />
            </button>
          </div>
        ) : (
          <label
            htmlFor={videoId}
            className="flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2.5 text-xs font-semibold"
            style={{
              border: '1.5px dashed rgb(var(--line-strong))',
              color: 'rgb(var(--fg-muted))',
            }}
          >
            <CategoryIcon name="play" size={16} />
            {busy ? t('common.loading') : t('media.addVideo', { seconds: MAX_VIDEO_SECONDS })}
            <input
              id={videoId}
              type="file"
              accept="video/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                void pickVideo(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>

      {error && (
        <p className="mt-2 text-xs font-semibold" style={{ color: 'rgb(var(--danger))' }}>
          {error}
        </p>
      )}
    </div>
  );
}

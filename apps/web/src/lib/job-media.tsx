'use client';

import { useId, useState } from 'react';
import { useI18n } from './i18n-provider';
import { CategoryIcon } from './icons';
import { mediaApi } from './media-api';

/**
 * Job media — photos and a video, captured by the customer when they describe
 * the problem.
 *
 * The craftsman's price is the point of this: a wall that needs plastering and
 * a wall that needs washing look identical in words and completely different in
 * a photo, so the brief travels with evidence and the offer is priced against
 * what is actually there. Nothing here is a link field — the customer picks
 * files from their phone or computer, which is the only interaction that is
 * realistic on a camera roll.
 *
 * **Everything here is optional.** A request with no photos and no video is a
 * perfectly good request, so nothing in this file is ever allowed to block
 * submission; a failure to attach a file reports itself and leaves the rest of
 * the brief alone.
 *
 * Photos are downscaled to a compact JPEG and sent as a data URL in the request
 * body, because at that size it is simpler than a round trip. A video is posted
 * as its own bytes to `/media` and comes back as a URL, because the API's JSON
 * body cap could never hold a clip.
 */

const MAX_EDGE = 1280;
const JPEG_QUALITY = 0.72;
const MAX_PHOTOS = 6;
/** Photos ride inside the JSON body, so keep the total well under its cap. */
const MAX_PHOTO_BYTES = 900_000;

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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function JobMedia({
  photos,
  video,
  onPhotosChange,
  onVideoChange,
  onUploadingChange,
}: {
  photos: string[];
  /** A URL once uploaded, or a local object URL while it is still going up. */
  video: string | null;
  onPhotosChange: (next: string[]) => void;
  onVideoChange: (next: string | null) => void;
  /** Lets the tray hold the send button while a clip is still uploading. */
  onUploadingChange?: (uploading: boolean) => void;
}) {
  const { t } = useI18n();
  const photoId = useId();
  const videoId = useId();
  const [busyPhotos, setBusyPhotos] = useState(false);
  const [videoState, setVideoState] = useState<{ name: string; size: number } | null>(null);
  const [progress, setProgress] = useState<'idle' | 'uploading' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function pickPhotos(files: FileList | null) {
    if (!files?.length) return;
    setError(null);
    setBusyPhotos(true);
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
      setBusyPhotos(false);
    }
  }

  /**
   * A video of any size: the file goes to the server as bytes, so there is no
   * client-side ceiling to hit. The row shows locally the moment it is picked,
   * then keeps that preview until the returned URL replaces it.
   */
  async function pickVideo(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setError(null);
    const localPreview = URL.createObjectURL(file);
    setVideoState({ name: file.name, size: file.size });
    setProgress('uploading');
    onUploadingChange?.(true);
    try {
      const { url } = await mediaApi.upload(file);
      URL.revokeObjectURL(localPreview);
      onVideoChange(url);
      setProgress('done');
    } catch {
      URL.revokeObjectURL(localPreview);
      setVideoState(null);
      setProgress('idle');
      setError(t('media.uploadFailed'));
    } finally {
      onUploadingChange?.(false);
    }
  }

  function clearVideo() {
    onVideoChange(null);
    setVideoState(null);
    setProgress('idle');
    setError(null);
  }

  const showVideoRow = Boolean(video) || Boolean(videoState);

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
          <p className="mt-1 flex items-center gap-1.5 text-[11px] font-semibold text-[rgb(var(--accent))]">
            <CategoryIcon name="upload" size={13} />
            {t('media.optional')}
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
            {busyPhotos ? (
              <span className="tnum">…</span>
            ) : (
              <>
                <CategoryIcon name="upload" size={18} />
                {t('media.addPhoto')}
                <span className="tnum text-[10px] text-[rgb(var(--fg-subtle))]">
                  {photos.length}/{MAX_PHOTOS}
                </span>
              </>
            )}
            <input
              id={photoId}
              type="file"
              // No `capture` attribute: on a phone that attribute forces the
              // camera open and hides the gallery, so a customer who already
              // has a photo of the wall could not pick it. Without it the OS
              // offers both "take a photo" and "choose from files".
              accept="image/*,.heic,.heif"
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

      {/* Video: one clip, any size. While it uploads the local preview is shown
          so the pick feels instant, then the server URL takes over. */}
      <div className="mt-3">
        {showVideoRow ? (
          <div className="flex items-center gap-2.5 rounded-xl border border-[rgb(var(--line))] p-2">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              src={video ?? undefined}
              className="h-14 w-20 rounded-lg object-cover"
              muted
              playsInline
            />
            <span className="min-w-0 flex-1 truncate text-xs font-semibold">
              {progress === 'uploading'
                ? `${t('media.uploading')} — ${videoState ? formatSize(videoState.size) : ''}`
                : videoState?.name || t('media.videoAttached')}
            </span>
            {progress === 'uploading' ? (
              <span className="tnum flex-none text-[11px] text-[rgb(var(--fg-subtle))]">…</span>
            ) : (
              <button
                type="button"
                aria-label={t('media.remove')}
                onClick={clearVideo}
                className="flex h-7 w-7 flex-none items-center justify-center rounded-full"
                style={{ background: 'rgb(var(--danger))', color: '#fff' }}
              >
                <CategoryIcon name="x" size={13} />
              </button>
            )}
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
            <CategoryIcon name="upload" size={16} />
            {t('media.addVideo')}
            <input
              id={videoId}
              type="file"
              accept="video/*"
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

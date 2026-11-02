import { inspectMp4, inspectWebm, sniffKind } from '../../../frontend/src/lib/media-sniff.js';

export const MEDIA_MIME_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/quicktime', 'video/webm',
]);
export const MEDIA_MB = 1024 * 1024;

export interface MediaLimits {
  imageMB: number;
  gifMB: number;
  videoMB: number;
  videoSec: number;
  quotaMB: number;
}

export interface R2ObjectLike {
  body: ReadableStream<Uint8Array>;
  size: number;
  httpMetadata?: { contentType?: string };
  httpEtag?: string;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  head(key: string): Promise<{ size: number } | null>;
  put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  delete(key: string): Promise<void>;
}

export interface MediaEnvironment {
  MEDIA_BUCKET?: R2BucketLike;
  MEDIA_IMAGE_MB?: string;
  MEDIA_GIF_MB?: string;
  MEDIA_VIDEO_MB?: string;
  MEDIA_QUOTA_MB?: string;
}

const positiveSetting = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const mediaConfig = (env: MediaEnvironment): MediaLimits => ({
  imageMB: positiveSetting(env.MEDIA_IMAGE_MB, 2),
  gifMB: positiveSetting(env.MEDIA_GIF_MB, 8),
  videoMB: positiveSetting(env.MEDIA_VIDEO_MB, 40),
  videoSec: 60,
  quotaMB: env.MEDIA_QUOTA_MB !== undefined && env.MEDIA_QUOTA_MB.trim() !== ''
    && Number.isFinite(Number(env.MEDIA_QUOTA_MB)) && Number(env.MEDIA_QUOTA_MB) >= 0
    ? Number(env.MEDIA_QUOTA_MB)
    : 200,
});

export const detectMediaMime = (bytes: Uint8Array): string | null => {
  const mime = sniffKind(bytes)?.mime;
  return mime && MEDIA_MIME_TYPES.has(mime) ? mime : null;
};

export const validateMediaPayload = (bytes: Uint8Array, declaredMime: string, limits: MediaLimits): string | null => {
  if (!MEDIA_MIME_TYPES.has(declaredMime)) return 'unsupported_media_type';
  if (detectMediaMime(bytes) !== declaredMime) return 'media_type_mismatch';
  if (declaredMime.startsWith('video/')) {
    const inspection = declaredMime === 'video/webm' ? inspectWebm(bytes) : inspectMp4(bytes);
    if (!inspection) return 'invalid_media';
    if (inspection.durationSec !== null && inspection.durationSec > limits.videoSec + 1) return 'media_too_long';
  }
  return null;
};

export const mediaLimitBytes = (mime: string, limits: MediaLimits): number => {
  const mb = mime === 'image/gif' ? limits.gifMB : mime.startsWith('video/') ? limits.videoMB : limits.imageMB;
  return Math.floor(mb * MEDIA_MB);
};

export const readBoundedBytes = async (request: Request, limit: number): Promise<Uint8Array | null> => {
  const announced = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(announced) && announced > limit) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
};

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const input = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(input).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

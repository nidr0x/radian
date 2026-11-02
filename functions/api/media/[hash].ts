import { enforceAuthRateLimit, getAuthenticatedContext, json, randomId } from '../../lib/auth';
import { MEDIA_MIME_TYPES, mediaConfig, mediaLimitBytes, MEDIA_MB, readBoundedBytes, sha256Hex, validateMediaPayload, type MediaEnvironment, type R2BucketLike } from '../../lib/media/objects';
import type { SyncContext } from '../../types';

interface MediaContext extends SyncContext {
  env: SyncContext['env'] & MediaEnvironment & { MEDIA_BUCKET?: R2BucketLike };
  params?: Record<string, string>;
}

interface MediaRow { objectKey: string; mimeType: string; byteSize: number; sha256: string }

const mediaId = (context: MediaContext): string => context.params?.hash ?? new URL(context.request.url).pathname.split('/').pop() ?? '';
const validHash = (value: string): boolean => /^[a-f\d]{64}$/.test(value);

const ownerMedia = (database: NonNullable<SyncContext['env']['DB']>, accountId: string, id: string): Promise<MediaRow | null> => database.prepare(
  'SELECT object_key AS objectKey, mime_type AS mimeType, byte_size AS byteSize, sha256 FROM gym_media_objects WHERE account_id = ? AND media_id = ?',
).bind(accountId, id).first<MediaRow>();

export const onRequestGet = async (context: MediaContext): Promise<Response> => {
  const id = mediaId(context);
  if (!validHash(id)) return json({ error: 'invalid_media_id' }, 400);
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const bucket = context.env.MEDIA_BUCKET;
  if (!bucket) return json({ error: 'media_unavailable' }, 503);
  const row = await ownerMedia(authenticated.env.DB!, authenticated.user.id, id);
  if (!row) return json({ error: 'media_missing' }, 404);
  const object = await bucket.get(row.objectKey);
  if (!object || object.size !== row.byteSize) return json({ error: 'media_missing' }, 404);
  return new Response(object.body, { headers: {
    'Cache-Control': 'private, max-age=0, must-revalidate',
    'Content-Length': String(row.byteSize),
    'Content-Type': row.mimeType,
    'ETag': object.httpEtag ? `"${object.httpEtag}"` : `"${row.sha256}"`,
    'X-Content-Type-Options': 'nosniff',
  } });
};

export const onRequestPut = async (context: MediaContext): Promise<Response> => {
  const id = mediaId(context);
  if (!validHash(id)) return json({ error: 'invalid_media_id' }, 400);
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'media-put', authenticated.user.id);
  if (limited) return limited;
  const bucket = context.env.MEDIA_BUCKET;
  if (!bucket) return json({ error: 'media_unavailable' }, 503);

  const declaredMime = context.request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
  if (!MEDIA_MIME_TYPES.has(declaredMime)) return json({ error: 'unsupported_media_type' }, 415);
  const limits = mediaConfig(context.env);
  const bytes = await readBoundedBytes(context.request, mediaLimitBytes(declaredMime, limits));
  if (!bytes) return json({ error: 'media_too_large' }, 413);
  const mediaError = validateMediaPayload(bytes, declaredMime, limits);
  if (mediaError) return json({ error: mediaError }, mediaError === 'media_too_long' ? 413 : mediaError === 'media_type_mismatch' || mediaError === 'unsupported_media_type' ? 415 : 400);
  if (await sha256Hex(bytes) !== id) return json({ error: 'media_hash_mismatch' }, 400);

  const database = authenticated.env.DB!;
  const existing = await ownerMedia(authenticated.env.DB!, authenticated.user.id, id);
  const quotaBytes = Math.floor(limits.quotaMB * MEDIA_MB);
  const objectKey = existing?.objectKey ?? `media/${randomId(24)}`;
  const deleteUnreservedObject = async (): Promise<void> => {
    if (!existing) await bucket.delete(objectKey).catch(() => {});
  };
  const cleanupCandidate = async (): Promise<void> => {
    if (existing) return;
    try {
      const referenced = await ownerMedia(database, authenticated.user.id, id);
      if (referenced?.objectKey !== objectKey) await bucket.delete(objectKey).catch(() => {});
    } catch { /* Keep an object if D1 cannot prove that it is unreferenced. */ }
  };
  try {
    await bucket.put(objectKey, bytes, { httpMetadata: { contentType: declaredMime }, customMetadata: { sha256: id } });
  } catch {
    await deleteUnreservedObject();
    return json({ error: 'media_store_failed' }, 503);
  }
  try {
    const reservation = await database.prepare(
      `INSERT INTO gym_media_objects (account_id, media_id, object_key, sha256, mime_type, byte_size, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?
       WHERE ? <= 0
          OR EXISTS (SELECT 1 FROM gym_media_objects WHERE account_id = ? AND media_id = ? AND byte_size = ?)
          OR COALESCE((SELECT SUM(byte_size) FROM gym_media_objects WHERE account_id = ? AND media_id <> ?), 0) + ? <= ?
       ON CONFLICT(account_id, media_id) DO UPDATE SET
         sha256 = excluded.sha256, mime_type = excluded.mime_type,
         byte_size = excluded.byte_size, created_at = excluded.created_at`,
    ).bind(authenticated.user.id, id, objectKey, id, declaredMime, bytes.byteLength, new Date().toISOString(),
      quotaBytes, authenticated.user.id, id, bytes.byteLength, authenticated.user.id, id, bytes.byteLength, quotaBytes).run();
    if (Number(reservation.meta?.changes ?? 0) === 0) {
      await deleteUnreservedObject();
      const usage = await database.prepare(
        'SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM gym_media_objects WHERE account_id = ?',
      ).bind(authenticated.user.id).first<{ bytes: number }>();
      return json({ error: 'media_quota_exceeded', usage: { bytes: Number(usage?.bytes ?? 0), quotaBytes } }, 413);
    }
    const winner = await ownerMedia(authenticated.env.DB!, authenticated.user.id, id);
    if (!winner) throw new Error('media_metadata_missing');
    if (winner.objectKey !== objectKey) await bucket.delete(objectKey).catch(() => {});
  } catch {
    await cleanupCandidate();
    return json({ error: 'media_store_failed' }, 503);
  }
  return json({ stored: true, hash: id, size: bytes.byteLength });
};

export const onRequestOptions = async (_context: MediaContext): Promise<Response> => new Response(null, { status: 204 });

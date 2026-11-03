import { enforceAuthRateLimit, getAuthenticatedContext, isRecord, json } from '../../lib/auth';
import { readSmallText } from '../../lib/radian-api/request';
import { mediaConfig, MEDIA_MB, type MediaEnvironment } from '../../lib/media/objects';
import type { SyncContext } from '../../types';

interface MediaContext extends SyncContext { env: SyncContext['env'] & MediaEnvironment }

const boundedJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  const text = await readSmallText(request, 12_000);
  if (!text.ok) return null;
  try { const body: unknown = JSON.parse(text.value); return isRecord(body) ? body : null; } catch { return null; }
};

export const onRequestPost = async (context: MediaContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'media-missing', authenticated.user.id);
  if (limited) return limited;
  if (!context.env.MEDIA_BUCKET) return json({ error: 'media_unavailable' }, 503);
  const body = await boundedJson(context.request);
  if (!body) return json({ error: 'invalid_media_hashes' }, 400);
  const hashes = body.hashes;
  if (!Array.isArray(hashes) || hashes.length > 100 || hashes.some((value) => typeof value !== 'string' || !/^[a-f\d]{64}$/.test(value))) {
    return json({ error: 'invalid_media_hashes' }, 400);
  }
  const unique = [...new Set(hashes as string[])];
  const missing: string[] = [];
  for (const hash of unique) {
    const row = await authenticated.env.DB!.prepare(
      'SELECT object_key AS objectKey FROM gym_media_objects WHERE account_id = ? AND media_id = ?',
    ).bind(authenticated.user.id, hash).first<{ objectKey: string }>();
    if (!row || !(await context.env.MEDIA_BUCKET.head(row.objectKey))) missing.push(hash);
  }
  const usage = await authenticated.env.DB!.prepare(
    'SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM gym_media_objects WHERE account_id = ?',
  ).bind(authenticated.user.id).first<{ bytes: number }>();
  const limits = mediaConfig(context.env);
  return json({ missing, usage: { bytes: Number(usage?.bytes ?? 0), quotaBytes: limits.quotaMB * MEDIA_MB } });
};

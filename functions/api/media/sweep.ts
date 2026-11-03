import { enforceAuthRateLimit, getAuthenticatedContext, json } from '../../lib/auth';
import { readGymState } from '../../lib/db/radian/state';
import type { SyncContext } from '../../types';
import type { MediaEnvironment } from '../../lib/media/objects';

interface MediaContext extends SyncContext { env: SyncContext['env'] & MediaEnvironment }
interface MediaRow { mediaId: string; objectKey: string; createdAt: string }

const hashesIn = (value: unknown, found = new Set<string>()): Set<string> => {
  if (typeof value === 'string' && /^[a-f\d]{64}$/.test(value)) found.add(value);
  else if (Array.isArray(value)) for (const item of value) hashesIn(item, found);
  else if (typeof value === 'object' && value !== null) for (const item of Object.values(value)) hashesIn(item, found);
  return found;
};

export const onRequestPost = async (context: MediaContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'media-sweep', authenticated.user.id);
  if (limited) return limited;
  const bucket = context.env.MEDIA_BUCKET;
  if (!bucket) return json({ error: 'media_unavailable' }, 503);

  const snapshot = await readGymState(authenticated.env.DB!, authenticated.user.id);
  const referenced = hashesIn(snapshot.state);
  const rows = await authenticated.env.DB!.prepare(
    `SELECT media_id AS mediaId, object_key AS objectKey, created_at AS createdAt
       FROM gym_media_objects WHERE account_id = ? AND created_at < ? LIMIT 500`,
  ).bind(authenticated.user.id, new Date(Date.now() - 60 * 60 * 1000).toISOString()).all<MediaRow>();

  let removed = 0;
  for (const row of rows.results) {
    if (referenced.has(row.mediaId)) continue;
    const [deleted] = await authenticated.env.DB!.batch([
      authenticated.env.DB!.prepare(
        `DELETE FROM gym_media_objects
          WHERE account_id = ? AND media_id = ? AND object_key = ? AND created_at = ?
            AND EXISTS (SELECT 1 FROM gym_sync_state WHERE account_id = ? AND revision = ?)
            AND NOT EXISTS (SELECT 1 FROM gym_media_references WHERE account_id = ? AND media_id = ?)`
      ).bind(authenticated.user.id, row.mediaId, row.objectKey, row.createdAt, authenticated.user.id, snapshot.rev, authenticated.user.id, row.mediaId),
      authenticated.env.DB!.prepare(
        `INSERT OR IGNORE INTO gym_media_cleanup_objects (object_key, queued_at)
         SELECT ?, ? WHERE changes() = 1`,
      ).bind(row.objectKey, new Date().toISOString()),
    ]);
    if ((deleted.meta?.changes ?? 0) !== 1) continue;
    removed++;
  }
  return json({ removed });
};

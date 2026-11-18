import { enforceAuthRateLimit, getAuthenticatedContext, json } from '../../lib/auth';
import { mediaHashesInState, readGymState } from '../../lib/db/radian/state';
import type { SyncContext } from '../../types';
import type { MediaEnvironment } from '../../lib/media/objects';

interface MediaContext extends SyncContext { env: SyncContext['env'] & MediaEnvironment }
export const onRequestPost = async (context: MediaContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'media-sweep', authenticated.user.id);
  if (limited) return limited;
  const bucket = context.env.MEDIA_BUCKET;
  if (!bucket) return json({ error: 'media_unavailable' }, 503);

  const snapshot = await readGymState(authenticated.env.DB!, authenticated.user.id);
  const database = authenticated.env.DB!;
  const now = new Date().toISOString();
  const hashes = [...mediaHashesInState(snapshot.state)];
  const guard = `EXISTS (SELECT 1 FROM gym_sync_state WHERE account_id = ? AND revision = ? AND write_id IS ?)`;
  const results = await database.batch([
    database.prepare(
      `DELETE FROM gym_media_references WHERE account_id = ? AND owner_type = 'state' AND owner_id = 'document'
        AND media_id NOT IN (SELECT value FROM json_each(?)) AND ${guard}`,
    ).bind(authenticated.user.id, JSON.stringify(hashes), authenticated.user.id, snapshot.rev, snapshot.wid),
    database.prepare(
      `INSERT OR IGNORE INTO gym_media_references (account_id, media_id, owner_type, owner_id)
       SELECT ?, item.value, 'state', 'document' FROM json_each(?) item
        WHERE EXISTS (SELECT 1 FROM gym_media_objects WHERE account_id = ? AND media_id = item.value) AND ${guard}`,
    ).bind(authenticated.user.id, JSON.stringify(hashes), authenticated.user.id, authenticated.user.id, snapshot.rev, snapshot.wid),
    database.prepare(
      `DELETE FROM gym_media_cleanup_objects WHERE object_key IN (
        SELECT m.object_key FROM gym_media_objects m JOIN gym_media_references r
          ON r.account_id = m.account_id AND r.media_id = m.media_id
         WHERE m.account_id = ? AND r.owner_type = 'state' AND r.owner_id = 'document'
       ) AND ${guard}`,
    ).bind(authenticated.user.id, authenticated.user.id, snapshot.rev, snapshot.wid),
    database.prepare(
      `INSERT OR IGNORE INTO gym_media_cleanup_objects (object_key, queued_at, not_before)
       SELECT m.object_key, ?, ? FROM gym_media_objects m
        WHERE m.account_id = ? AND m.created_at < ?
          AND NOT EXISTS (SELECT 1 FROM gym_media_references r WHERE r.account_id = m.account_id AND r.media_id = m.media_id)
          AND ${guard}`,
    ).bind(now, new Date(Date.parse(now) + 24 * 60 * 60 * 1000).toISOString(), authenticated.user.id,
      new Date(Date.now() - 60 * 60 * 1000).toISOString(), authenticated.user.id, snapshot.rev, snapshot.wid),
  ]);
  return json({ queued: Number(results[3]?.meta?.changes ?? 0) });
};

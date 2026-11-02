import type { D1DatabaseLike } from '../../types';

export interface MediaCleanupBucket { delete(key: string): Promise<void> }
interface CleanupRow { objectKey: string }

export const drainMediaCleanup = async (
  database: D1DatabaseLike,
  bucket: MediaCleanupBucket,
  requestedLimit = 100,
): Promise<{ deleted: number; failed: number }> => {
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 500)) : 100;
  const rows = await database.prepare(
    'SELECT object_key AS objectKey FROM gym_media_cleanup_objects ORDER BY queued_at, object_key LIMIT ?',
  ).bind(limit).all<CleanupRow>();
  let deleted = 0;
  let failed = 0;
  for (const row of rows.results) {
    try {
      await bucket.delete(row.objectKey);
      await database.prepare('DELETE FROM gym_media_cleanup_objects WHERE object_key = ?').bind(row.objectKey).run();
      deleted++;
    } catch {
      await database.prepare(
        `UPDATE gym_media_cleanup_objects SET attempts = attempts + 1, last_error = 'delete_failed' WHERE object_key = ?`,
      ).bind(row.objectKey).run().catch(() => {});
      failed++;
    }
  }
  return { deleted, failed };
};

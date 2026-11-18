import type { D1DatabaseLike } from '../../types';

export interface MediaCleanupBucket { delete(key: string): Promise<void> }
interface CleanupRow { objectKey: string }
// A terminated scheduled worker must not leave a media reference blocked forever.
const CLAIM_LEASE_MS = 5 * 60 * 1000

export const drainMediaCleanup = async (
  database: D1DatabaseLike,
  bucket: MediaCleanupBucket,
  requestedLimit = 100,
): Promise<{ deleted: number; failed: number }> => {
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 500)) : 100;
  const now = new Date().toISOString();
  const staleClaimBefore = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
  const rows = await database.prepare(
    `SELECT object_key AS objectKey FROM gym_media_cleanup_objects
      WHERE not_before <= ? AND (deleting_at IS NULL OR deleting_at <= ?)
      ORDER BY not_before, queued_at, object_key LIMIT ?`,
  ).bind(now, staleClaimBefore, limit).all<CleanupRow>();
  let deleted = 0;
  let failed = 0;
  for (const row of rows.results) {
    const claimedAt = new Date().toISOString();
    const claim = await database.prepare(
      `UPDATE gym_media_cleanup_objects SET deleting_at = ?
        WHERE object_key = ? AND not_before <= ? AND (deleting_at IS NULL OR deleting_at <= ?)
          AND NOT EXISTS (SELECT 1 FROM gym_media_objects m JOIN gym_media_references r
            ON r.account_id = m.account_id AND r.media_id = m.media_id WHERE m.object_key = gym_media_cleanup_objects.object_key)`,
    ).bind(claimedAt, row.objectKey, claimedAt, staleClaimBefore).run();
    if (Number(claim.meta?.changes ?? 0) !== 1) {
      await database.prepare(
        `DELETE FROM gym_media_cleanup_objects WHERE object_key = ? AND (deleting_at IS NULL OR deleting_at <= ?)
          AND EXISTS (SELECT 1 FROM gym_media_objects m JOIN gym_media_references r
            ON r.account_id = m.account_id AND r.media_id = m.media_id WHERE m.object_key = ?)`,
      ).bind(row.objectKey, staleClaimBefore, row.objectKey).run();
      continue;
    }
    try {
      const referenced = await database.prepare(
        `SELECT 1 AS present FROM gym_media_objects m JOIN gym_media_references r
          ON r.account_id = m.account_id AND r.media_id = m.media_id WHERE m.object_key = ? LIMIT 1`,
      ).bind(row.objectKey).first<{ present: number }>();
      if (referenced) {
        await database.prepare('DELETE FROM gym_media_cleanup_objects WHERE object_key = ? AND deleting_at = ?')
          .bind(row.objectKey, claimedAt).run();
        continue;
      }
      await bucket.delete(row.objectKey);
      await database.batch([
        database.prepare(
          `DELETE FROM gym_media_objects WHERE object_key = ? AND NOT EXISTS (
            SELECT 1 FROM gym_media_references r WHERE r.account_id = gym_media_objects.account_id AND r.media_id = gym_media_objects.media_id
          )`,
        ).bind(row.objectKey),
        database.prepare('DELETE FROM gym_media_cleanup_objects WHERE object_key = ? AND deleting_at = ?').bind(row.objectKey, claimedAt),
      ]);
      deleted++;
    } catch {
      await database.prepare(
        `UPDATE gym_media_cleanup_objects SET attempts = attempts + 1, last_error = 'delete_failed', deleting_at = NULL WHERE object_key = ? AND deleting_at = ?`,
      ).bind(row.objectKey, claimedAt).run().catch(() => {});
      failed++;
    }
  }
  return { deleted, failed };
};

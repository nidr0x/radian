import { afterEach, describe, expect, it } from 'vitest';
import { drainMediaCleanup } from '../functions/lib/radian-api/media-cleanup';
import { openTestDatabase } from './support/opengym-d1';

const databases: Array<ReturnType<typeof openTestDatabase>> = [];
const makeDatabase = () => {
  const value = openTestDatabase();
  databases.push(value);
  return value;
};

afterEach(() => { while (databases.length) databases.pop()?.database.close(); });

describe('cola de limpieza de medios eliminados', () => {
  it('borra objetos completados y conserva fallos para reintentar', async () => {
    const { database, d1 } = makeDatabase();
    database.prepare('INSERT INTO gym_media_cleanup_objects (object_key, queued_at) VALUES (?, ?), (?, ?)')
      .run('removed/photo', '2026-10-26T00:00:00.000Z', 'retry/video', '2026-10-26T00:00:01.000Z');
    const removed: string[] = [];
    const result = await drainMediaCleanup(d1, {
      delete: async (key) => {
        if (key.startsWith('retry/')) throw new Error('temporary');
        removed.push(key);
      },
    });
    const remaining = database.prepare('SELECT object_key AS objectKey, attempts, last_error AS lastError FROM gym_media_cleanup_objects').all() as Array<{ objectKey: string; attempts: number; lastError: string | null }>;

    expect(result).toEqual({ deleted: 1, failed: 1 });
    expect(removed).toEqual(['removed/photo']);
    expect(remaining).toEqual([{ objectKey: 'retry/video', attempts: 1, lastError: 'delete_failed' }]);
  });
});

import { describe, expect, it } from 'vitest';
import { cleanupExpiredOperationalRecords } from '../functions/lib/radian-api/retention-cleanup';
import { openTestDatabase } from './support/opengym-d1';

describe('retención de registros operativos', () => {
  it('purga por lotes, conserva claves dentro de su ventana y no toca trabajos activos', async () => {
    const { database, d1 } = openTestDatabase();
    try {
      const now = '2026-11-18T12:00:00.000Z';
      for (let index = 0; index < 25; index++) database.prepare(
        'INSERT INTO gym_sync_receipts (account_id, operation_id, fingerprint, revision, write_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('account-a', `old-${index}`, 'fingerprint', 1, `write-${index}`, '2026-01-01T00:00:00.000Z');
      database.prepare(
        'INSERT INTO gym_sync_receipts (account_id, operation_id, fingerprint, revision, write_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('account-a', 'recent', 'fingerprint', 1, 'write-recent', '2026-10-29T12:00:00.000Z');
      database.prepare('INSERT INTO gym_pair_tombstones (pair_id, revoked_at, retain_until) VALUES (?, ?, ?), (?, ?, ?)')
        .run('expired', '2025-01-01', '2026-01-01', 'retained', '2026-01-01', '2027-01-01');
      database.prepare(`INSERT INTO gym_durable_jobs
        (job_id, account_id, owner_type, owner_key, job_type, idempotency_key, status, payload_json, attempt, run_at, created_at, updated_at)
        VALUES (?, ?, 'account', ?, 'push', ?, ?, '{}', 0, ?, ?, ?), (?, ?, 'account', ?, 'push', ?, ?, '{}', 0, ?, ?, ?)`)
        .run('terminal-old', 'account-a', 'account-a', 'terminal-old', 'succeeded', now, '2026-01-01', '2026-01-01',
          'active-old', 'account-a', 'account-a', 'active-old', 'queued', now, '2026-01-01', '2026-01-01');

      const first = await cleanupExpiredOperationalRecords(d1, now, 10);
      expect(first.byTable.gym_sync_receipts).toBe(10);
      expect(first.byTable.gym_pair_tombstones).toBe(1);
      expect(first.byTable.gym_durable_jobs).toBe(1);
      expect(database.prepare('SELECT COUNT(*) AS count FROM gym_sync_receipts WHERE operation_id LIKE ?').get('old-%'))
        .toEqual({ count: 15 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM gym_sync_receipts WHERE operation_id = ?').get('recent'))
        .toEqual({ count: 1 });
      expect(database.prepare('SELECT job_id, status FROM gym_durable_jobs ORDER BY job_id').all())
        .toEqual([{ job_id: 'active-old', status: 'queued' }]);

      const next = await cleanupExpiredOperationalRecords(d1, now, 10);
      expect(next.byTable.gym_sync_receipts).toBe(10);
      expect(database.prepare('SELECT COUNT(*) AS count FROM gym_sync_receipts WHERE operation_id LIKE ?').get('old-%'))
        .toEqual({ count: 5 });
    } finally { database.close(); }
  });
});

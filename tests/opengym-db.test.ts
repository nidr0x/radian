import { describe, expect, it } from 'vitest';
import { readGymState, writeGymState } from '../functions/lib/db/radian/state';
import { openTestDatabase } from './support/opengym-d1';

const openDatabase = openTestDatabase;

describe('repositorio relacional openGym', () => {
  it('round-trips routines, workouts, sets and unknown top-level fields with a server revision', async () => {
    const { database, d1 } = openDatabase();
    try {
      const state = {
        unit: 'kg',
        lang: 'es',
        _ts: 1792972800000,
        routines: [{ id: 'routine-1', name: 'Empuje', days: ['mon'], ex: [{ id: '0025', sets: 3, reps: 8, note: 'agarre medio' }] }],
        workouts: [{ id: 'workout-1', d: '2026-10-26', start: 1792972800000, end: 1792976400000, entries: [{ id: '0025', name: 'press banca', sets: [{ w: 50, r: 8, done: true, rir: 2, source: 'manual' }] }] }],
        bodyweight: [{ d: '2026-10-26', w: 72.5, t: 1792972800000 }],
        measurements: [{ d: '2026-10-26', t: 1792972800000, values: { waist: 80 } }],
        customEx: [{ id: 'custom-1', name: 'Press propio', muscle: 'chest' }],
        favEx: ['0025', '0031'],
        equipProfiles: [{ id: 'home', name: 'Casa', equipment: ['dumbbell'] }],
        gymCards: [{ id: 'club', label: 'Club', value: '123456', fmt: 'code128' }],
        exNotes: { '0025': 'banco bajo' },
        exWeights: { '0025': { w: 50, d: '2026-10-26' } },
        active: { exercise: 'local-only' },
        futureSetting: { keep: true, values: ['a', 'b'] },
      };

      const written = await writeGymState(d1, 'account-a', { state, baseRev: 0 });

      expect(written).toMatchObject({ ok: true, rev: 1, replayed: false });
      const loaded = await readGymState(d1, 'account-a');
      const { active: _active, ...syncedState } = state;
      expect(loaded).toMatchObject({ state: { ...syncedState, _rev: 1, _wid: expect.any(String) }, rev: 1 });
      expect(loaded.state).not.toHaveProperty('active');

      const replay = await writeGymState(d1, 'account-a', { state, baseRev: 0 });
      expect(replay).toMatchObject({ ok: true, rev: 1, replayed: true });

      const update = await writeGymState(d1, 'account-a', { state: { unit: 'lb' }, baseRev: loaded.rev, baseWid: loaded.wid });
      expect(update).toMatchObject({ ok: true, rev: 2, replayed: false });
      expect((await readGymState(d1, 'account-a')).state).toMatchObject({ futureSetting: state.futureSetting, unit: 'lb' });
    } finally {
      database.close();
    }
  });

  it('leaves every entity unchanged when a stale base revision loses the CAS', async () => {
    const { database, d1 } = openDatabase();
    try {
      const original = { unit: 'kg', routines: [{ id: 'r1', name: 'Original', ex: [] }], workouts: [] };
      const first = await writeGymState(d1, 'account-a', { state: original, baseRev: 0 });
      expect(first.ok).toBe(true);

      const stale = await writeGymState(d1, 'account-a', { state: { ...original, routines: [{ id: 'r1', name: 'Overwritten', ex: [] }] }, baseRev: 0 });

      expect(stale).toMatchObject({ ok: false, conflict: { rev: 1 } });
      if (!('conflict' in stale)) throw new Error('La escritura obsoleta debía devolver el conflicto CAS.');
      expect(stale.conflict.state).toMatchObject({ routines: [{ id: 'r1', name: 'Original', ex: [] }] });
      expect(await readGymState(d1, 'account-a')).toMatchObject({ state: { ...original, _rev: 1, _wid: expect.any(String) }, rev: 1 });
    } finally {
      database.close();
    }
  });

  it('acepta baseRev sin baseWid y registra tombstones con la identidad canónica del peso', async () => {
    const { database, d1 } = openDatabase();
    try {
      const first = await writeGymState(d1, 'account-a', {
        state: { bodyweight: [{ d: '2026-10-26', t: 1792972800000, w: 72 }] },
        baseRev: 0,
      });
      expect(first.ok).toBe(true);

      const deleted = await writeGymState(d1, 'account-a', { state: { bodyweight: [] }, baseRev: 1 });

      expect(deleted).toMatchObject({ ok: true, rev: 2 });
      expect(database.prepare('SELECT entity_id FROM gym_sync_tombstones WHERE account_id = ? AND entity_type = ?')
        .get('account-a', 'bodyweight')).toEqual({ entity_id: '2026-10-26|1792972800000' });
    } finally {
      database.close();
    }
  });

  it('rejects oversized nested session data before creating account state', async () => {
    const { database, d1 } = openDatabase();
    try {
      const oversized = {
        workouts: [{ id: 'workout-1', d: '2026-10-26', entries: [{ id: '0025', sets: Array.from({ length: 501 }, () => ({ w: 20, r: 5 })) }] }],
      };

      expect(await writeGymState(d1, 'account-a', { state: oversized, baseRev: 0 })).toEqual({ ok: false, error: 'too_many_session_sets' });
      expect(await readGymState(d1, 'account-a')).toEqual({ state: null, rev: 0, wid: null, updatedAt: null, source: 'pwa' });
    } finally {
      database.close();
    }
  });

  it('keeps Coach proposals tied to a job owned by the same account', () => {
    const { database } = openDatabase();
    try {
      database.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').run('account-b', 'B', '2026-10-26T00:00:00.000Z');
      database.prepare(`INSERT INTO gym_durable_jobs
        (job_id, account_id, owner_type, owner_key, job_type, idempotency_key, status, payload_json, run_at, created_at, updated_at)
        VALUES (?, ?, 'account', ?, 'coach', ?, 'queued', '{}', ?, ?, ?)`)
        .run('job-a', 'account-a', 'account-a', 'job-key', '2026-10-26T12:00:00.000Z', '2026-10-26T12:00:00.000Z', '2026-10-26T12:00:00.000Z');

      expect(() => database.prepare(`INSERT INTO gym_coach_proposals
        (account_id, proposal_id, job_id, status, payload_json, created_at, updated_at)
        VALUES (?, ?, ?, 'pending', '{}', ?, ?)`)
        .run('account-b', 'proposal-b', 'job-a', '2026-10-26T12:00:00.000Z', '2026-10-26T12:00:00.000Z')).toThrow();
    } finally {
      database.close();
    }
  });

  it('permite como máximo un trabajo Coach activo por cuenta incluso ante inserciones concurrentes', async () => {
    const { database } = openDatabase();
    try {
      const insert = (jobId: string, key: string) => database.prepare(`INSERT OR IGNORE INTO gym_durable_jobs
        (job_id, account_id, owner_type, owner_key, job_type, idempotency_key, status, payload_json, run_at, created_at, updated_at)
        VALUES (?, 'account-a', 'account', 'account-a', 'coach', ?, 'queued', '{}', ?, ?, ?)`)
        .run(jobId, key, '2026-10-26T12:00:00.000Z', '2026-10-26T12:00:00.000Z', '2026-10-26T12:00:00.000Z');
      const results = await Promise.all([insert('coach-a', 'key-a'), insert('coach-b', 'key-b')]);

      expect(results.map((result) => Number(result.changes)).sort()).toEqual([0, 1]);
      expect(database.prepare(`SELECT job_id FROM gym_durable_jobs
        WHERE account_id = 'account-a' AND job_type = 'coach' AND status IN ('queued', 'running')`).all()).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it('recupera el recibo MCP de un restore sin cambios desde result_json', async () => {
    const { database, d1 } = openDatabase();
    try {
      const original = { routines: [{ id: 'routine-1', name: 'Original', ex: [] }] };
      const first = await writeGymState(d1, 'account-a', { state: original, baseRev: 0, baseWid: null });
      if (!first.ok) throw new Error('No se pudo preparar la revisión inicial.');
      const changed = await writeGymState(d1, 'account-a', {
        state: { routines: [{ id: 'routine-2', name: 'Cambiada', ex: [] }] }, baseRev: first.rev, baseWid: first.wid,
      });
      if (!changed.ok) throw new Error('No se pudo preparar la revisión modificada.');
      const applied = await writeGymState(d1, 'account-a', {
        state: original, replaceDocument: true, baseRev: changed.rev, baseWid: changed.wid,
        mcp: {
          operationId: 'restore-applied', clientId: 'mcp-client', fingerprint: 'fingerprint-applied',
          toolName: 'restore_revision', result: { rev: 3, wid: 'pending' }, summary: { kind: 'restore_revision' },
          eventId: 'event-applied', restoreRevisionId: first.wid,
        },
      });
      if (!applied.ok) throw new Error('No se pudo restaurar la revisión inicial.');
      const current = await readGymState(d1, 'account-a');
      const noOp = {
        state: original, replaceDocument: true, baseRev: current.rev, baseWid: current.wid,
        mcp: {
          operationId: 'restore-noop', clientId: 'mcp-client', fingerprint: 'fingerprint-noop',
          toolName: 'restore_revision', result: { rev: current.rev + 1, wid: 'pending' },
          summary: { kind: 'restore_revision' }, eventId: 'event-noop', restoreRevisionId: first.wid,
        },
      };

      expect(await writeGymState(d1, 'account-a', noOp)).toEqual({ ok: true, rev: current.rev, wid: current.wid, replayed: false });
      expect(await writeGymState(d1, 'account-a', noOp)).toEqual({ ok: true, rev: current.rev, wid: current.wid, replayed: true });
      const receipt = database.prepare(`SELECT result_json FROM gym_mcp_operations
        WHERE account_id = ? AND client_id = ? AND operation_id = ?`).get('account-a', 'mcp-client', 'restore-noop') as { result_json: string };
      expect(JSON.parse(receipt.result_json)).toMatchObject({ rev: current.rev, wid: current.wid, revisionId: current.wid });
      expect(database.prepare(`SELECT COUNT(*) AS count FROM gym_mcp_audit
        WHERE account_id = ? AND client_id = ? AND tool_name = ? AND outcome = 'nochange'`).get('account-a', 'mcp-client', 'restore_revision'))
        .toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });
});

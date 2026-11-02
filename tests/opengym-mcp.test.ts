import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readGymState, writeGymState } from '../functions/lib/db/radian/state';
import { onRadianMcpPost } from '../functions/lib/radian-api/mcp';
import { mergeStates } from '../frontend/src/lib/sync-merge.js';
import type { D1DatabaseLike } from '../functions/types';
import { openTestDatabase } from './support/opengym-d1';

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), rateLimit: vi.fn() }));
vi.mock('../functions/lib/mcpAuth', () => ({
  MCP_WRITE_SCOPE: 'radian:write',
  authenticateMcpRequest: mocks.authenticate,
  rateLimitMcp: mocks.rateLimit,
  hasMcpScope: (scope: string, wanted: string) => scope.split(/\s+/).includes(wanted),
  sha256: async (value: string) => createHash('sha256').update(value).digest('hex'),
  mcpJson: (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers }),
  mcpOptions: () => new Response(null, { status: 204 }),
}));

const rpc = (database: D1DatabaseLike, method: string, params: unknown) => onRadianMcpPost({
  request: new Request('https://opengym.local/api/mcp', {
    method: 'POST', headers: { Authorization: 'Bearer local-test' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }),
  env: { DB: database },
});
const call = (database: D1DatabaseLike, name: string, args: Record<string, unknown>) => rpc(database, 'tools/call', { name, arguments: args });
const value = async (response: Response) => {
  const body = await response.json() as any;
  if (!body.result) throw new Error(JSON.stringify(body));
  return body.result.structuredContent;
};

describe('MCP openGym sobre el repositorio normalizado', () => {
  it('publica las claves de idempotencia y cierra la ruta cuando el limitador rechaza o falla', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    try {
      const listed = await rpc(d1, 'tools/list', {});
      const listBody = await listed.json() as any;
      for (const name of ['update_profile', 'record_workout', 'add_measurement']) {
        const tool = listBody.result.tools.find((item: any) => item.name === name);
        expect(tool.inputSchema.required).toContain('idempotencyKey');
      }
      for (const status of [429, 503]) {
        mocks.authenticate.mockClear();
        mocks.rateLimit.mockResolvedValueOnce(new Response(JSON.stringify({ error: status === 429 ? 'rate_limited' : 'rate_limit_unavailable' }), { status }));
        const response = await rpc(d1, 'tools/list', {});
        expect(response.status).toBe(status);
        expect(mocks.authenticate).not.toHaveBeenCalled();
      }
    } finally { database.close(); }
  });

  it('normaliza date a d, conserva las escrituras en D1 y reproduce el recibo sin duplicados', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    try {
      const workoutArgs = { baseRev: 0, baseWid: null, idempotencyKey: 'workout-1', workout: {
        date: '2026-10-26', entries: [{ id: 'exercise-1', sets: [{ w: 25, r: 8, done: true }] }],
      } };
      const created = await value(await call(d1, 'record_workout', workoutArgs));
      expect(created).toMatchObject({ rev: 1, replayed: false });
      const workoutSnapshot = await readGymState(d1, 'account-a');
      expect(workoutSnapshot.state?.workouts).toMatchObject([{ d: '2026-10-26', entries: [{ id: 'exercise-1' }] }]);

      const measurement = await value(await call(d1, 'add_measurement', {
        baseRev: workoutSnapshot.rev, baseWid: workoutSnapshot.wid, idempotencyKey: 'measurement-1',
        entry: { date: '2026-10-26', values: { waist: 80 } },
      }));
      expect(measurement).toMatchObject({ rev: 2, replayed: false });
      expect((await readGymState(d1, 'account-a')).state?.measurements).toMatchObject([{ d: '2026-10-26', values: { waist: 80 } }]);

      const replay = await value(await call(d1, 'record_workout', workoutArgs));
      expect(replay).toMatchObject({ rev: 1, replayed: true });
      expect((await readGymState(d1, 'account-a')).state?.workouts).toHaveLength(1);
      const reused = await value(await call(d1, 'record_workout', { ...workoutArgs, workout: { ...workoutArgs.workout, date: '2026-10-27' } }));
      expect(reused).toMatchObject({ error: 'idempotency_key_reused' });
    } finally { database.close(); }
  });

  it('lee perfil, rutinas, peso y auditoría; update_profile persiste el cambio', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    try {
      const seeded = await writeGymState(d1, 'account-a', { state: {
        unit: 'kg', lang: 'es', theme: 'dark', body: 'athletic', targetW: 70, langAuto: false, experience: 'intermediate',
        routines: [{ id: 'routine-1', name: 'Empuje', ex: [{ id: '0025', sets: 3, reps: 8 }] }],
        bodyweight: [{ d: '2026-10-26', w: 72.5 }],
        measurements: [{ id: 'measurement-1', d: '2026-10-26', values: { waist: 80 } }],
      }, baseRev: 0, baseWid: null });
      if (!seeded.ok) throw new Error('No se pudo preparar el estado de perfil.');

      expect(await value(await call(d1, 'get_profile', {}))).toEqual({
        profile: { unit: 'kg', lang: 'es', theme: 'dark', body: 'athletic', targetW: 70, langAuto: false, experience: 'intermediate' },
        rev: seeded.rev, wid: seeded.wid,
      });
      expect(await value(await call(d1, 'list_routines', {}))).toEqual({
        routines: [{ id: 'routine-1', name: 'Empuje', ex: [{ id: '0025', sets: 3, reps: 8 }] }], rev: seeded.rev, wid: seeded.wid,
      });
      expect(await value(await call(d1, 'get_bodyweight', {}))).toEqual({
        bodyweight: [{ d: '2026-10-26', w: 72.5 }],
        measurements: [{ id: 'measurement-1', d: '2026-10-26', values: { waist: 80 } }],
        rev: seeded.rev, wid: seeded.wid,
      });

      const unitChange = await value(await call(d1, 'update_profile', {
        baseRev: seeded.rev, baseWid: seeded.wid, idempotencyKey: 'profile-unit-1', profile: { unit: 'lb', targetW: 160 },
      }));
      expect(unitChange).toMatchObject({ rev: seeded.rev + 1, replayed: false, summary: { fields: ['unit', 'targetW'] } });
      const convertedProfile = await readGymState(d1, 'account-a');
      expect(convertedProfile).toMatchObject({
        rev: unitChange.rev,
        state: { unit: 'lb', targetW: 160, bodyweight: [{ d: '2026-10-26', w: 159.8 }], measurements: [{ id: 'measurement-1', values: { waist: 80 } }] },
      });
      expect(convertedProfile.state?.unitSet).toMatchObject({ at: expect.any(Number), convert: true });

      const updated = await value(await call(d1, 'update_profile', {
        baseRev: unitChange.rev, baseWid: unitChange.wid, idempotencyKey: 'profile-1', profile: { theme: 'light', targetW: 71 },
      }));
      expect(updated).toMatchObject({ rev: unitChange.rev + 1, replayed: false, summary: { kind: 'update_profile', fields: ['theme', 'targetW'] } });
      expect(await readGymState(d1, 'account-a')).toMatchObject({
        rev: updated.rev,
        state: { unit: 'lb', theme: 'light', targetW: 71, lang: 'es', routines: [{ id: 'routine-1' }] },
      });
      const history = await value(await call(d1, 'get_change_history', {}));
      expect(history).toMatchObject({
        limit: 100,
        entries: [
          expect.objectContaining({ tool: 'update_profile', action: 'write', outcome: 'applied',
            summary: { kind: 'update_profile', fields: ['theme', 'targetW'] } }),
          expect.objectContaining({ tool: 'update_profile', action: 'write', outcome: 'applied',
            summary: { kind: 'update_profile', fields: ['unit', 'targetW'] } }),
        ],
      });
    } finally { database.close(); }
  });

  it('convierte pesos y volumen kg→lb sin alterar sellos ni inventarios por unidad', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    try {
      const seeded = await writeGymState(d1, 'account-a', { state: {
        unit: 'kg', unitSet: { at: 10, convert: true }, targetW: 70,
        routines: [{ id: 'routine-kg', name: 'Empuje', _ts: 102, _f: { name: 90 }, ex: [{
          id: '0025', weight: 60, inc: 2.5, warmup: [{ weight: 30 }], pyramidWeight: [40, 0],
        }] }],
        workouts: [{ id: 'workout-kg', d: '2026-10-26', note: 'guardada', bw: 72.5, vol: 500, _ts: 103,
          _f: { note: 91 }, entries: [{ id: '0025', sets: [{ w: 50, r: 10, done: true }] }] }],
        bodyweight: [{ d: '2026-10-26', t: 101, w: 72.5 }],
        exWeights: { '0025': { w: 50, d: '2026-10-20' } },
        barWeights: { '0025': 15 }, edited: { 'barWeights.0025': 77 },
        plates: { kg: { _ts: 80, weights: [10, 20] }, lb: { _ts: 81, weights: [25, 45] } },
        dumbbells: { kg: { _ts: 82, weights: [10, 20] }, lb: { _ts: 83, weights: [25, 45] } },
        dayNotes: { '2026-10-26': { tag: 'rest', _ts: 84 } },
      }, baseRev: 0, baseWid: null });
      if (!seeded.ok) throw new Error('No se pudo preparar el perfil en kg.');
      const before = (await readGymState(d1, 'account-a')).state as any;

      const changed = await value(await call(d1, 'update_profile', {
        baseRev: seeded.rev, baseWid: seeded.wid, idempotencyKey: 'kg-to-lb-complete', profile: { unit: 'lb', targetW: 160 },
      }));
      const after = (await readGymState(d1, 'account-a')).state as any;

      expect(changed).toMatchObject({ rev: seeded.rev + 1, replayed: false, summary: { fields: ['unit', 'targetW'] } });
      expect(after).toMatchObject({ unit: 'lb', targetW: 160, unitSet: { at: expect.any(Number), convert: true } });
      expect(after.workouts[0]).toMatchObject({ vol: 1100, bw: 159.8, _ts: before.workouts[0]._ts, _f: before.workouts[0]._f,
        entries: [{ sets: [{ w: 110, r: 10, done: true }] }] });
      expect(after.routines[0]).toMatchObject({ _ts: before.routines[0]._ts, _f: before.routines[0]._f,
        ex: [{ weight: 132.5, inc: 5.5, warmup: [{ weight: 66 }], pyramidWeight: [88, 0] }] });
      expect(after.bodyweight).toEqual([{ d: '2026-10-26', t: 101, w: 159.8 }]);
      expect(after.exWeights).toEqual({ '0025': { w: 110, d: '2026-10-20' } });
      expect(after.barWeights).toEqual({ '0025': 33 });
      expect(after.edited['barWeights.0025']).toBe(before.edited['barWeights.0025']);
      expect(after.plates).toEqual(before.plates);
      expect(after.dumbbells).toEqual(before.dumbbells);
      expect(after.dayNotes).toEqual(before.dayNotes);
    } finally { database.close(); }
  });

  it('convierte el estado lb→kg y conserva la lista de discos de cada unidad', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    try {
      const seeded = await writeGymState(d1, 'account-a', { state: {
        unit: 'lb', targetW: 175, routines: [{ id: 'routine-lb', name: 'Tirón', _ts: 102, ex: [{ id: '0025', weight: 45 }] }],
        workouts: [{ id: 'workout-lb', d: '2026-10-26', bw: 150, vol: 225, _ts: 103,
          entries: [{ id: '0025', sets: [{ w: 45, r: 5, done: true }] }] }],
        bodyweight: [{ d: '2026-10-26', t: 101, w: 150 }],
        plates: { kg: { _ts: 80, weights: [10, 20] }, lb: { _ts: 81, weights: [25, 45] } },
      }, baseRev: 0, baseWid: null });
      if (!seeded.ok) throw new Error('No se pudo preparar el perfil en lb.');

      const changed = await value(await call(d1, 'update_profile', {
        baseRev: seeded.rev, baseWid: seeded.wid, idempotencyKey: 'lb-to-kg-complete', profile: { unit: 'kg' },
      }));
      const after = (await readGymState(d1, 'account-a')).state as any;

      expect(changed).toMatchObject({ rev: seeded.rev + 1, replayed: false });
      expect(after).toMatchObject({ unit: 'kg', targetW: 79.4, unitSet: { at: expect.any(Number), convert: true },
        workouts: [{ vol: 102.5, bw: 68, entries: [{ sets: [{ w: 20.5, r: 5, done: true }] }] }],
        routines: [{ ex: [{ weight: 20.5 }] }], bodyweight: [{ d: '2026-10-26', t: 101, w: 68 }] });
      expect(after.plates).toEqual({ kg: { _ts: 80, weights: [10, 20] }, lb: { _ts: 81, weights: [25, 45] } });
    } finally { database.close(); }
  });

  it('convierte a lb una edición offline de 55 kg al fusionarla en ambos órdenes', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    try {
      const seeded = await writeGymState(d1, 'account-a', { state: {
        unit: 'kg', workouts: [{ id: 'offline-workout', d: '2026-10-26', _ts: 100,
          entries: [{ id: '0025', sets: [{ w: 50, r: 8, done: true }] }] }],
      }, baseRev: 0, baseWid: null });
      if (!seeded.ok) throw new Error('No se pudo preparar la sesión kg.');
      const offline = structuredClone((await readGymState(d1, 'account-a')).state) as any;
      offline._ts = 200;
      offline.workouts[0]._ts = 200;
      offline.workouts[0].entries[0].sets[0].w = 55;

      const changed = await value(await call(d1, 'update_profile', {
        baseRev: seeded.rev, baseWid: seeded.wid, idempotencyKey: 'offline-kg-to-lb', profile: { unit: 'lb' },
      }));
      const current = (await readGymState(d1, 'account-a')).state as any;
      const localFirst = mergeStates(offline, current) as any;
      const serverFirst = mergeStates(current, offline) as any;

      expect(changed).toMatchObject({ rev: seeded.rev + 1, replayed: false });
      for (const merged of [localFirst, serverFirst]) {
        expect(merged.unit).toBe('lb');
        expect(merged.workouts[0].entries[0].sets[0].w).toBe(121.5);
      }
    } finally { database.close(); }
  });

  it('acepta la unidad actual y reproduce el recibo sin volver a convertir', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    try {
      const seeded = await writeGymState(d1, 'account-a', { state: {
        unit: 'kg', targetW: 70, bodyweight: [{ d: '2026-10-26', t: 101, w: 72.5 }],
      }, baseRev: 0, baseWid: null });
      if (!seeded.ok) throw new Error('No se pudo preparar el perfil.');
      const args = { baseRev: seeded.rev, baseWid: seeded.wid, idempotencyKey: 'same-unit-replay', profile: { unit: 'kg' } };

      const first = await value(await call(d1, 'update_profile', args));
      const afterFirst = await readGymState(d1, 'account-a');
      const replay = await value(await call(d1, 'update_profile', args));

      expect(first).toMatchObject({ rev: seeded.rev + 1, replayed: false });
      expect(afterFirst.state).toMatchObject({ unit: 'kg', targetW: 70, bodyweight: [{ w: 72.5 }] });
      expect(replay).toMatchObject({ rev: first.rev, replayed: true });
      expect((await readGymState(d1, 'account-a')).rev).toBe(afterFirst.rev);
    } finally { database.close(); }
  });

  it('preview de borrado no muta y apply rechaza la revisión obsoleta', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    try {
      const inserted = await writeGymState(d1, 'account-a', { state: {
        workouts: [{ id: 'workout-1', d: '2026-10-26', entries: [{ id: 'exercise-1', sets: [] }] }],
      }, baseRev: 0, baseWid: null });
      if (!inserted.ok) throw new Error('No se pudo preparar la sesión del test.');
      const preview = await value(await call(d1, 'preview_delete_workout', {
        baseRev: inserted.rev, baseWid: inserted.wid, idempotencyKey: 'preview-1', workoutId: 'workout-1',
      }));
      expect(preview).toMatchObject({ requiresConfirmation: true, preview: { kind: 'delete_workout' } });
      expect((await readGymState(d1, 'account-a')).state?.workouts).toHaveLength(1);
      const changed = await writeGymState(d1, 'account-a', { state: { workouts: [{ id: 'workout-1', d: '2026-10-26', entries: [{ id: 'exercise-1', sets: [] }] }], theme: 'light' }, baseRev: inserted.rev, baseWid: inserted.wid });
      if (!changed.ok) throw new Error('No se pudo crear una revisión concurrente.');
      const stale = await value(await call(d1, 'apply_change', { changeId: preview.changeId, confirm: true }));
      expect(stale).toMatchObject({ error: 'conflict' });
      expect((await readGymState(d1, 'account-a')).state?.workouts).toHaveLength(1);
    } finally { database.close(); }
  });

  it('solo aplica la sustitución del plan tras confirmación explícita y reintenta sin duplicar', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    try {
      const inserted = await writeGymState(d1, 'account-a', { state: { routines: [{ id: 'old', name: 'Anterior', ex: [] }] }, baseRev: 0, baseWid: null });
      if (!inserted.ok) throw new Error('No se pudo preparar la rutina del test.');
      const previewArgs = { baseRev: inserted.rev, baseWid: inserted.wid, idempotencyKey: 'replace-1', routines: [{ id: 'new', name: 'Nueva', ex: [] }] };
      const preview = await value(await call(d1, 'preview_replace_training_plan', previewArgs));
      const previewReplay = await value(await call(d1, 'preview_replace_training_plan', previewArgs));
      expect(previewReplay).toMatchObject({ changeId: preview.changeId, replayed: true });
      expect((await readGymState(d1, 'account-a')).state?.routines).toMatchObject([{ id: 'old' }]);
      expect(await value(await call(d1, 'apply_change', { changeId: preview.changeId, confirm: false }))).toMatchObject({ error: 'confirmation_required' });
      const applied = await value(await call(d1, 'apply_change', { changeId: preview.changeId, confirm: true }));
      expect(applied).toMatchObject({ rev: 2, replayed: false, summary: { kind: 'replace_training_plan' } });
      const replay = await value(await call(d1, 'apply_change', { changeId: preview.changeId, confirm: true }));
      expect(replay).toMatchObject({ rev: 2, replayed: true });
      expect((await readGymState(d1, 'account-a')).state?.routines).toMatchObject([{ id: 'new' }]);
    } finally { database.close(); }
  });

  it('previsualiza el borrado de una medición sin mutar y solo la borra al confirmar', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    try {
      const seeded = await writeGymState(d1, 'account-a', { state: {
        measurements: [
          { id: 'measurement-delete', d: '2026-10-25', values: { waist: 80 } },
          { id: 'measurement-keep', d: '2026-10-26', values: { waist: 79 } },
        ],
      }, baseRev: 0, baseWid: null });
      if (!seeded.ok) throw new Error('No se pudieron preparar las mediciones.');

      const preview = await value(await call(d1, 'preview_delete_measurement', {
        baseRev: seeded.rev, baseWid: seeded.wid, idempotencyKey: 'measurement-preview', measurementId: 'measurement-delete',
      }));
      expect(preview).toMatchObject({ requiresConfirmation: true, preview: { kind: 'delete_measurement', id: 'measurement-delete', date: '2026-10-25' } });
      expect(await readGymState(d1, 'account-a')).toMatchObject({
        rev: seeded.rev, state: { measurements: [
          { id: 'measurement-delete', d: '2026-10-25' }, { id: 'measurement-keep', d: '2026-10-26' },
        ] },
      });
      const staleOfflineState = structuredClone((await readGymState(d1, 'account-a')).state);
      expect(database.prepare('SELECT used_at FROM gym_mcp_pending_changes WHERE account_id = ? AND change_id = ?')
        .get('account-a', preview.changeId)).toEqual({ used_at: null });

      const applied = await value(await call(d1, 'apply_change', { changeId: preview.changeId, confirm: true }));
      expect(applied).toMatchObject({ rev: seeded.rev + 1, replayed: false, summary: { kind: 'delete_measurement', changeId: preview.changeId } });
      expect((await readGymState(d1, 'account-a')).state?.measurements)
        .toEqual([{ id: 'measurement-keep', d: '2026-10-26', values: { waist: 79 } }]);
      const deletedState = (await readGymState(d1, 'account-a')).state;
      expect(deletedState?.deleted).toMatchObject({ measurements: { '2026-10-25': expect.any(Number) } });
      expect((mergeStates(staleOfflineState, deletedState) as any).measurements.map((row: any) => row.d))
        .not.toContain('2026-10-25');
      expect(database.prepare('SELECT used_at FROM gym_mcp_pending_changes WHERE account_id = ? AND change_id = ?')
        .get('account-a', preview.changeId)?.used_at).toBeTruthy();
      expect(database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_audit WHERE account_id = ? AND tool_name = ? AND outcome = ?')
        .get('account-a', 'preview_delete_measurement', 'created')).toEqual({ count: 1 });
    } finally { database.close(); }
  });

  it('devuelve d en exercise_history y lee date en sesiones antiguas', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read' }));
    try {
      const seeded = await writeGymState(d1, 'account-a', { state: { workouts: [
        { id: 'legacy-workout', d: '2026-10-25', entries: [{ id: '0025', name: 'press banca', sets: [] }] },
        { id: 'normalized-workout', d: '2026-10-26', entries: [{ id: '0031', name: 'remo', sets: [] }] },
      ] }, baseRev: 0, baseWid: null });
      if (!seeded.ok) throw new Error('No se pudieron preparar las sesiones del test.');
      database.prepare(`UPDATE gym_sessions
        SET details_json = json_remove(json_set(details_json, '$.date', json_extract(details_json, '$.d')), '$.d')
        WHERE account_id = ? AND session_id = ?`).run('account-a', 'legacy-workout');

      const history = await value(await call(d1, 'exercise_history', { exercise: 'e' }));

      expect(history.matches).toEqual([
        { d: '2026-10-26', workoutId: 'normalized-workout', exercise: { id: '0031', name: 'remo', sets: [] } },
        { d: '2026-10-25', workoutId: 'legacy-workout', exercise: { id: '0025', name: 'press banca', sets: [] } },
      ]);
    } finally { database.close(); }
  });

  it('restaura una revisión completa con entidades relacionadas y conserva el estado active local', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    const original = {
      unit: 'kg', lang: 'es', theme: 'dark', futureSetting: { retained: true }, active: { exercise: 'local-only' },
      routines: [
        { id: 'routine-1', name: 'Empuje', day: 'mon', progression: { step: 2 }, ex: [{ id: '0025', sets: 3, reps: 8, note: 'agarre medio' }] },
        { id: 'routine-2', name: 'Tirón', day: 'wed', ex: [{ id: '0031', sets: 4, reps: 10, order: 2 }] },
      ],
      workouts: [
        { id: 'workout-1', d: '2026-10-26', routineId: 'routine-1', start: 1792972800000, end: 1792976400000, note: 'sesión A', entries: [
          { id: '0025', name: 'press banca', note: 'banco bajo', sets: [
            { w: 50, r: 8, done: true, rir: 2, source: 'manual' }, { w: 45, r: 10, done: false, tempo: '3-1-1' },
          ] },
          { id: '0031', name: 'remo', sets: [{ w: 30, r: 12, done: true }] },
        ] },
        { id: 'workout-2', d: '2026-10-27', routineId: 'routine-2', entries: [{ id: '0031', name: 'remo', sets: [{ w: 32, r: 10 }] }] },
      ],
      bodyweight: [{ d: '2026-10-26', t: 1792972800000, w: 72.5, note: 'mañana' }],
      measurements: [{ id: 'measurement-1', d: '2026-10-26', t: 1792972800000, values: { waist: 80 }, source: 'manual' }],
      customEx: [{ id: 'custom-1', name: 'Press propio', muscle: 'chest', equipment: 'bench', note: 'agarre neutro' }],
      favEx: ['0025', '0031'], equipProfiles: [{ id: 'home', name: 'Casa', equipment: ['dumbbell'] }],
      gymCards: [{ id: 'club', label: 'Club', value: '123456', fmt: 'code128' }],
      exNotes: { '0025': 'banco bajo' }, exWeights: { '0025': { w: 50, d: '2026-10-26', source: 'manual' } },
    };
    try {
      const seeded = await writeGymState(d1, 'account-a', { state: original, baseRev: 0, baseWid: null });
      if (!seeded.ok) throw new Error('No se pudo preparar la revisión inicial.');
      const changed = await writeGymState(d1, 'account-a', {
        state: { theme: 'light', routines: [{ id: 'replacement', name: 'Sustituta', ex: [] }], workouts: [], measurements: [] },
        baseRev: seeded.rev, baseWid: seeded.wid,
      });
      if (!changed.ok) throw new Error('No se pudo preparar la revisión concurrente.');

      const restored = await value(await call(d1, 'restore_revision', {
        baseRev: changed.rev, baseWid: changed.wid, revisionId: seeded.wid, idempotencyKey: 'restore-roundtrip',
      }));
      const snapshot = await readGymState(d1, 'account-a');

      expect(restored).toMatchObject({ rev: 3, replayed: false, summary: { kind: 'restore_revision', restoredFromRevisionId: seeded.wid } });
      expect(snapshot.state).toMatchObject({
        ...Object.fromEntries(Object.entries(original).filter(([key]) => key !== 'active')),
        bodyweight: [{ ...original.bodyweight[0], t: expect.any(Number) }],
        measurements: [{ ...original.measurements[0], t: expect.any(Number) }],
        _rev: 3,
        _wid: restored.wid,
      });
      expect(snapshot.state).not.toHaveProperty('active');
    } finally { database.close(); }
  });

  it('restampa un escalar igual al restaurar para vencer un cambio offline intermedio', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    try {
      const first = await writeGymState(d1, 'account-a', { state: { theme: 'dark', edited: { theme: 100 }, _ts: 100 }, baseRev: 0, baseWid: null });
      if (!first.ok) throw new Error('No se pudo preparar la revisión histórica.');
      const intermediate = await writeGymState(d1, 'account-a', { state: { theme: 'light', edited: { theme: 200 }, _ts: 200 }, baseRev: first.rev, baseWid: first.wid });
      if (!intermediate.ok) throw new Error('No se pudo preparar el cambio intermedio.');
      const current = await writeGymState(d1, 'account-a', { state: { theme: 'dark', edited: { theme: 300 }, _ts: 300 }, baseRev: intermediate.rev, baseWid: intermediate.wid });
      if (!current.ok) throw new Error('No se pudo preparar el valor actual.');

      await value(await call(d1, 'restore_revision', {
        baseRev: current.rev, baseWid: current.wid, revisionId: first.wid, idempotencyKey: 'restore-equal-scalar',
      }));
      const restored = (await readGymState(d1, 'account-a')).state as any;
      const offline = structuredClone(restored);
      offline.theme = 'light';
      offline.edited = { ...offline.edited, theme: 301 };
      offline._ts = 301;

      expect(restored.edited.theme).toBeGreaterThan(301);
      expect((mergeStates(offline, restored) as any).theme).toBe('dark');
    } finally { database.close(); }
  });

  it('mantiene resetAt/resetIds al restaurar para que mergeStates no descarte la rutina', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    try {
      const first = await writeGymState(d1, 'account-a', { state: {
        routines: [{ id: 'restore-routine', name: 'Vuelve', ex: [], _ts: 100 }], workouts: [], _ts: 100,
      }, baseRev: 0, baseWid: null });
      if (!first.ok) throw new Error('No se pudo preparar la revisión histórica.');
      const resetState = {
        resetAt: 200, resetIds: { routines: ['restore-routine'] }, routines: [], workouts: [], _ts: 200,
      };
      const reset = await writeGymState(d1, 'account-a', { state: resetState, baseRev: first.rev, baseWid: first.wid });
      if (!reset.ok) throw new Error('No se pudo preparar el estado tras el reset.');

      await value(await call(d1, 'restore_revision', {
        baseRev: reset.rev, baseWid: reset.wid, revisionId: first.wid, idempotencyKey: 'restore-reset-marker',
      }));
      const restored = (await readGymState(d1, 'account-a')).state as any;
      const merged = mergeStates(restored, resetState) as any;

      expect(restored).toMatchObject({ resetAt: 200, resetIds: { routines: ['restore-routine'] } });
      expect(merged.routines.map((routine: any) => routine.id)).toContain('restore-routine');
    } finally { database.close(); }
  });

  it('renueva los sellos _f de propiedades iguales, borradas y reintroducidas en entidades restauradas', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    try {
      const first = await writeGymState(d1, 'account-a', { state: { workouts: [{
        id: 'restore-workout', d: '2026-10-26', name: 'Mismo nombre', restoredOnly: 'histórico', entries: [],
        _ts: 100, _f: { name: 100, currentOnly: 100, restoredOnly: 100 },
      }] }, baseRev: 0, baseWid: null });
      if (!first.ok) throw new Error('No se pudo preparar la revisión histórica.');
      const current = await writeGymState(d1, 'account-a', { state: { workouts: [{
        id: 'restore-workout', d: '2026-10-26', name: 'Mismo nombre', currentOnly: 'actual', entries: [],
        _ts: 200, _f: { name: 200, currentOnly: 200, restoredOnly: 200 },
      }] }, baseRev: first.rev, baseWid: first.wid });
      if (!current.ok) throw new Error('No se pudo preparar la entidad actual.');

      await value(await call(d1, 'restore_revision', {
        baseRev: current.rev, baseWid: current.wid, revisionId: first.wid, idempotencyKey: 'restore-entry-fields',
      }));
      const restored = (await readGymState(d1, 'account-a')).state as any;
      const restoredEntry = restored.workouts[0];
      const offline = structuredClone(restored);
      offline._ts = 301;
      Object.assign(offline.workouts[0], { _ts: 301, name: 'Edición offline', currentOnly: 'resucitado', restoredOnly: 'otra edición' });
      offline.workouts[0]._f = { ...offline.workouts[0]._f, name: 301, currentOnly: 301, restoredOnly: 301 };
      const mergedEntry = (mergeStates(offline, restored) as any).workouts[0];

      expect(restoredEntry._f).toMatchObject({ name: expect.any(Number), currentOnly: expect.any(Number), restoredOnly: expect.any(Number) });
      expect(Object.values(restoredEntry._f).every((stamp: any) => stamp > 301)).toBe(true);
      expect(mergedEntry.name).toBe('Mismo nombre');
      expect(mergedEntry).not.toHaveProperty('currentOnly');
      expect(mergedEntry.restoredOnly).toBe('histórico');
    } finally { database.close(); }
  });

  it('sella como clear las claves stamped que la revisión restaurada omite', async () => {
    const { database, d1 } = openTestDatabase();
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId: 'account-a', clientId: 'mcp-client', scope: 'radian:read radian:write' }));
    try {
      const first = await writeGymState(d1, 'account-a', { state: { theme: 'dark', workouts: [] }, baseRev: 0, baseWid: null });
      if (!first.ok) throw new Error('No se pudo preparar la revisión sin nota.');
      const currentState = { theme: 'light', dayNotes: { '2026-10-26': { tag: 'sick', text: 'nota actual', _ts: 200 } }, workouts: [], _ts: 200 };
      const current = await writeGymState(d1, 'account-a', { state: currentState, baseRev: first.rev, baseWid: first.wid });
      if (!current.ok) throw new Error('No se pudo preparar la nota actual.');

      await value(await call(d1, 'restore_revision', {
        baseRev: current.rev, baseWid: current.wid, revisionId: first.wid, idempotencyKey: 'restore-clear-day-note',
      }));
      const restored = (await readGymState(d1, 'account-a')).state as any;
      const merged = mergeStates(currentState, restored) as any;

      expect(restored.dayNotes['2026-10-26']).toMatchObject({ _ts: expect.any(Number) });
      expect(restored.dayNotes['2026-10-26']).not.toHaveProperty('text');
      expect(merged.dayNotes['2026-10-26']).toMatchObject({ _ts: restored.dayNotes['2026-10-26']._ts });
      expect(merged.dayNotes['2026-10-26']).not.toHaveProperty('text');
    } finally { database.close(); }
  });

  it('limita el restore por cuenta, CAS, expiración e idempotencia; list_revisions solo lee', async () => {
    const { database, d1 } = openTestDatabase();
    database.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').run('account-b', 'B', '2026-10-26T00:00:00.000Z');
    let userId = 'account-a';
    let scope = 'radian:read radian:write';
    mocks.authenticate.mockImplementation(async () => ({ database: d1, userId, clientId: 'mcp-client', scope }));
    try {
      const original = { routines: [{ id: 'routine-old', name: 'Antigua', ex: [] }] };
      const first = await writeGymState(d1, 'account-a', { state: original, baseRev: 0, baseWid: null });
      if (!first.ok) throw new Error('No se pudo preparar la revisión inicial.');
      const changed = await writeGymState(d1, 'account-a', {
        state: { routines: [{ id: 'routine-new', name: 'Nueva', ex: [] }] }, baseRev: first.rev, baseWid: first.wid,
      });
      if (!changed.ok) throw new Error('No se pudo preparar la segunda revisión.');
      const accountB = await writeGymState(d1, 'account-b', { state: { routines: [{ id: 'private-b', name: 'B', ex: [] }] }, baseRev: 0, baseWid: null });
      if (!accountB.ok) throw new Error('No se pudo preparar la segunda cuenta.');

      userId = 'account-b';
      expect(await value(await call(d1, 'restore_revision', {
        baseRev: accountB.rev, baseWid: accountB.wid, revisionId: first.wid, idempotencyKey: 'cross-account',
      }))).toMatchObject({ error: 'revision_unavailable' });
      expect((await readGymState(d1, 'account-b')).state?.routines).toMatchObject([{ id: 'private-b' }]);
      expect(database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_operations WHERE account_id = ?').get('account-b'))
        .toEqual({ count: 0 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_audit WHERE account_id = ?').get('account-b'))
        .toEqual({ count: 0 });

      userId = 'account-a';
      const concurrent = await writeGymState(d1, 'account-a', {
        state: { routines: [{ id: 'routine-live', name: 'Actual', ex: [] }] }, baseRev: changed.rev, baseWid: changed.wid,
      });
      if (!concurrent.ok) throw new Error('No se pudo preparar el cambio concurrente.');
      expect(await value(await call(d1, 'restore_revision', {
        baseRev: changed.rev, baseWid: changed.wid, revisionId: first.wid, idempotencyKey: 'stale-restore',
      }))).toMatchObject({ error: 'conflict', rev: concurrent.rev, wid: concurrent.wid });
      expect((await readGymState(d1, 'account-a')).state?.routines).toMatchObject([{ id: 'routine-live' }]);
      expect(database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_operations WHERE operation_id = ?').get('write-stale-restore'))
        .toEqual({ count: 0 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_audit WHERE tool_name = ? AND account_id = ?')
        .get('restore_revision', 'account-a')).toEqual({ count: 0 });

      const request = { baseRev: concurrent.rev, baseWid: concurrent.wid, revisionId: first.wid, idempotencyKey: 'restore-replay' };
      const restored = await value(await call(d1, 'restore_revision', request));
      const replay = await value(await call(d1, 'restore_revision', request));
      expect(restored).toMatchObject({ rev: concurrent.rev + 1, replayed: false, summary: { kind: 'restore_revision' } });
      expect(replay).toMatchObject({ rev: restored.rev, wid: restored.wid, replayed: true });
      expect(database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_audit WHERE account_id = ? AND tool_name = ?')
        .get('account-a', 'restore_revision')).toEqual({ count: 1 });
      expect(await value(await call(d1, 'restore_revision', { ...request, revisionId: changed.wid })))
        .toMatchObject({ error: 'idempotency_key_reused' });
      expect(database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_audit WHERE account_id = ? AND tool_name = ?')
        .get('account-a', 'restore_revision')).toEqual({ count: 1 });

      database.prepare('UPDATE gym_mcp_revisions SET expires_at = ? WHERE account_id = ? AND revision_id = ?')
        .run('2000-01-01T00:00:00.000Z', 'account-a', changed.wid);
      const beforeCount = database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_revisions WHERE account_id = ?').get('account-a');
      const latest = await readGymState(d1, 'account-a');
      expect(await value(await call(d1, 'restore_revision', {
        baseRev: latest.rev, baseWid: latest.wid, revisionId: changed.wid, idempotencyKey: 'expired-restore',
      }))).toMatchObject({ error: 'revision_unavailable' });

      scope = 'radian:read';
      const listed = await value(await call(d1, 'list_revisions', {}));
      expect(listed.revisions.map((revision: { id: string }) => revision.id)).not.toContain(changed.wid);
      expect(database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_revisions WHERE account_id = ?').get('account-a'))
        .toEqual(beforeCount);
      expect(database.prepare('SELECT expires_at FROM gym_mcp_revisions WHERE account_id = ? AND revision_id = ?')
        .get('account-a', changed.wid)).toEqual({ expires_at: '2000-01-01T00:00:00.000Z' });
      expect(await value(await call(d1, 'restore_revision', {
        baseRev: latest.rev, baseWid: latest.wid, revisionId: first.wid, idempotencyKey: 'read-only-restore',
      }))).toMatchObject({ error: 'insufficient_scope' });
      expect(database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_operations WHERE operation_id = ?').get('write-expired-restore'))
        .toEqual({ count: 0 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_operations WHERE operation_id = ?').get('write-read-only-restore'))
        .toEqual({ count: 0 });
      expect(database.prepare('SELECT COUNT(*) AS count FROM gym_mcp_audit WHERE account_id = ? AND tool_name = ?')
        .get('account-a', 'restore_revision')).toEqual({ count: 1 });
    } finally { database.close(); }
  });
});

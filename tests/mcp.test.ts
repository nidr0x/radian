import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { defaultData } from '../src/data/initialPlan';
import { handleMcpTool, loadMcpUserData, MCP_TOOL_DEFINITIONS } from '../functions/lib/mcp';
import { validateMcpAppData, validateMcpWriteOperation } from '../functions/lib/mcpWrite';
import { hasMcpScope, isAllowedRedirectUri, normalizeScope } from '../functions/lib/mcpAuth';
import { consentPage } from '../functions/api/mcp/authorize';
import { onRequestGet as onProtectedResourceGet } from '../functions/.well-known/oauth-protected-resource';
import type { D1DatabaseLike, McpPendingChangeRow, McpReplaceRoutineOperation, McpRevisionRow } from '../functions/types';

const loadMigration = (): string => readFileSync(resolve(process.cwd(), 'migrations/0006_mcp_revisions.sql'), 'utf8');

const openMigratedDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(':memory:');
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL
    );
    CREATE TABLE mcp_clients (
      client_id TEXT PRIMARY KEY NOT NULL
    );
    CREATE TABLE user_data (
      user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  database.exec(loadMigration());
  return database;
};

const run = (database: DatabaseSync, sql: string, ...params: unknown[]): void => {
  database.prepare(sql).run(...params);
};

const d1FromSqlite = (database: DatabaseSync): D1DatabaseLike => ({
  prepare(query: string) {
    const statement = database.prepare(query);
    let boundValues: unknown[] = [];
    return {
      bind(...values: unknown[]) {
        boundValues = values;
        return this;
      },
      async first<T = Record<string, unknown>>() {
        return (statement.get(...boundValues) as T | undefined) ?? null;
      },
      async all<T = Record<string, unknown>>() {
        return { results: statement.all(...boundValues) as T[] };
      },
      async run() {
        const result = statement.run(...boundValues);
        return {
          success: true,
          meta: {
            changes: Number(result.changes ?? 0),
            last_row_id: Number(result.lastInsertRowid ?? 0),
          },
        };
      },
    };
  },
  async batch() {
    throw new Error('batch no está implementado en este helper de test');
  },
});

describe('puente MCP remoto de Radian', () => {
  it('expone únicamente herramientas de lectura orientadas a entrenamientos', () => {
    expect(MCP_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'get_profile',
      'get_weekly_coach',
      'list_workouts',
      'exercise_history',
      'get_bodyweight',
      'get_recommendations',
    ]);
    expect(MCP_TOOL_DEFINITIONS.every((tool) => !tool.name.includes('write') && !tool.name.includes('delete'))).toBe(true);
  });

  it('devuelve el perfil y una revisión semanal desde la copia de D1', async () => {
    const data = defaultData();
    data.profile.gym = 'Evanfit Picanya';
    await expect(handleMcpTool('get_profile', {}, data)).resolves.toMatchObject({ gym: 'Evanfit Picanya' });
    await expect(handleMcpTool('get_weekly_coach', {}, data)).resolves.toMatchObject({
      completedSessions: 0,
      text: expect.stringContaining('RADIAN | REVISIÓN SEMANAL'),
    });
  });

  it('expone updatedAt en las lecturas cuando la carga viene versionada', async () => {
    const data = defaultData();
    const result = await handleMcpTool('get_profile', {}, {
      data,
      updatedAt: '2026-08-31T21:00:00.000Z',
    });
    expect(result).toMatchObject({
      updatedAt: '2026-08-31T21:00:00.000Z',
      trainingDays: data.profile.trainingDays,
    });
  });

  it('devuelve updatedAt junto al resultado de lectura', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.profile.gym = 'Evanfit Picanya';
    run(database, 'INSERT INTO users (id) VALUES (?)', 'user-1');
    run(database, 'INSERT INTO user_data (user_id, payload, updated_at) VALUES (?, ?, ?)', 'user-1', JSON.stringify(data), '2026-08-31T21:00:00.000Z');

    await expect(loadMcpUserData(d1FromSqlite(database), 'user-1')).resolves.toMatchObject({
      updatedAt: '2026-08-31T21:00:00.000Z',
      data: {
        profile: {
          gym: 'Evanfit Picanya',
        },
      },
    });
    database.close();
  });

  it('rechaza payloads MCP con estructura top-level desconocida', () => {
    const data = defaultData();
    expect(() => validateMcpAppData({
      ...data,
      extra: true,
    })).toThrow(/válid|desconoc/i);
  });

  it('rechaza payloads MCP con IDs, fechas y rangos inválidos', () => {
    const invalidSessionDate = defaultData();
    invalidSessionDate.sessions = [{
      id: 'session 1',
      workoutDayId: invalidSessionDate.plan.days[0].id,
      dateKey: '2026-13-40',
      startedAt: 'not-an-iso-date',
      completedAt: '2026-08-31T21:00:00.000Z',
      status: 'completed',
      activeExerciseIndex: 0,
      plannedExercises: [],
    }];
    expect(() => validateMcpAppData(invalidSessionDate)).toThrow(/id|fecha|iso|válid/i);

    const invalidRange = structuredClone(defaultData());
    invalidRange.plan.days[0].exercises[0] = {
      ...invalidRange.plan.days[0].exercises[0],
      repMin: 12,
      repMax: 8,
    };
    expect(() => validateMcpAppData(invalidRange)).toThrow(/rep|rango|válid/i);

    const invalidTrainingDays = structuredClone(defaultData());
    invalidTrainingDays.profile.trainingDays = [1, 3, 7];
    expect(() => validateMcpAppData(invalidTrainingDays)).toThrow(/trainingDays|0 y 6|válid/i);
  });

  it('rechaza payloads MCP de más de 900 KB', () => {
    const large = defaultData();
    large.profile.goal = 'x'.repeat(900_001);
    expect(() => validateMcpAppData(large)).toThrow(/demasiado grande|900/i);
  });

  it('rechaza estructuras anidadas mal formadas con un error de validación controlado', () => {
    const malformed = structuredClone(defaultData()) as Record<string, unknown>;
    malformed.plan = {
      ...structuredClone(defaultData()).plan,
      days: [{ id: 'monday', exercises: null }],
    };
    expect(() => validateMcpAppData(malformed)).toThrow(/válid|plan\.days|exercises/i);
  });

  it('valida record_workout sin asumir el catálogo inicial y usa contexto opcional para semántica', () => {
    const validWorkout = {
      id: 'session-2026-08-31',
      workoutDayId: 'custom-day',
      dateKey: '2026-08-31',
      startedAt: '2026-08-31T20:00:00.000Z',
      completedAt: '2026-08-31T21:00:00.000Z',
      status: 'completed',
      activeExerciseIndex: 0,
      plannedExercises: [
        {
          plannedExerciseId: 'custom-plan-1',
          exerciseId: 'custom-exercise-1',
          name: 'Press convergente personalizado',
          sets: 3,
          repMin: 8,
          repMax: 10,
          restSeconds: 120,
          warmupSets: 1,
          progressionPolicy: 'double',
          progressionIncrementKg: 2.5,
          completed: true,
          discomfort: false,
          setLogs: [
            { setNumber: 1, phase: 'warmup', targetReps: 8, actualReps: 8, weightKg: 20, completed: true },
            { setNumber: 2, phase: 'work', targetReps: 8, actualReps: 10, weightKg: 40, completed: true },
            { setNumber: 3, phase: 'work', targetReps: 8, actualReps: 9, weightKg: 40, completed: true },
            { setNumber: 4, phase: 'work', targetReps: 8, actualReps: 8, weightKg: 40, completed: true },
          ],
        },
      ],
    };
    expect(() => validateMcpWriteOperation({ kind: 'record_workout', workout: validWorkout })).not.toThrow();

    const validationContext = {
      plan: {
        days: [{ id: 'custom-day' }],
      },
      exercises: [{ id: 'custom-exercise-1' }],
    };
    expect(() => validateMcpWriteOperation({ kind: 'record_workout', workout: validWorkout }, validationContext)).not.toThrow();

    const invalidWorkout = structuredClone(validWorkout);
    invalidWorkout.plannedExercises[0].exerciseId = 'invented-exercise';
    expect(() => validateMcpWriteOperation({ kind: 'record_workout', workout: invalidWorkout }, validationContext)).toThrow(/exerciseId|catálogo|válid/i);
  });

  it('valida el ámbito de lectura y las URLs de retorno OAuth', () => {
    expect(normalizeScope('radian:read offline_access')).toBe('radian:read offline_access');
    expect(normalizeScope('radian:write')).toBeUndefined();
    expect(isAllowedRedirectUri('https://chat.openai.com/a/radian')).toBe(true);
    expect(isAllowedRedirectUri('http://localhost:8788/callback')).toBe(true);
    expect(isAllowedRedirectUri('https://example.com/callback#fragment')).toBe(false);
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false);
  });

  it('separa lectura y escritura en OAuth', () => {
    expect(normalizeScope('radian:read')).toBe('radian:read');
    expect(normalizeScope('radian:read radian:write offline_access')).toBe('radian:read radian:write offline_access');
    expect(normalizeScope('radian:write')).toBeUndefined();
    expect(hasMcpScope('radian:read', 'radian:write')).toBe(false);
    expect(hasMcpScope('radian:read radian:write', 'radian:write')).toBe(true);
  });

  it('anuncia lectura y escritura en la metadata del recurso protegido', () => {
    const response = onProtectedResourceGet({
      request: new Request('https://radian.nidr0x.win/.well-known/oauth-protected-resource'),
      env: {},
    });
    return response.json().then((body: { scopes_supported: string[] }) => {
      expect(body.scopes_supported).toEqual(['radian:read', 'radian:write']);
    });
  });

  it('ajusta el consentimiento al scope solicitado', () => {
    const readOnly = consentPage({ requestId: 'req', csrfToken: 'csrf', clientName: 'Cliente', scope: 'radian:read' });
    const readWrite = consentPage({ requestId: 'req', csrfToken: 'csrf', clientName: 'Cliente', scope: 'radian:read radian:write' });
    expect(readOnly).toContain('Radian · acceso de solo lectura');
    expect(readOnly).toContain('El alcance solicitado solo permite consultar tus datos.');
    expect(readOnly).toContain('Permitir solo lectura');
    expect(readOnly).not.toContain('Permitir leer y modificar');
    expect(readWrite).toContain('Radian · acceso de lectura y modificación');
    expect(readWrite).toContain('El alcance solicitado incluye lectura y, si lo autorizas, modificación de tus datos.');
    expect(readWrite).toContain('Permitir leer y modificar');
  });

  it('expone contratos de filas para revisiones y propuestas pendientes', () => {
    expectTypeOf<McpRevisionRow>().toMatchTypeOf<{
      id: string;
      userId: string;
      payload: string;
      source: string;
      createdAt: string;
      expiresAt: string;
      restoredAt: string | null;
    }>();

    expectTypeOf<McpPendingChangeRow>().toMatchTypeOf<{
      id: string;
      userId: string;
      clientId: string;
      kind: string;
      payload: string;
      baseUpdatedAt: string;
      summary: string;
      createdAt: string;
      expiresAt: string;
      usedAt: string | null;
    }>();

    expectTypeOf<McpReplaceRoutineOperation>().toMatchTypeOf<{
      kind: 'replace_routine';
      plan: object;
      exercises: object[];
    }>();
  });

  it('aplica la migración real con FKs, índices y snapshots sobre user_data', () => {
    const database = openMigratedDatabase();
    run(database, 'INSERT INTO users (id) VALUES (?)', 'user-1');
    run(database, 'INSERT INTO mcp_clients (client_id) VALUES (?)', 'client-1');
    run(database, 'INSERT INTO user_data (user_id, payload, updated_at) VALUES (?, ?, ?)', 'user-1', '{"version":1}', '2026-08-31T21:00:00.000Z');

    const revisionColumns = database.prepare('PRAGMA table_info(user_data_revisions)').all<{ name: string; type: string; notnull: number }>();
    const pendingColumns = database.prepare('PRAGMA table_info(mcp_pending_changes)').all<{ name: string; type: string; notnull: number }>();
    expect(revisionColumns.find((column) => column.name === 'payload')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(pendingColumns.find((column) => column.name === 'payload')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(pendingColumns.find((column) => column.name === 'summary')).toMatchObject({ type: 'TEXT', notnull: 1 });

    const revisionFks = database.prepare('PRAGMA foreign_key_list(user_data_revisions)').all<{ table: string; on_delete: string }>();
    const pendingFks = database.prepare('PRAGMA foreign_key_list(mcp_pending_changes)').all<{ table: string; on_delete: string }>();
    expect(revisionFks.map((fk) => fk.table)).toEqual(['users']);
    expect(revisionFks[0]?.on_delete).toBe('CASCADE');
    expect(pendingFks.map((fk) => fk.table).sort()).toEqual(['mcp_clients', 'users']);
    expect(pendingFks.every((fk) => fk.on_delete === 'CASCADE')).toBe(true);

    const revisionIndexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user_data_revisions' ORDER BY name").all<{ name: string }>().map((row) => row.name);
    const pendingIndexes = database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mcp_pending_changes' ORDER BY name").all<{ name: string }>().map((row) => row.name);
    expect(revisionIndexes).toEqual([
      'sqlite_autoindex_user_data_revisions_1',
      'user_data_revisions_expiry_idx',
      'user_data_revisions_user_expiry_idx',
    ]);
    expect(pendingIndexes).toEqual([
      'mcp_pending_changes_expiry_idx',
      'mcp_pending_changes_user_expiry_idx',
      'sqlite_autoindex_mcp_pending_changes_1',
    ]);

    const triggers = database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all<{ name: string }>().map((row) => row.name);
    expect(triggers).toEqual(['user_data_revision_after_delete', 'user_data_revision_after_update']);

    run(database, 'UPDATE user_data SET updated_at = ? WHERE user_id = ?', '2026-08-31T21:01:00.000Z', 'user-1');
    expect(database.prepare('SELECT count(*) AS count FROM user_data_revisions').get<{ count: number }>()?.count).toBe(0);

    run(database, 'UPDATE user_data SET payload = ?, updated_at = ? WHERE user_id = ?', '{"version":2}', '2026-08-31T21:02:00.000Z', 'user-1');
    run(database, 'DELETE FROM user_data WHERE user_id = ?', 'user-1');

    const revisions = database.prepare('SELECT payload, source, restored_at AS restoredAt FROM user_data_revisions ORDER BY created_at, id').all<{ payload: string; source: string; restoredAt: string | null }>();
    expect(revisions).toHaveLength(2);
    expect(revisions).toEqual(expect.arrayContaining([
      { payload: '{"version":1}', source: 'automatic', restoredAt: null },
      { payload: '{"version":2}', source: 'automatic', restoredAt: null },
    ]));
    database.close();
  });
});

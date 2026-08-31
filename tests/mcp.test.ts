import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { defaultData } from '../src/data/initialPlan';
import {
  applyChange,
  handleMcpTool,
  listRevisions,
  loadMcpUserData,
  MCP_TOOL_DEFINITIONS,
  MCP_WRITE_TOOL_DEFINITIONS,
  previewChange,
  restoreRevision,
  writeMcpData,
} from '../functions/lib/mcp';
import { validateMcpAppData, validateMcpWriteOperation, validateMcpWriteRequest } from '../functions/lib/mcpWrite';
import { hasMcpScope, isAllowedRedirectUri, normalizeScope } from '../functions/lib/mcpAuth';
import { consentPage } from '../functions/api/mcp/authorize';
import { onRequestGet as onProtectedResourceGet } from '../functions/.well-known/oauth-protected-resource';
import type { AppData, WeeklyCheckin, WorkoutSession } from '../src/types';
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
    CREATE TABLE mcp_tokens (
      token_hash TEXT PRIMARY KEY NOT NULL,
      token_type TEXT NOT NULL,
      client_id TEXT NOT NULL REFERENCES mcp_clients(client_id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT
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

const seedActiveAccessToken = (
  database: DatabaseSync,
  { userId = 'user-1', clientId = 'client-1', scope = 'radian:read radian:write' }: { userId?: string; clientId?: string; scope?: string } = {},
): void => {
  run(
    database,
    'INSERT INTO mcp_tokens (token_hash, token_type, client_id, user_id, scope, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    `token-hash-${userId}-${clientId}`,
    'access',
    clientId,
    userId,
    scope,
    '2026-08-31T20:00:00.000Z',
    '2026-09-01T20:00:00.000Z',
    null,
  );
};

const seedUserData = (database: DatabaseSync, data: AppData, updatedAt = '2026-08-31T21:00:00.000Z'): string => {
  run(database, 'INSERT INTO users (id) VALUES (?)', 'user-1');
  run(database, 'INSERT INTO mcp_clients (client_id) VALUES (?)', 'client-1');
  seedActiveAccessToken(database);
  run(database, 'INSERT INTO user_data (user_id, payload, updated_at) VALUES (?, ?, ?)', 'user-1', JSON.stringify(data), updatedAt);
  return updatedAt;
};

const readStoredSnapshot = async (database: DatabaseSync) => loadMcpUserData(d1FromSqlite(database), 'user-1');

const readStoredPayload = async (database: DatabaseSync): Promise<AppData> => {
  const stored = await readStoredSnapshot(database);
  if (!stored.data) throw new Error('Se esperaba payload persistido en el test.');
  return stored.data;
};

const readPendingChangeRow = (database: DatabaseSync, changeId: string): McpPendingChangeRow | null => (
  database.prepare(`
    SELECT
      id,
      user_id AS userId,
      client_id AS clientId,
      kind,
      payload,
      base_updated_at AS baseUpdatedAt,
      summary,
      created_at AS createdAt,
      expires_at AS expiresAt,
      used_at AS usedAt
    FROM mcp_pending_changes
    WHERE id = ?
  `).get(changeId) as McpPendingChangeRow | undefined
) ?? null;

const readRevisionRows = (database: DatabaseSync, userId = 'user-1'): McpRevisionRow[] => (
  database.prepare(`
    SELECT
      id,
      user_id AS userId,
      payload,
      source,
      created_at AS createdAt,
      expires_at AS expiresAt,
      restored_at AS restoredAt
    FROM user_data_revisions
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(userId) as McpRevisionRow[]
);

const completedWorkoutFromPlan = (data: AppData): WorkoutSession => {
  const day = data.plan.days[0];
  const plannedExercises = day.exercises.slice(0, 2).map((exercise, index) => ({
    plannedExerciseId: exercise.id,
    exerciseId: exercise.exerciseId,
    name: exercise.name,
    sets: exercise.sets,
    repMin: exercise.repMin,
    repMax: exercise.repMax,
    restSeconds: exercise.restSeconds,
    warmupSets: exercise.warmupSets ?? 0,
    progressionPolicy: exercise.progressionPolicy ?? 'double',
    progressionIncrementKg: exercise.progressionIncrementKg ?? 2.5,
    completed: true,
    difficulty: 'good' as const,
    actualWeightKg: 40 + index * 5,
    actualReps: exercise.repMax,
    discomfort: false,
    completedAt: '2026-08-31T21:00:00.000Z',
    setLogs: Array.from({ length: exercise.sets + (exercise.warmupSets ?? 0) }, (_, setIndex) => ({
      setNumber: setIndex + 1,
      phase: setIndex < (exercise.warmupSets ?? 0) ? 'warmup' as const : 'work' as const,
      targetReps: setIndex < (exercise.warmupSets ?? 0) ? exercise.repMin : exercise.repMax,
      actualReps: setIndex < (exercise.warmupSets ?? 0) ? exercise.repMin : exercise.repMax,
      weightKg: setIndex < (exercise.warmupSets ?? 0) ? 20 : 40 + index * 5,
      completed: true,
    })),
  }));

  return {
    id: 'client-session-1',
    workoutDayId: day.id,
    dateKey: '2026-08-31',
    startedAt: '2026-08-31T20:00:00.000Z',
    completedAt: '2026-08-31T21:00:00.000Z',
    status: 'completed',
    activeExerciseIndex: 0,
    plannedExercises,
  };
};

const checkin = (patch: Partial<WeeklyCheckin> = {}): WeeklyCheckin => ({
  id: 'checkin-1',
  weekKey: '2026-08-31',
  createdAt: '2026-09-01T08:00:00.000Z',
  weightKg: 79.4,
  waistCm: 84,
  feeling: 'Semana sólida',
  energy: 'high',
  completedWorkouts: 4,
  note: 'Dormí mejor',
  ...patch,
});

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

  it('expone las herramientas MCP de escritura y recuperación previstas', () => {
    expect(MCP_WRITE_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'update_profile',
      'replace_routine',
      'record_workout',
      'add_measurement',
      'add_checkin',
      'preview_change',
      'apply_change',
      'list_revisions',
      'restore_revision',
    ]);
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

    const invalidDayWorkout = structuredClone(validWorkout);
    invalidDayWorkout.workoutDayId = 'other-day';
    expect(() => validateMcpWriteOperation({ kind: 'record_workout', workout: invalidDayWorkout }, validationContext)).toThrow(/workoutDayId|plan|válid/i);
  });

  it('validateMcpWriteRequest falla cerrada para record_workout sin contexto y exige el plan autenticado', () => {
    const workout = {
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

    expect(() => validateMcpWriteRequest({
      userId: 'user-1',
      clientId: 'client-1',
      operation: { kind: 'record_workout', workout },
    })).toThrow(/contexto|record_workout|plan/i);

    expect(() => validateMcpWriteRequest({
      userId: 'user-1',
      clientId: 'client-1',
      baseUpdatedAt: '2026-08-31T21:00:00.000Z',
      operation: { kind: 'record_workout', workout },
    }, {
      plan: { days: [{ id: 'custom-day' }] },
      exercises: [{ id: 'custom-exercise-1' }],
    })).not.toThrow();
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

  it('actualiza solo el perfil permitido cuando la versión base coincide', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.profile.gym = 'Gimnasio base';
    data.profile.goal = 'Ganar masa';
    const baseUpdatedAt = seedUserData(database, data);

    const result = await writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', baseUpdatedAt, {
      kind: 'update_profile',
      profile: { gym: 'Evanfit Picanya' },
    });

    expect(result).toMatchObject({
      updatedAt: expect.any(String),
      summary: {
        kind: 'update_profile',
        changedFields: ['gym'],
      },
    });

    const stored = await readStoredSnapshot(database);
    expect(stored.updatedAt).not.toBe(baseUpdatedAt);
    expect(stored.data?.profile.gym).toBe('Evanfit Picanya');
    expect(stored.data?.profile.goal).toBe('Ganar masa');
    expect(stored.data?.plan).toEqual(data.plan);
    expect(stored.data?.sessions).toEqual(data.sessions);
    database.close();
  });

  it('devuelve needs_version y no escribe nada cuando falta la versión base', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.profile.gym = 'Gimnasio base';
    const baseUpdatedAt = seedUserData(database, data);
    const before = await readStoredSnapshot(database);

    const result = await writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', undefined, {
      kind: 'update_profile',
      profile: { gym: 'Otro gimnasio' },
    });

    expect(result).toMatchObject({
      error: 'needs_version',
      updatedAt: baseUpdatedAt,
    });

    const after = await readStoredSnapshot(database);
    expect(after).toEqual(before);
    database.close();
  });

  it('devuelve conflicto stale y relee solo la fila actual del usuario sin sobrescribirla', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.profile.gym = 'Versión nueva';
    seedUserData(database, data, '2026-08-31T21:05:00.000Z');

    const result = await writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', '2026-08-31T21:00:00.000Z', {
      kind: 'update_profile',
      profile: { gym: 'Intento obsoleto' },
    });

    expect(result).toMatchObject({
      error: 'conflict',
      updatedAt: '2026-08-31T21:05:00.000Z',
      data: {
        profile: {
          gym: 'Versión nueva',
        },
      },
    });

    const stored = await readStoredPayload(database);
    expect(stored.profile.gym).toBe('Versión nueva');
    database.close();
  });

  it('rechaza un clientId válido vinculado a otro usuario sin escribir ni releer datos ajenos', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.profile.gym = 'Privado';
    const baseUpdatedAt = seedUserData(database, data);
    run(database, 'INSERT INTO users (id) VALUES (?)', 'user-2');
    run(database, 'INSERT INTO mcp_clients (client_id) VALUES (?)', 'client-2');
    seedActiveAccessToken(database, { userId: 'user-2', clientId: 'client-2' });

    const result = await writeMcpData(d1FromSqlite(database), 'user-1', 'client-2', baseUpdatedAt, {
      kind: 'update_profile',
      profile: { gym: 'No debería pasar' },
    });

    expect(result).toMatchObject({
      error: 'conflict',
      updatedAt: null,
      data: null,
    });

    const stored = await readStoredPayload(database);
    expect(stored.profile.gym).toBe('Privado');
    database.close();
  });

  it('reemplaza la rutina completa sin tocar perfil, progreso ni check-ins', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.progress = [{ id: 'progress-1', date: '2026-08-20', weightKg: 80 }];
    data.checkins = [checkin()];
    const baseUpdatedAt = seedUserData(database, data);

    const exercises = structuredClone(data.exercises).slice(0, 2);
    const plan = {
      id: 'strength-plan',
      version: 2,
      days: [{
        id: 'strength-day',
        weekday: 2,
        shortLabel: 'M',
        name: 'Empuje',
        focus: 'Pecho',
        exercises: [{
          id: 'strength-day-1',
          exerciseId: exercises[0].id,
          name: exercises[0].name,
          sets: 4,
          repMin: 6,
          repMax: 8,
          restSeconds: 150,
          active: true,
          warmupSets: 1,
          progressionPolicy: 'double' as const,
          progressionIncrementKg: 2.5,
          imageUrl: exercises[0].imageUrl,
          imagePosition: exercises[0].imagePosition,
        }],
      }],
    };

    const result = await writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', baseUpdatedAt, {
      kind: 'replace_routine',
      plan,
      exercises,
    });

    expect(result).toMatchObject({
      updatedAt: expect.any(String),
      summary: {
        kind: 'replace_routine',
        planId: 'strength-plan',
        planVersion: 2,
        dayCount: 1,
        exerciseCount: 2,
      },
    });

    const stored = await readStoredPayload(database);
    expect(stored.plan).toEqual(plan);
    expect(stored.exercises).toEqual(exercises);
    expect(stored.profile).toEqual(data.profile);
    expect(stored.progress).toEqual(data.progress);
    expect(stored.checkins).toEqual(data.checkins);
    database.close();
  });

  it('falla en replace_routine sin escrituras parciales cuando el plan no cuadra con el catálogo enviado', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    const baseUpdatedAt = seedUserData(database, data);
    const before = await readStoredSnapshot(database);
    const exercises = structuredClone(data.exercises).slice(0, 1);

    await expect(writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', baseUpdatedAt, {
      kind: 'replace_routine',
      plan: {
        id: 'broken-plan',
        version: 2,
        days: [{
          id: 'broken-day',
          weekday: 2,
          shortLabel: 'M',
          name: 'Empuje',
          focus: 'Pecho',
          exercises: [{
            id: 'broken-day-1',
            exerciseId: 'invented-exercise',
            name: 'Inventado',
            sets: 4,
            repMin: 6,
            repMax: 8,
            restSeconds: 150,
            active: true,
          }],
        }],
      },
      exercises,
    })).rejects.toThrow(/exerciseId|catálogo|válid/i);

    const after = await readStoredSnapshot(database);
    expect(after).toEqual(before);
    database.close();
  });

  it('registra un entrenamiento completado con ID generado por servidor y validado contra el snapshot autenticado', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    const baseUpdatedAt = seedUserData(database, data);
    const workout = completedWorkoutFromPlan(data);

    const result = await writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', baseUpdatedAt, {
      kind: 'record_workout',
      workout,
    });

    expect(result).toMatchObject({
      updatedAt: expect.any(String),
      summary: {
        kind: 'record_workout',
        workoutDayId: workout.workoutDayId,
        dateKey: workout.dateKey,
        completedExercises: 2,
      },
    });

    const stored = await readStoredPayload(database);
    expect(stored.sessions).toHaveLength(1);
    expect(stored.sessions[0]?.id).not.toBe(workout.id);
    expect(stored.sessions[0]).toMatchObject({
      workoutDayId: workout.workoutDayId,
      status: 'completed',
      dateKey: workout.dateKey,
    });
    database.close();
  });

  it('rechaza record_workout inválido sin escribir parcialmente sesiones', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    const baseUpdatedAt = seedUserData(database, data);
    const before = await readStoredSnapshot(database);
    const invalidWorkout = completedWorkoutFromPlan(data);
    invalidWorkout.plannedExercises[0] = {
      ...invalidWorkout.plannedExercises[0],
      exerciseId: 'invented-exercise',
    };

    await expect(writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', baseUpdatedAt, {
      kind: 'record_workout',
      workout: invalidWorkout,
    })).rejects.toThrow(/exerciseId|catálogo|válid/i);

    const after = await readStoredSnapshot(database);
    expect(after).toEqual(before);
    database.close();
  });

  it('añade una medición tocando solo progress y devuelve resumen', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.profile.currentWeightKg = 80;
    const baseUpdatedAt = seedUserData(database, data);

    const result = await writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', baseUpdatedAt, {
      kind: 'add_measurement',
      entry: { id: 'progress-1', date: '2026-09-01', weightKg: 79.4, waistCm: 84 },
    });

    expect(result).toMatchObject({
      updatedAt: expect.any(String),
      summary: {
        kind: 'add_measurement',
        entryId: 'progress-1',
        date: '2026-09-01',
      },
    });

    const stored = await readStoredPayload(database);
    expect(stored.progress).toEqual([{ id: 'progress-1', date: '2026-09-01', weightKg: 79.4, waistCm: 84 }]);
    expect(stored.profile.currentWeightKg).toBe(80);
    expect(stored.sessions).toEqual(data.sessions);
    database.close();
  });

  it('falla en add_measurement sin escrituras parciales si la nueva entrada rompe la validez', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.progress = [{ id: 'progress-1', date: '2026-08-20', weightKg: 80 }];
    const baseUpdatedAt = seedUserData(database, data);
    const before = await readStoredSnapshot(database);

    await expect(writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', baseUpdatedAt, {
      kind: 'add_measurement',
      entry: { id: 'progress-1', date: '2026-09-01', weightKg: 79.4 },
    })).rejects.toThrow(/duplicado|progress\[1\]\.id/i);

    const after = await readStoredSnapshot(database);
    expect(after).toEqual(before);
    database.close();
  });

  it('hace upsert semanal en add_checkin sin duplicar weekKey y solo toca checkins', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.progress = [{ id: 'progress-1', date: '2026-08-20', weightKg: 80 }];
    data.checkins = [checkin({ id: 'checkin-old', note: 'Nota anterior', energy: 'normal' })];
    const baseUpdatedAt = seedUserData(database, data);

    const result = await writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', baseUpdatedAt, {
      kind: 'add_checkin',
      checkin: checkin({ id: 'checkin-new', note: 'Nueva nota', completedWorkouts: 5 }),
    });

    expect(result).toMatchObject({
      updatedAt: expect.any(String),
      summary: {
        kind: 'add_checkin',
        weekKey: '2026-08-31',
        replacedExisting: true,
      },
    });

    const stored = await readStoredPayload(database);
    expect(stored.checkins).toHaveLength(1);
    expect(stored.checkins[0]).toMatchObject({
      id: 'checkin-new',
      weekKey: '2026-08-31',
      note: 'Nueva nota',
      completedWorkouts: 5,
    });
    expect(stored.progress).toEqual(data.progress);
    expect(stored.profile).toEqual(data.profile);
    database.close();
  });

  it('rechaza add_checkin si el snapshot ya contiene weekKey duplicada y no deja escrituras parciales', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.checkins = [
      checkin({ id: 'checkin-a' }),
      checkin({ id: 'checkin-b' }),
    ];
    const baseUpdatedAt = seedUserData(database, data);
    const before = await readStoredSnapshot(database);

    await expect(writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', baseUpdatedAt, {
      kind: 'add_checkin',
      checkin: checkin({ id: 'checkin-c', note: 'No debería escribir' }),
    })).rejects.toThrow(/weekKey|duplicad/i);

    const after = await readStoredSnapshot(database);
    expect(after).toEqual(before);
    database.close();
  });

  it('crea previews destructivos sin mutar y exige una única confirmación para aplicar', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    const workout = completedWorkoutFromPlan(data);
    data.sessions = [workout];
    data.progress = [{ id: 'progress-1', date: '2026-08-20', weightKg: 80 }];
    data.checkins = [checkin()];
    const baseUpdatedAt = seedUserData(database, data);

    const preview = await previewChange(d1FromSqlite(database), 'user-1', 'client-1', {
      kind: 'delete_workout',
      workoutId: workout.id,
      baseUpdatedAt,
    });

    expect(preview).toMatchObject({
      changeId: expect.any(String),
      expiresAt: expect.any(String),
      summary: {
        kind: 'delete_workout',
        workoutId: workout.id,
      },
    });

    const pending = readPendingChangeRow(database, preview.changeId);
    expect(pending).toMatchObject({
      userId: 'user-1',
      clientId: 'client-1',
      kind: 'delete_workout',
      baseUpdatedAt,
      usedAt: null,
    });
    expect(JSON.parse(pending?.payload ?? '{}')).toMatchObject({ kind: 'delete_workout', workoutId: workout.id });
    expect(JSON.parse(pending?.summary ?? '{}')).toMatchObject({ kind: 'delete_workout', workoutId: workout.id });
    expect((await readStoredPayload(database)).sessions).toHaveLength(1);

    await expect(applyChange(d1FromSqlite(database), 'user-1', 'client-1', preview.changeId, false)).resolves.toMatchObject({
      error: 'confirmation_required',
    });
    expect(readPendingChangeRow(database, preview.changeId)?.usedAt).toBeNull();
    expect((await readStoredPayload(database)).sessions).toHaveLength(1);

    await expect(applyChange(d1FromSqlite(database), 'user-1', 'client-1', preview.changeId, true)).resolves.toMatchObject({
      updatedAt: expect.any(String),
      revisionId: expect.any(String),
      summary: {
        kind: 'delete_workout',
        workoutId: workout.id,
      },
    });

    const afterApply = await readStoredPayload(database);
    expect(afterApply.sessions).toEqual([]);
    expect(afterApply.progress).toEqual(data.progress);
    expect(afterApply.checkins).toEqual(data.checkins);
    expect(readPendingChangeRow(database, preview.changeId)?.usedAt).toEqual(expect.any(String));
    expect(readRevisionRows(database)).toHaveLength(1);

    await expect(applyChange(d1FromSqlite(database), 'user-1', 'client-1', preview.changeId, true)).resolves.toMatchObject({
      error: 'change_unavailable',
    });
    expect((await readStoredPayload(database)).sessions).toEqual([]);
    database.close();
  });

  it('bloquea propuestas foreign, expirada o stale sin mutar datos ni marcarlas como usadas', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    const workout = completedWorkoutFromPlan(data);
    data.sessions = [workout];
    data.progress = [{ id: 'progress-1', date: '2026-08-20', weightKg: 80 }];
    data.checkins = [checkin()];
    const baseUpdatedAt = seedUserData(database, data);
    run(database, 'INSERT INTO mcp_clients (client_id) VALUES (?)', 'client-2');
    seedActiveAccessToken(database, { userId: 'user-1', clientId: 'client-2' });

    const foreignPreview = await previewChange(d1FromSqlite(database), 'user-1', 'client-1', {
      kind: 'delete_measurement',
      measurementId: 'progress-1',
      baseUpdatedAt,
    });

    await expect(applyChange(d1FromSqlite(database), 'user-1', 'client-2', foreignPreview.changeId, true)).resolves.toMatchObject({
      error: 'change_unavailable',
    });
    expect((await readStoredPayload(database)).progress).toHaveLength(1);
    expect(readPendingChangeRow(database, foreignPreview.changeId)?.usedAt).toBeNull();

    const expiredPreview = await previewChange(d1FromSqlite(database), 'user-1', 'client-1', {
      kind: 'delete_checkin',
      checkinId: 'checkin-1',
      baseUpdatedAt,
    });
    run(database, 'UPDATE mcp_pending_changes SET expires_at = ? WHERE id = ?', '2026-08-31T20:59:00.000Z', expiredPreview.changeId);

    await expect(applyChange(d1FromSqlite(database), 'user-1', 'client-1', expiredPreview.changeId, true)).resolves.toMatchObject({
      error: 'change_unavailable',
    });
    expect((await readStoredPayload(database)).checkins).toHaveLength(1);
    expect(readPendingChangeRow(database, expiredPreview.changeId)?.usedAt).toBeNull();

    const stalePreview = await previewChange(d1FromSqlite(database), 'user-1', 'client-1', {
      kind: 'delete_workout',
      workoutId: workout.id,
      baseUpdatedAt,
    });
    const newer = structuredClone(await readStoredPayload(database));
    newer.profile.gym = 'Versión más nueva';
    run(
      database,
      'UPDATE user_data SET payload = ?, updated_at = ? WHERE user_id = ?',
      JSON.stringify(newer),
      '2026-08-31T21:05:00.000Z',
      'user-1',
    );

    await expect(applyChange(d1FromSqlite(database), 'user-1', 'client-1', stalePreview.changeId, true)).resolves.toMatchObject({
      error: 'conflict',
      updatedAt: '2026-08-31T21:05:00.000Z',
      data: {
        profile: {
          gym: 'Versión más nueva',
        },
      },
    });
    expect((await readStoredPayload(database)).sessions).toHaveLength(1);
    expect(readPendingChangeRow(database, stalePreview.changeId)?.usedAt).toBeNull();
    database.close();
  });

  it('borra workout, measurement y check-in solo al aplicar la propuesta confirmada', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    const workout = completedWorkoutFromPlan(data);
    data.sessions = [workout];
    data.progress = [{ id: 'progress-1', date: '2026-08-20', weightKg: 80 }];
    data.checkins = [checkin()];
    const baseUpdatedAt = seedUserData(database, data);

    const deleteWorkout = await previewChange(d1FromSqlite(database), 'user-1', 'client-1', {
      kind: 'delete_workout',
      workoutId: workout.id,
      baseUpdatedAt,
    });
    const workoutResult = await applyChange(d1FromSqlite(database), 'user-1', 'client-1', deleteWorkout.changeId, true);
    expect(workoutResult).toMatchObject({
      summary: {
        kind: 'delete_workout',
        deleted: true,
        workoutId: workout.id,
      },
    });
    expect((await readStoredPayload(database)).sessions).toEqual([]);
    const afterWorkoutDeleteUpdatedAt = (await readStoredSnapshot(database)).updatedAt as string;

    const deleteMeasurement = await previewChange(d1FromSqlite(database), 'user-1', 'client-1', {
      kind: 'delete_measurement',
      measurementId: 'progress-1',
      baseUpdatedAt: afterWorkoutDeleteUpdatedAt,
    });
    const measurementResult = await applyChange(d1FromSqlite(database), 'user-1', 'client-1', deleteMeasurement.changeId, true);
    expect(measurementResult).toMatchObject({
      summary: {
        kind: 'delete_measurement',
        deleted: true,
        measurementId: 'progress-1',
      },
    });
    expect((await readStoredPayload(database)).progress).toEqual([]);
    const afterMeasurementDeleteUpdatedAt = (await readStoredSnapshot(database)).updatedAt as string;

    const deleteCheckin = await previewChange(d1FromSqlite(database), 'user-1', 'client-1', {
      kind: 'delete_checkin',
      checkinId: 'checkin-1',
      baseUpdatedAt: afterMeasurementDeleteUpdatedAt,
    });
    const checkinResult = await applyChange(d1FromSqlite(database), 'user-1', 'client-1', deleteCheckin.changeId, true);
    expect(checkinResult).toMatchObject({
      summary: {
        kind: 'delete_checkin',
        deleted: true,
        checkinId: 'checkin-1',
      },
    });
    expect((await readStoredPayload(database)).checkins).toEqual([]);

    await expect(writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', afterMeasurementDeleteUpdatedAt, {
      kind: 'delete_checkin',
      checkinId: 'checkin-1',
    })).rejects.toThrow(/preview|apply|destructiv/i);
    database.close();
  });

  it('reemplaza o elimina toda la copia activa solo mediante preview y apply', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.sessions = [completedWorkoutFromPlan(data)];
    data.progress = [{ id: 'progress-1', date: '2026-08-20', weightKg: 80 }];
    data.checkins = [checkin()];
    const baseUpdatedAt = seedUserData(database, data);

    const replacement = structuredClone(data);
    replacement.profile.gym = 'Nuevo gimnasio';
    replacement.progress = [{ id: 'progress-2', date: '2026-09-01', weightKg: 79.2 }];
    replacement.checkins = [];

    const replacePreview = await previewChange(d1FromSqlite(database), 'user-1', 'client-1', {
      kind: 'replace_all_data',
      data: replacement,
      baseUpdatedAt,
    });
    expect((await readStoredPayload(database)).profile.gym).not.toBe('Nuevo gimnasio');

    const replaceResult = await applyChange(d1FromSqlite(database), 'user-1', 'client-1', replacePreview.changeId, true);
    expect(replaceResult).toMatchObject({
      updatedAt: expect.any(String),
      revisionId: expect.any(String),
      summary: {
        kind: 'replace_all_data',
      },
    });
    expect(await readStoredPayload(database)).toEqual(validateMcpAppData(replacement));
    const afterReplaceUpdatedAt = (await readStoredSnapshot(database)).updatedAt as string;

    const deletePreview = await previewChange(d1FromSqlite(database), 'user-1', 'client-1', {
      kind: 'delete_all_data',
      baseUpdatedAt: afterReplaceUpdatedAt,
    });
    const deleteResult = await applyChange(d1FromSqlite(database), 'user-1', 'client-1', deletePreview.changeId, true);
    expect(deleteResult).toMatchObject({
      updatedAt: expect.any(String),
      revisionId: expect.any(String),
      summary: {
        kind: 'delete_all_data',
      },
    });
    await expect(loadMcpUserData(d1FromSqlite(database), 'user-1')).resolves.toEqual({ data: null });
    expect(readRevisionRows(database)).toHaveLength(2);
    database.close();
  });

  it('lista revisiones vigentes del usuario, purga las caducadas y restaura creando una nueva versión activa', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.profile.gym = 'Original';
    const baseUpdatedAt = seedUserData(database, data);

    const updateResult = await writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', baseUpdatedAt, {
      kind: 'update_profile',
      profile: { gym: 'Actualizado' },
    });
    expect(updateResult).toMatchObject({ updatedAt: expect.any(String) });
    const currentUpdatedAt = (updateResult as { updatedAt: string }).updatedAt;
    run(database, 'INSERT INTO users (id) VALUES (?)', 'user-2');
    run(
      database,
      'INSERT INTO user_data_revisions (id, user_id, payload, source, created_at, expires_at, restored_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'expired-user-1',
      'user-1',
      JSON.stringify(defaultData()),
      'manual',
      '2026-07-01T00:00:00.000Z',
      '2026-07-31T00:00:00.000Z',
      null,
    );
    run(
      database,
      'INSERT INTO user_data_revisions (id, user_id, payload, source, created_at, expires_at, restored_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'other-user',
      'user-2',
      JSON.stringify(defaultData()),
      'manual',
      '2026-08-31T21:00:00.000Z',
      '2026-09-30T21:00:00.000Z',
      null,
    );

    const revisions = await listRevisions(d1FromSqlite(database), 'user-1');
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      id: expect.any(String),
      source: 'automatic',
      restoredAt: null,
    });
    expect(readRevisionRows(database).map((revision) => revision.id)).not.toContain('expired-user-1');
    expect(readRevisionRows(database, 'user-2').map((revision) => revision.id)).toContain('other-user');

    const revisionId = revisions[0]?.id;
    if (!revisionId) throw new Error('Se esperaba una revisión para restaurar en el test.');

    await expect(restoreRevision(d1FromSqlite(database), 'user-1', 'client-1', revisionId, currentUpdatedAt)).resolves.toMatchObject({
      updatedAt: expect.any(String),
      revisionId: expect.any(String),
      summary: {
        kind: 'restore_revision',
        restoredFromRevisionId: revisionId,
      },
    });

    const restored = await readStoredPayload(database);
    expect(restored.profile.gym).toBe('Original');
    const sourceRevision = readRevisionRows(database).find((revision) => revision.id === revisionId);
    expect(sourceRevision?.restoredAt).toEqual(expect.any(String));
    expect(readRevisionRows(database)).toHaveLength(2);
    database.close();
  });

  it('exige baseUpdatedAt para restore_revision y no restaura revisiones ajenas', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.profile.gym = 'Original';
    const baseUpdatedAt = seedUserData(database, data);
    const updateResult = await writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', baseUpdatedAt, {
      kind: 'update_profile',
      profile: { gym: 'Actualizado' },
    });
    expect(updateResult).toMatchObject({ updatedAt: expect.any(String) });
    run(database, 'INSERT INTO users (id) VALUES (?)', 'user-2');
    run(
      database,
      'INSERT INTO user_data_revisions (id, user_id, payload, source, created_at, expires_at, restored_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'foreign-revision',
      'user-2',
      JSON.stringify(defaultData()),
      'manual',
      '2026-08-31T21:00:00.000Z',
      '2026-09-30T21:00:00.000Z',
      null,
    );

    await expect(writeMcpData(d1FromSqlite(database), 'user-1', 'client-1', undefined, {
      kind: 'restore_revision',
      revisionId: readRevisionRows(database)[0]?.id ?? 'missing',
    })).resolves.toMatchObject({
      error: 'needs_version',
    });

    await expect(restoreRevision(d1FromSqlite(database), 'user-1', 'client-1', 'foreign-revision', (updateResult as { updatedAt: string }).updatedAt)).resolves.toMatchObject({
      error: 'change_unavailable',
    });
    expect((await readStoredPayload(database)).profile.gym).toBe('Actualizado');
    database.close();
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

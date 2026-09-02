import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { defaultData } from '../src/data/initialPlan';
import { onRequestPost as onMcpPost } from '../functions/api/mcp';
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
import { hasMcpScope, isAllowedRedirectUri, normalizeScope, sha256 } from '../functions/lib/mcpAuth';
import { consentPage } from '../functions/api/mcp/authorize';
import { onRequestGet as onProtectedResourceGet } from '../functions/.well-known/oauth-protected-resource';
import type { AppData, WeeklyCheckin, WorkoutSession } from '../src/types';
import type { D1DatabaseLike, McpPendingChangeRow, McpReplaceRoutineOperation, McpRevisionRow, SyncContext } from '../functions/types';

const TEST_NOW = new Date('2026-09-01T12:00:00.000Z');

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(TEST_NOW);
});

afterAll(() => {
  vi.useRealTimers();
});

const loadMigration = (filename = '0006_mcp_revisions.sql'): string => readFileSync(resolve(process.cwd(), 'migrations', filename), 'utf8');

const openBaseDatabase = (): DatabaseSync => {
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
  return database;
};

const openMigratedDatabase = (): DatabaseSync => {
  const database = openBaseDatabase();
  database.exec(loadMigration('0006_mcp_revisions.sql'));
  database.exec(loadMigration('0007_mcp_recovery_hardening.sql'));
  return database;
};

type SqlInputValue = null | number | bigint | string | NodeJS.ArrayBufferView;

const toSqlInputValue = (value: unknown): SqlInputValue => {
  if (value === null || typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
  if (ArrayBuffer.isView(value)) return value as NodeJS.ArrayBufferView;
  throw new TypeError('El adaptador SQLite del test recibió un parámetro no compatible.');
};

const run = (database: DatabaseSync, sql: string, ...params: SqlInputValue[]): void => {
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

const seedBearerAccessToken = async (
  database: DatabaseSync,
  {
    bearer = 'access-token',
    userId = 'user-1',
    clientId = 'client-1',
    scope = 'radian:read radian:write',
    expiresAt = '2026-09-01T20:00:00.000Z',
  }: { bearer?: string; userId?: string; clientId?: string; scope?: string; expiresAt?: string } = {},
): Promise<string> => {
  run(database, 'INSERT OR IGNORE INTO users (id) VALUES (?)', userId);
  run(database, 'INSERT OR IGNORE INTO mcp_clients (client_id) VALUES (?)', clientId);
  run(
    database,
    'INSERT INTO mcp_tokens (token_hash, token_type, client_id, user_id, scope, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    await sha256(bearer),
    'access',
    clientId,
    userId,
    scope,
    '2026-08-31T20:00:00.000Z',
    expiresAt,
    null,
  );
  return bearer;
};

type McpPreviewSuccess = Extract<Awaited<ReturnType<typeof previewChange>>, { changeId: string }>;

const previewChangeOrThrow = async (...args: Parameters<typeof previewChange>): Promise<McpPreviewSuccess> => {
  const result = await previewChange(...args);
  if (!('changeId' in result)) throw new Error('Se esperaba una propuesta MCP válida en el test.');
  return result;
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

const readSqliteRows = <T>(database: DatabaseSync, sql: string, ...params: SqlInputValue[]): T[] => (
  database.prepare(sql).all(...params) as unknown as T[]
);

const readSqliteRow = <T>(database: DatabaseSync, sql: string, ...params: SqlInputValue[]): T | undefined => (
  database.prepare(sql).get(...params) as unknown as T | undefined
);

const readRevisionRows = (database: DatabaseSync, userId = 'user-1'): McpRevisionRow[] => (
  readSqliteRows<McpRevisionRow>(database, `
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
  `, userId)
);

const readRevisionRow = (database: DatabaseSync, revisionId: string): McpRevisionRow | null => (
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
    WHERE id = ?
  `).get(revisionId) as McpRevisionRow | undefined
) ?? null;

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

const d1FromSqlite = (
  database: DatabaseSync,
  options: { beforeRun?: (query: string) => void | Promise<void>; onPrepare?: (query: string) => void } = {},
): D1DatabaseLike => ({
  prepare(query: string) {
    options.onPrepare?.(query);
    const statement = database.prepare(query);
    let boundValues: SqlInputValue[] = [];
    return {
      bind(...values: unknown[]) {
        boundValues = values.map(toSqlInputValue);
        return this;
      },
      async first<T = Record<string, unknown>>() {
        return (statement.get(...boundValues) as T | undefined) ?? null;
      },
      async all<T = Record<string, unknown>>() {
        return { results: statement.all(...boundValues) as T[] };
      },
      async run() {
        await options.beforeRun?.(query);
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
  async batch(statements) {
    database.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      database.exec('COMMIT');
      return results;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  },
});

const createMcpContext = (
  database: D1DatabaseLike,
  body: Record<string, unknown>,
  bearer?: string,
): SyncContext => ({
  request: new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  }),
  env: { DB: database },
});

const failingD1 = (message = 'D1 no debería consultarse'): D1DatabaseLike => ({
  prepare() {
    throw new Error(message);
  },
  async batch() {
    throw new Error(message);
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

  it('lista solo herramientas de lectura con radian:read y añade las de escritura con radian:write', async () => {
    const database = openMigratedDatabase();
    const readBearer = await seedBearerAccessToken(database, { bearer: 'read-only', scope: 'radian:read' });
    const readOnlyResponse = await onMcpPost(createMcpContext(
      d1FromSqlite(database),
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      readBearer,
    ));

    expect(readOnlyResponse.status).toBe(200);
    await expect(readOnlyResponse.json()).resolves.toMatchObject({
      result: {
        tools: MCP_TOOL_DEFINITIONS,
      },
    });

    const writeBearer = await seedBearerAccessToken(database, {
      bearer: 'read-write',
      clientId: 'writer-client',
      scope: 'radian:read radian:write',
    });
    const readWriteResponse = await onMcpPost(createMcpContext(
      d1FromSqlite(database),
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      writeBearer,
    ));

    expect(readWriteResponse.status).toBe(200);
    await expect(readWriteResponse.json()).resolves.toMatchObject({
      result: {
        tools: [...MCP_TOOL_DEFINITIONS, ...MCP_WRITE_TOOL_DEFINITIONS],
      },
    });
    database.close();
  });

  it('initialize refleja el scope autenticado sin romper clientes read-only', async () => {
    const database = openMigratedDatabase();
    const readBearer = await seedBearerAccessToken(database, { bearer: 'init-read', scope: 'radian:read' });
    const readResponse = await onMcpPost(createMcpContext(
      d1FromSqlite(database),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2026-07-28' },
      },
      readBearer,
    ));

    expect(readResponse.status).toBe(200);
    await expect(readResponse.json()).resolves.toMatchObject({
      result: {
        protocolVersion: '2026-07-28',
        instructions: expect.stringContaining('solo lectura'),
      },
    });

    const writeBearer = await seedBearerAccessToken(database, {
      bearer: 'init-write',
      clientId: 'init-writer',
      scope: 'radian:read radian:write',
    });
    const writeResponse = await onMcpPost(createMcpContext(
      d1FromSqlite(database),
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: { protocolVersion: '2026-07-28' },
      },
      writeBearer,
    ));

    expect(writeResponse.status).toBe(200);
    await expect(writeResponse.json()).resolves.toMatchObject({
      result: {
        protocolVersion: '2026-07-28',
        instructions: expect.stringContaining('lectura y escritura'),
      },
    });
    database.close();
  });

  it('devuelve 401 cuando falta el bearer', async () => {
    const database = openMigratedDatabase();
    const response = await onMcpPost(createMcpContext(
      d1FromSqlite(database),
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    ));

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Bearer realm="radian"');
    await expect(response.json()).resolves.toMatchObject({
      error: 'unauthorized',
    });
    database.close();
  });

  it('rechaza un bearer OAuth expirado', async () => {
    const database = openMigratedDatabase();
    const bearer = await seedBearerAccessToken(database, {
      bearer: 'expired-access',
      expiresAt: '2026-09-01T11:59:59.999Z',
    });

    const response = await onMcpPost(createMcpContext(
      d1FromSqlite(database),
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      bearer,
    ));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: 'unauthorized',
    });
    database.close();
  });

  it('rechaza mutaciones cuando el bearer solo tiene radian:read', async () => {
    const database = openMigratedDatabase();
    const queries: string[] = [];
    const bearer = await seedBearerAccessToken(database, { bearer: 'read-mutate', scope: 'radian:read' });

    const response = await onMcpPost(createMcpContext(
      d1FromSqlite(database, {
        onPrepare(query) {
          queries.push(query);
        },
        async beforeRun(query) {
          throw new Error(`No debería escribir en D1: ${query}`);
        },
      }),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'update_profile',
          arguments: {
            baseUpdatedAt: '2026-08-31T21:00:00.000Z',
            profile: { gym: 'No autorizado' },
          },
        },
      },
      bearer,
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        isError: true,
        structuredContent: {
          error: 'insufficient_scope',
          requiredScope: 'radian:write',
        },
      },
    });
    expect(queries.some((query) => query.includes('FROM user_data'))).toBe(false);
    database.close();
  });

  it('despacha escrituras usando userId y clientId autenticados del bearer', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    run(database, 'INSERT INTO users (id) VALUES (?)', 'writer-user');
    run(database, 'INSERT INTO mcp_clients (client_id) VALUES (?)', 'writer-client');
    run(database, 'INSERT INTO user_data (user_id, payload, updated_at) VALUES (?, ?, ?)', 'writer-user', JSON.stringify(data), '2026-08-31T21:00:00.000Z');
    const bearer = await seedBearerAccessToken(database, {
      bearer: 'writer-token',
      userId: 'writer-user',
      clientId: 'writer-client',
      scope: 'radian:read radian:write',
    });

    const response = await onMcpPost(createMcpContext(
      d1FromSqlite(database),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'update_profile',
          arguments: {
            baseUpdatedAt: '2026-08-31T21:00:00.000Z',
            profile: { gym: 'Evanfit Picanya' },
          },
        },
      },
      bearer,
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      result: {
        isError: false,
        structuredContent: {
          summary: {
            kind: 'update_profile',
            changedFields: ['gym'],
          },
        },
      },
    });

    const stored = await loadMcpUserData(d1FromSqlite(database), 'writer-user');
    expect(stored.data?.profile.gym).toBe('Evanfit Picanya');
    database.close();
  });

  it('devuelve -32602 para argumentos malformed sin tocar user_data ni escribir en D1', async () => {
    const database = openMigratedDatabase();
    const queries: string[] = [];
    const bearer = await seedBearerAccessToken(database, {
      bearer: 'bad-args',
      scope: 'radian:read radian:write',
    });

    const response = await onMcpPost(createMcpContext(
      d1FromSqlite(database, {
        onPrepare(query) {
          queries.push(query);
        },
        async beforeRun(query) {
          throw new Error(`No debería escribir en D1: ${query}`);
        },
      }),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'update_profile',
          arguments: {
            baseUpdatedAt: 'no-es-iso',
            profile: 'malformed',
          },
        },
      },
      bearer,
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32602,
      },
    });
    expect(queries.some((query) => query.includes('FROM user_data'))).toBe(false);
    expect(queries.some((query) => query.includes('UPDATE user_data'))).toBe(false);
    database.close();
  });

  it('devuelve -32602 cuando record_workout llega sin baseUpdatedAt y no consulta user_data', async () => {
    const database = openMigratedDatabase();
    const queries: string[] = [];
    const bearer = await seedBearerAccessToken(database, {
      bearer: 'record-no-version',
      scope: 'radian:read radian:write',
    });
    const workout = completedWorkoutFromPlan(defaultData());

    const response = await onMcpPost(createMcpContext(
      d1FromSqlite(database, {
        onPrepare(query) {
          queries.push(query);
        },
        async beforeRun(query) {
          throw new Error(`No debería escribir en D1: ${query}`);
        },
      }),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'record_workout',
          arguments: {
            workout,
          },
        },
      },
      bearer,
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32602,
      },
    });
    expect(queries.some((query) => query.includes('FROM user_data'))).toBe(false);
    expect(queries.some((query) => query.includes('UPDATE user_data'))).toBe(false);
    database.close();
  });

  it('procesa record_workout válido tras autenticar y persiste una sesión con ID generado', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    const baseUpdatedAt = seedUserData(database, data);
    const bearer = await seedBearerAccessToken(database, {
      bearer: 'record-valid',
      userId: 'user-1',
      clientId: 'client-1',
      scope: 'radian:read radian:write',
    });
    const workout = completedWorkoutFromPlan(data);

    const response = await onMcpPost(createMcpContext(
      d1FromSqlite(database),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'record_workout',
          arguments: {
            baseUpdatedAt,
            workout,
          },
        },
      },
      bearer,
    ));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      result?: {
        isError?: boolean;
        structuredContent?: {
          updatedAt?: string;
          summary?: {
            kind?: string;
            workoutDayId?: string;
            dateKey?: string;
            completedExercises?: number;
          };
        };
      };
      error?: { code?: number };
    };
    expect(body.error).toBeUndefined();
    expect(body.result?.isError).toBe(false);
    expect(body.result?.structuredContent?.updatedAt).toEqual(expect.any(String));
    expect(body.result?.structuredContent?.summary).toMatchObject({
      kind: 'record_workout',
      workoutDayId: workout.workoutDayId,
      dateKey: workout.dateKey,
      completedExercises: 2,
    });
    expect(body.result?.structuredContent?.updatedAt).not.toBe(baseUpdatedAt);

    const stored = await readStoredPayload(database);
    expect(stored.sessions).toHaveLength(1);
    expect(stored.sessions[0]?.id).toMatch(/^mcp-session-/);
    expect(stored.sessions[0]?.id).not.toBe(workout.id);
    expect(stored.sessions[0]).toMatchObject({
      workoutDayId: workout.workoutDayId,
      dateKey: workout.dateKey,
      status: 'completed',
    });
    database.close();
  });

  it('corta un write malformed antes de authenticateMcpRequest aunque haya bearer sintácticamente válido', async () => {
    const response = await onMcpPost(createMcpContext(
      failingD1('authenticateMcpRequest no debería consultar D1 para malformed writes'),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'record_workout',
          arguments: {
            workout: completedWorkoutFromPlan(defaultData()),
          },
        },
      },
      'syntactically-valid-bearer',
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: -32602,
      },
    });
  });

  it('devuelve un error MCP de ejecución seguro cuando writeMcpData falla en runtime', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    run(database, 'INSERT INTO users (id) VALUES (?)', 'runtime-user');
    run(database, 'INSERT INTO mcp_clients (client_id) VALUES (?)', 'runtime-client');
    run(database, 'INSERT INTO user_data (user_id, payload, updated_at) VALUES (?, ?, ?)', 'runtime-user', JSON.stringify(data), '2026-08-31T21:00:00.000Z');
    const bearer = await seedBearerAccessToken(database, {
      bearer: 'runtime-error',
      userId: 'runtime-user',
      clientId: 'runtime-client',
      scope: 'radian:read radian:write',
    });

    const response = await onMcpPost(createMcpContext(
      d1FromSqlite(database, {
        async beforeRun(query) {
          if (query.includes('UPDATE user_data')) throw new Error('sqlite exploded with internal secret token');
        },
      }),
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'update_profile',
          arguments: {
            baseUpdatedAt: '2026-08-31T21:00:00.000Z',
            profile: { gym: 'Nuevo gimnasio' },
          },
        },
      },
      bearer,
    ));

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: -32000,
        message: expect.stringContaining('No se pudo ejecutar'),
        data: {
          error: 'tool_execution_failed',
          tool: 'update_profile',
        },
      },
    });
    expect(JSON.stringify(body)).not.toContain('internal secret token');
    database.close();
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
    const malformed = structuredClone(defaultData()) as unknown as Record<string, unknown>;
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

    const preview = await previewChangeOrThrow(d1FromSqlite(database), 'user-1', 'client-1', {
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

    const foreignPreview = await previewChangeOrThrow(d1FromSqlite(database), 'user-1', 'client-1', {
      kind: 'delete_measurement',
      measurementId: 'progress-1',
      baseUpdatedAt,
    });

    await expect(applyChange(d1FromSqlite(database), 'user-1', 'client-2', foreignPreview.changeId, true)).resolves.toMatchObject({
      error: 'change_unavailable',
    });
    expect((await readStoredPayload(database)).progress).toHaveLength(1);
    expect(readPendingChangeRow(database, foreignPreview.changeId)?.usedAt).toBeNull();

    const expiredPreview = await previewChangeOrThrow(d1FromSqlite(database), 'user-1', 'client-1', {
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

    const stalePreview = await previewChangeOrThrow(d1FromSqlite(database), 'user-1', 'client-1', {
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

    const deleteWorkout = await previewChangeOrThrow(d1FromSqlite(database), 'user-1', 'client-1', {
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

    const deleteMeasurement = await previewChangeOrThrow(d1FromSqlite(database), 'user-1', 'client-1', {
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

    const deleteCheckin = await previewChangeOrThrow(d1FromSqlite(database), 'user-1', 'client-1', {
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

    const replacePreview = await previewChangeOrThrow(d1FromSqlite(database), 'user-1', 'client-1', {
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

    const deletePreview = await previewChangeOrThrow(d1FromSqlite(database), 'user-1', 'client-1', {
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

  it('devuelve el revisionId exacto de la revisión creada, sin depender del orden temporal global', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.progress = [{ id: 'progress-1', date: '2026-08-20', weightKg: 80 }];
    const baseUpdatedAt = seedUserData(database, data);
    run(
      database,
      'INSERT INTO user_data_revisions (id, user_id, payload, source, created_at, expires_at, restored_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      'zzzz-existing-revision',
      'user-1',
      JSON.stringify(defaultData()),
      'manual',
      '2099-01-01T00:00:00.000Z',
      '2099-01-31T00:00:00.000Z',
      null,
    );

    const preview = await previewChangeOrThrow(d1FromSqlite(database), 'user-1', 'client-1', {
      kind: 'delete_measurement',
      measurementId: 'progress-1',
      baseUpdatedAt,
    });
    const result = await applyChange(d1FromSqlite(database), 'user-1', 'client-1', preview.changeId, true);

    expect(result).toMatchObject({
      revisionId: expect.any(String),
      summary: {
        kind: 'delete_measurement',
        measurementId: 'progress-1',
      },
    });
    const revisionId = (result as { revisionId?: string }).revisionId;
    expect(revisionId).toBeTruthy();
    expect(revisionId).not.toBe('zzzz-existing-revision');
    expect(readRevisionRow(database, revisionId as string)).toMatchObject({
      id: revisionId,
      userId: 'user-1',
      source: 'automatic',
    });
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

  it('restaura una revisión tras delete_all_data insertando de nuevo la fila activa sin sobrescrituras implícitas', async () => {
    const database = openMigratedDatabase();
    const original = validateMcpAppData(defaultData());
    original.sessions = [completedWorkoutFromPlan(original)];
    original.progress = [{ id: 'progress-1', date: '2026-08-20', weightKg: 80 }];
    original.checkins = [checkin()];
    const normalizedOriginal = validateMcpAppData(original);
    const baseUpdatedAt = seedUserData(database, normalizedOriginal);

    const preview = await previewChangeOrThrow(d1FromSqlite(database), 'user-1', 'client-1', {
      kind: 'delete_all_data',
      baseUpdatedAt,
    });
    const deleted = await applyChange(d1FromSqlite(database), 'user-1', 'client-1', preview.changeId, true);
    expect(deleted).toMatchObject({
      updatedAt: expect.any(String),
      revisionId: expect.any(String),
      summary: {
        kind: 'delete_all_data',
      },
    });
    await expect(loadMcpUserData(d1FromSqlite(database), 'user-1')).resolves.toEqual({ data: null });

    const restoreResult = await restoreRevision(
      d1FromSqlite(database),
      'user-1',
      'client-1',
      (deleted as { revisionId: string }).revisionId,
      (deleted as { updatedAt: string }).updatedAt,
    );
    expect(restoreResult).toMatchObject({
      updatedAt: expect.any(String),
      summary: {
        kind: 'restore_revision',
        restoredFromRevisionId: (deleted as { revisionId: string }).revisionId,
      },
    });
    expect(await readStoredPayload(database)).toEqual(normalizedOriginal);
    expect(readRevisionRow(database, (deleted as { revisionId: string }).revisionId)).toMatchObject({
      id: (deleted as { revisionId: string }).revisionId,
      restoredAt: expect.any(String),
    });

    const recreatedBase = (restoreResult as { updatedAt: string }).updatedAt;
    run(
      database,
      'UPDATE user_data SET payload = ?, updated_at = ? WHERE user_id = ?',
      JSON.stringify({ ...original, profile: { ...original.profile, gym: 'Recreado' } }),
      '2026-09-01T09:30:00.000Z',
      'user-1',
    );
    await expect(
      restoreRevision(
        d1FromSqlite(database),
        'user-1',
        'client-1',
        (deleted as { revisionId: string }).revisionId,
        recreatedBase,
      ),
    ).resolves.toMatchObject({
      error: 'conflict',
      updatedAt: '2026-09-01T09:30:00.000Z',
      data: {
        profile: {
          gym: 'Recreado',
        },
      },
    });
    database.close();
  });

  it('no sobrescribe una fila recreada mientras restaura sobre una copia ausente', async () => {
    const database = openMigratedDatabase();
    const original = validateMcpAppData(defaultData());
    const baseUpdatedAt = seedUserData(database, original);
    const preview = await previewChangeOrThrow(d1FromSqlite(database), 'user-1', 'client-1', {
      kind: 'delete_all_data',
      baseUpdatedAt,
    });
    const deleted = await applyChange(d1FromSqlite(database), 'user-1', 'client-1', preview.changeId, true);
    const deletedRevisionId = (deleted as { revisionId: string }).revisionId;
    const recreated = structuredClone(original);
    recreated.profile.gym = 'Recreado durante restore';
    let recreatedBeforeInsert = false;

    const racingDatabase = d1FromSqlite(database, {
      beforeRun(query) {
        if (recreatedBeforeInsert || !query.includes('INSERT INTO user_data')) return;
        recreatedBeforeInsert = true;
        run(
          database,
          'INSERT INTO user_data (user_id, payload, updated_at) VALUES (?, ?, ?)',
          'user-1',
          JSON.stringify(recreated),
          '2026-09-01T09:45:00.000Z',
        );
      },
    });

    await expect(
      restoreRevision(
        racingDatabase,
        'user-1',
        'client-1',
        deletedRevisionId,
        (deleted as { updatedAt: string }).updatedAt,
      ),
    ).resolves.toMatchObject({
      error: 'conflict',
      updatedAt: '2026-09-01T09:45:00.000Z',
      data: {
        profile: {
          gym: 'Recreado durante restore',
        },
      },
    });
    expect(await readStoredPayload(database)).toEqual(recreated);
    expect(readRevisionRow(database, deletedRevisionId)?.restoredAt).toBeNull();
    database.close();
  });

  it('permite una sola aplicación concurrente de la misma propuesta y la otra queda indisponible', async () => {
    const database = openMigratedDatabase();
    const data = defaultData();
    data.progress = [{ id: 'progress-1', date: '2026-08-20', weightKg: 80 }];
    const baseUpdatedAt = seedUserData(database, data);

    const preview = await previewChangeOrThrow(d1FromSqlite(database), 'user-1', 'client-1', {
      kind: 'delete_measurement',
      measurementId: 'progress-1',
      baseUpdatedAt,
    });

    const [first, second] = await Promise.all([
      applyChange(d1FromSqlite(database), 'user-1', 'client-1', preview.changeId, true),
      applyChange(d1FromSqlite(database), 'user-1', 'client-1', preview.changeId, true),
    ]);

    const successes = [first, second].filter((result) => 'summary' in result && result.summary.kind === 'delete_measurement');
    const unavailable = [first, second].filter((result) => 'error' in result && result.error === 'change_unavailable');

    expect(successes).toHaveLength(1);
    expect(unavailable).toHaveLength(1);
    expect((await readStoredPayload(database)).progress).toEqual([]);
    expect(readRevisionRows(database)).toHaveLength(1);
    expect(readPendingChangeRow(database, preview.changeId)?.usedAt).toEqual(expect.any(String));
    database.close();
  });

  it('aplica 0006 y 0007 con FKs, índices y snapshots sobre user_data', () => {
    const database = openMigratedDatabase();
    run(database, 'INSERT INTO users (id) VALUES (?)', 'user-1');
    run(database, 'INSERT INTO mcp_clients (client_id) VALUES (?)', 'client-1');
    run(database, 'INSERT INTO user_data (user_id, payload, updated_at) VALUES (?, ?, ?)', 'user-1', '{"version":1}', '2026-08-31T21:00:00.000Z');

    const revisionColumns = readSqliteRows<{ name: string; type: string; notnull: number }>(database, 'PRAGMA table_info(user_data_revisions)');
    const pendingColumns = readSqliteRows<{ name: string; type: string; notnull: number }>(database, 'PRAGMA table_info(mcp_pending_changes)');
    const contextColumns = readSqliteRows<{ name: string; type: string; notnull: number }>(database, 'PRAGMA table_info(mcp_revision_context)');
    expect(revisionColumns.find((column) => column.name === 'payload')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(pendingColumns.find((column) => column.name === 'payload')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(pendingColumns.find((column) => column.name === 'summary')).toMatchObject({ type: 'TEXT', notnull: 1 });
    expect(contextColumns.find((column) => column.name === 'revision_id')).toMatchObject({ type: 'TEXT', notnull: 1 });

    const revisionFks = readSqliteRows<{ table: string; on_delete: string }>(database, 'PRAGMA foreign_key_list(user_data_revisions)');
    const pendingFks = readSqliteRows<{ table: string; on_delete: string }>(database, 'PRAGMA foreign_key_list(mcp_pending_changes)');
    const contextFks = readSqliteRows<{ table: string; on_delete: string }>(database, 'PRAGMA foreign_key_list(mcp_revision_context)');
    expect(revisionFks.map((fk) => fk.table)).toEqual(['users']);
    expect(revisionFks[0]?.on_delete).toBe('CASCADE');
    expect(pendingFks.map((fk) => fk.table).sort()).toEqual(['mcp_clients', 'users']);
    expect(pendingFks.every((fk) => fk.on_delete === 'CASCADE')).toBe(true);
    expect(contextFks.map((fk) => fk.table)).toEqual(['users']);
    expect(contextFks[0]?.on_delete).toBe('CASCADE');

    const revisionIndexes = readSqliteRows<{ name: string }>(database, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'user_data_revisions' ORDER BY name").map((row) => row.name);
    const pendingIndexes = readSqliteRows<{ name: string }>(database, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mcp_pending_changes' ORDER BY name").map((row) => row.name);
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

    const triggers = readSqliteRows<{ name: string }>(database, "SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").map((row) => row.name);
    expect(triggers).toEqual(['user_data_revision_after_delete', 'user_data_revision_after_update']);

    run(database, 'UPDATE user_data SET updated_at = ? WHERE user_id = ?', '2026-08-31T21:01:00.000Z', 'user-1');
    expect(readSqliteRow<{ count: number }>(database, 'SELECT count(*) AS count FROM user_data_revisions')?.count).toBe(0);

    run(database, 'INSERT INTO mcp_revision_context (user_id, revision_id, created_at) VALUES (?, ?, ?)', 'user-1', 'fixed-revision-id', '2026-08-31T21:01:30.000Z');
    run(database, 'UPDATE user_data SET payload = ?, updated_at = ? WHERE user_id = ?', '{"version":2}', '2026-08-31T21:02:00.000Z', 'user-1');
    run(database, 'DELETE FROM user_data WHERE user_id = ?', 'user-1');

    const revisions = readSqliteRows<{ id: string; payload: string; source: string; restoredAt: string | null }>(database, 'SELECT id, payload, source, restored_at AS restoredAt FROM user_data_revisions ORDER BY created_at, id');
    expect(revisions).toHaveLength(2);
    expect(revisions).toEqual(expect.arrayContaining([
      { id: 'fixed-revision-id', payload: '{"version":1}', source: 'automatic', restoredAt: null },
      { id: expect.any(String), payload: '{"version":2}', source: 'automatic', restoredAt: null },
    ]));
    expect(readSqliteRow<{ count: number }>(database, 'SELECT count(*) AS count FROM mcp_revision_context')?.count).toBe(0);
    database.close();
  });

  it('actualiza un esquema con el 0006 publicado aplicando después el hardening de 0007', () => {
    const database = openBaseDatabase();
    database.exec(loadMigration('0006_mcp_revisions.sql'));

    const basePendingColumns = readSqliteRows<{ name: string }>(database, 'PRAGMA table_info(mcp_pending_changes)').map((column) => column.name);
    expect(basePendingColumns).not.toContain('claim_id');
    expect(basePendingColumns).not.toContain('claimed_at');
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_revision_context'").get()).toBeUndefined();

    run(database, 'INSERT INTO users (id) VALUES (?)', 'user-1');
    run(database, 'INSERT INTO mcp_clients (client_id) VALUES (?)', 'client-1');
    run(database, 'INSERT INTO user_data (user_id, payload, updated_at) VALUES (?, ?, ?)', 'user-1', '{"version":1}', '2026-08-31T21:00:00.000Z');
    run(
      database,
      'INSERT INTO mcp_pending_changes (id, user_id, client_id, kind, payload, base_updated_at, summary, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      'pending-before-0007',
      'user-1',
      'client-1',
      'delete_all_data',
      '{"kind":"delete_all_data"}',
      '2026-08-31T21:00:00.000Z',
      '{"kind":"delete_all_data"}',
      '2026-09-01T09:55:00.000Z',
      '2026-09-01T10:05:00.000Z',
      null,
    );

    database.exec(loadMigration('0007_mcp_recovery_hardening.sql'));

    const upgradedPendingColumns = readSqliteRows<{ name: string }>(database, 'PRAGMA table_info(mcp_pending_changes)').map((column) => column.name);
    expect(upgradedPendingColumns).toEqual(expect.arrayContaining(['claim_id', 'claimed_at']));
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mcp_revision_context'").get()).toEqual({ name: 'mcp_revision_context' });
    expect(database.prepare('SELECT id, claim_id AS claimId, claimed_at AS claimedAt FROM mcp_pending_changes').get()).toEqual({
      id: 'pending-before-0007',
      claimId: null,
      claimedAt: null,
    });

    run(database, 'INSERT INTO mcp_revision_context (user_id, revision_id, created_at) VALUES (?, ?, ?)', 'user-1', 'upgrade-revision-id', '2026-09-01T10:00:00.000Z');
    run(database, 'UPDATE user_data SET payload = ?, updated_at = ? WHERE user_id = ?', '{"version":2}', '2026-09-01T10:00:01.000Z', 'user-1');

    expect(database.prepare('SELECT id, payload FROM user_data_revisions').get()).toEqual({
      id: 'upgrade-revision-id',
      payload: '{"version":1}',
    });
    expect(database.prepare('SELECT count(*) AS count FROM mcp_revision_context').get()).toEqual({ count: 0 });
    database.close();
  });
});

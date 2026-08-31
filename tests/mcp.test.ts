import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { defaultData } from '../src/data/initialPlan';
import { handleMcpTool, MCP_TOOL_DEFINITIONS } from '../functions/lib/mcp';
import { hasMcpScope, isAllowedRedirectUri, normalizeScope } from '../functions/lib/mcpAuth';
import type { McpPendingChangeRow, McpRevisionRow } from '../functions/types';

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

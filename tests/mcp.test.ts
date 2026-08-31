import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { defaultData } from '../src/data/initialPlan';
import { handleMcpTool, MCP_TOOL_DEFINITIONS } from '../functions/lib/mcp';
import { isAllowedRedirectUri, normalizeScope } from '../functions/lib/mcpAuth';
import type { McpPendingChangeRow, McpRevisionRow } from '../functions/types';

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

  it('expone contratos de filas para revisiones y propuestas pendientes', () => {
    expectTypeOf<McpRevisionRow>().toMatchTypeOf<{
      id: string;
      userId: string;
      payload: unknown;
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
      payload: unknown;
      baseUpdatedAt: string;
      summary: unknown;
      createdAt: string;
      expiresAt: string;
      usedAt: string | null;
    }>();
  });

  it('declara la migración de revisiones y propuestas pendientes', () => {
    const migrationPath = resolve(process.cwd(), 'migrations/0006_mcp_revisions.sql');
    const migration = readFileSync(migrationPath, 'utf8');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS user_data_revisions');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS mcp_pending_changes');
    expect(migration).toContain('CREATE TRIGGER IF NOT EXISTS user_data_revision_after_update');
    expect(migration).toContain('CREATE TRIGGER IF NOT EXISTS user_data_revision_after_delete');
  });
});

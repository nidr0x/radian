import { describe, expect, it } from 'vitest';
import { defaultData } from '../src/data/initialPlan';
import { handleMcpTool, MCP_TOOL_DEFINITIONS } from '../functions/lib/mcp';
import { isAllowedRedirectUri, normalizeScope } from '../functions/lib/mcpAuth';

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
});

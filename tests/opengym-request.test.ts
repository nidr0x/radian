import { describe, expect, it } from 'vitest';
import { readJson } from '../functions/lib/auth';
import { parseForm } from '../functions/lib/mcpAuth';

describe('límites de cuerpos de solicitud', () => {
  it('no materializa JSON de autenticación que supera el límite pequeño', async () => {
    const request = new Request('https://radian.example/api/auth/login/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential: 'x'.repeat(20_000) }),
    });

    await expect(readJson(request)).resolves.toEqual({});
  });

  it('ignora formularios OAuth que superan el límite pequeño', async () => {
    const request = new Request('https://radian.example/api/mcp/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&${'x'.repeat(20_000)}`,
    });

    expect((await parseForm(request)).toString()).toBe('');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { enforceAuthRateLimit, getWebAuthnConfig, pruneChallenges, requireDatabase } from '../functions/lib/auth';
import type { D1DatabaseLike, D1PreparedStatementLike, SyncContext } from '../functions/types';

const request = (headers: Record<string, string> = {}): Request => new Request('https://radian.nidr0x.win/api/auth/login/options', { headers });

const context = (overrides: Partial<SyncContext['env']> = {}): SyncContext => ({
  request: request({ 'CF-Connecting-IP': '203.0.113.10' }),
  env: { ...overrides },
});

describe('protecciones de Pages Functions', () => {
  it('devuelve 503 si la cuenta no tiene D1 vinculada', async () => {
    const response = requireDatabase(context());
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(503);
  });

  it('aplica el límite de autenticación por ruta y dirección', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    const response = await enforceAuthRateLimit(context({ AUTH_RATE_LIMITER: { limit } }), 'login-options');
    expect(response?.status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: 'auth:login-options:203.0.113.10' });
  });

  it('permite continuar si el limitador todavía no está vinculado', async () => {
    await expect(enforceAuthRateLimit(context(), 'register-options')).resolves.toBeUndefined();
  });

  it('elimina challenges caducados o usados antiguos', async () => {
    const run = vi.fn().mockResolvedValue({ success: true, meta: { changes: 2 } });
    const statement = { bind: vi.fn().mockReturnThis(), run } as unknown as D1PreparedStatementLike;
    const database = { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1DatabaseLike;
    await pruneChallenges(database);
    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM auth_challenges'));
    expect(statement.bind).toHaveBeenCalledWith(expect.any(String), expect.any(String));
    expect(run).toHaveBeenCalledOnce();
  });

  it('deriva WebAuthn del dominio HTTPS si no hay variables explícitas', () => {
    expect(getWebAuthnConfig(context())).toEqual({
      rpId: 'radian.nidr0x.win',
      origin: 'https://radian.nidr0x.win',
      rpName: 'Radian',
    });
  });
});

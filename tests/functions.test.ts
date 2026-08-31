import { describe, expect, it, vi } from 'vitest';
import { onRequest as onRequestMiddleware } from '../functions/_middleware';
import { enforceAuthRateLimit, getWebAuthnConfig, issueSessionCookie, pruneChallenges, requireAuthConfiguration, requireDatabase, requireRecentReauthentication } from '../functions/lib/auth';
import type { AuthenticatedContext } from '../functions/lib/auth';
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

  it('usa el límite de D1 si no hay limitador de borde', async () => {
    const statement = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      first: vi.fn().mockResolvedValue({ attempts: 1, windowStartedAt: new Date().toISOString() }),
    } as unknown as D1PreparedStatementLike;
    const database = { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1DatabaseLike;
    await expect(enforceAuthRateLimit(context({ DB: database }), 'register-options')).resolves.toBeUndefined();
    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining('auth_rate_limits'));
  });

  it('falla de forma controlada si no hay protección de rate limit', async () => {
    const response = await enforceAuthRateLimit(context(), 'register-options');
    expect(response?.status).toBe(503);
  });

  it('rechaza el fallback de D1 al superar el límite de intentos', async () => {
    const statement = {
      bind: vi.fn().mockReturnThis(),
      run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
      first: vi.fn().mockResolvedValue({ attempts: 11, windowStartedAt: new Date().toISOString() }),
    } as unknown as D1PreparedStatementLike;
    const database = { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1DatabaseLike;
    const response = await enforceAuthRateLimit(context({ DB: database }), 'login-verify');
    expect(response?.status).toBe(429);
  });

  it('elimina challenges caducados o usados antiguos', async () => {
    const run = vi.fn().mockResolvedValue({ success: true, meta: { changes: 2 } });
    const statement = { bind: vi.fn().mockReturnThis(), run } as unknown as D1PreparedStatementLike;
    const database = { prepare: vi.fn().mockReturnValue(statement), batch: vi.fn().mockResolvedValue([]) } as unknown as D1DatabaseLike;
    await pruneChallenges(database);
    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM auth_challenges'));
    expect(database.batch).toHaveBeenCalledOnce();
    expect(statement.bind).toHaveBeenCalledWith(expect.any(String), expect.any(String));
    expect(run).not.toHaveBeenCalled();
  });

  it('deriva WebAuthn del dominio HTTPS si no hay variables explícitas', () => {
    expect(getWebAuthnConfig(context())).toEqual({
      rpId: 'radian.nidr0x.win',
      origin: 'https://radian.nidr0x.win',
      rpName: 'Radian',
    });
  });

  it('rechaza autenticación remota sin secreto de sesión', () => {
    const response = requireAuthConfiguration(context());
    expect(response?.status).toBe(503);
  });

  it('acepta la configuración remota cuando origin, RP ID y secreto coinciden', () => {
    expect(requireAuthConfiguration(context({ SESSION_SECRET: 'test-session-secret' }))).toBeUndefined();
  });

  it('emite la cookie de sesión con prefijo Host y Secure en HTTPS', async () => {
    const statement = { bind: vi.fn().mockReturnThis(), run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }) } as unknown as D1PreparedStatementLike;
    const database = { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1DatabaseLike;
    const cookie = await issueSessionCookie(context({ DB: database, SESSION_SECRET: 'test-session-secret' }), 'user-test', 1, 'credential-test');
    expect(cookie).toContain('__Host-radian_session=');
    expect(cookie).toContain('Path=/;');
    expect(cookie).toContain('HttpOnly;');
    expect(cookie).toContain('Secure;');
    expect(database.prepare).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO auth_sessions'));
  });

  it('exige una reautenticación reciente antes de gestionar passkeys', () => {
    const authenticated = { sessionReauthenticatedAt: undefined } as unknown as AuthenticatedContext;
    expect(requireRecentReauthentication(authenticated)?.status).toBe(403);
    const recent = { sessionReauthenticatedAt: new Date().toISOString() } as unknown as AuthenticatedContext;
    expect(requireRecentReauthentication(recent)).toBeUndefined();
  });

  it('aplica cabeceras de seguridad también a las respuestas de Functions', async () => {
    const response = await onRequestMiddleware({ request: request(), env: {}, next: async () => new Response('ok') });
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    expect(response.headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
  });

  it('convierte excepciones de Functions en un error JSON controlado', async () => {
    const response = await onRequestMiddleware({ request: request(), env: {}, next: async () => { throw new Error('internal'); } });
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: 'internal_error' });
  });
});

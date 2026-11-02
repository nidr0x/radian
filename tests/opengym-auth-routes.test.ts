import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncContext } from '../functions/types';

const handlers = vi.hoisted(() => ({
  loginOptions: vi.fn(),
  loginVerify: vi.fn(),
  registerOptions: vi.fn(),
}));

vi.mock('../functions/api/auth/login/options', () => ({ onRequestPost: handlers.loginOptions }));
vi.mock('../functions/api/auth/login/verify', () => ({ onRequestPost: handlers.loginVerify }));
vi.mock('../functions/api/auth/register/options', () => ({ onRequestPost: handlers.registerOptions }));

import { onRequestPost as loginOptions } from '../functions/api/login/options';
import { onRequestPost as loginVerify } from '../functions/api/login/verify';
import { onRequestPost as registerOptions } from '../functions/api/register/options';

const context = (body: unknown): SyncContext => ({
  request: new Request('https://radian.example/api/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'radian_challenge=bound' },
    body: JSON.stringify(body),
  }),
  env: {},
});

beforeEach(() => vi.clearAllMocks());

describe('adaptadores de autenticación openGym', () => {
  it('devuelve `cid` y el usuario con `name` al iniciar sesión con passkey', async () => {
    handlers.loginOptions.mockResolvedValue(new Response(JSON.stringify({ challengeId: 'challenge-1', options: { challenge: 'nonce' } }), {
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'challenge=bound; HttpOnly' },
    }));
    handlers.loginVerify.mockImplementation(async (received: SyncContext) => {
      expect(await received.request.json()).toMatchObject({ cid: 'challenge-1', challengeId: 'challenge-1' });
      return new Response(JSON.stringify({ user: { id: 'account-a', displayName: 'Ana', createdAt: '2026-10-26' } }), {
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'session=active; HttpOnly' },
      });
    });

    const options = await loginOptions(context({}));
    const verify = await loginVerify(context({ cid: 'challenge-1', credential: { id: 'credential' } }));

    expect(await options.json()).toMatchObject({ cid: 'challenge-1', options: { challenge: 'nonce' } });
    expect(options.headers.get('Set-Cookie')).toContain('challenge=bound');
    expect(await verify.json()).toMatchObject({ user: { id: 'account-a', name: 'Ana' } });
    expect(verify.headers.get('Set-Cookie')).toContain('session=active');
  });

  it('mapea el nombre de registro y expone la challenge bajo el contrato de openGym', async () => {
    handlers.registerOptions.mockImplementation(async (received: SyncContext) => {
      expect(await received.request.json()).toMatchObject({ name: 'Ana', displayName: 'Ana', code: 'INVITE' });
      return new Response(JSON.stringify({ challengeId: 'register-1', options: { challenge: 'nonce' } }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const response = await registerOptions(context({ name: 'Ana', code: 'INVITE' }));

    expect(await response.json()).toMatchObject({ cid: 'register-1', options: { challenge: 'nonce' } });
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { enforceAuthRateLimit } from '../functions/lib/auth';
import type { SyncContext } from '../functions/types';
import { openTestDatabase } from './support/opengym-d1';

const databases: Array<ReturnType<typeof openTestDatabase>> = [];
const makeDatabase = () => {
  const value = openTestDatabase();
  databases.push(value);
  return value;
};

afterEach(() => { while (databases.length) databases.pop()?.database.close(); });

const context = (DB: ReturnType<typeof openTestDatabase>['d1']): SyncContext => ({
  request: new Request('https://gym.example.test/api/coach/status', { headers: { 'CF-Connecting-IP': '192.0.2.20' } }),
  env: { DB },
});

describe('límites de tasa D1', () => {
  it('permite 30 sondeos Coach por minuto y bloquea el siguiente, sin ampliar el límite de acceso', async () => {
    const { d1 } = makeDatabase();
    const requestContext = context(d1);

    for (let attempt = 0; attempt < 30; attempt += 1) {
      expect(await enforceAuthRateLimit(requestContext, 'coach-status', 'account-a')).toBeUndefined();
    }
    expect((await enforceAuthRateLimit(requestContext, 'coach-status', 'account-a'))?.status).toBe(429);

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(await enforceAuthRateLimit(requestContext, 'password-login-ip')).toBeUndefined();
    }
    expect((await enforceAuthRateLimit(requestContext, 'password-login-ip'))?.status).toBe(429);
  });
});

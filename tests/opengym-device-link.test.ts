import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueSessionCookie } from '../functions/lib/auth';
import { hashPassword } from '../functions/lib/radian-api/password-core';
import type { SyncContext } from '../functions/types';
import { onRequestPost as createDeviceLink } from '../functions/api/account/device-link';
import { onRequestPost as deviceLinkOptions } from '../functions/api/device-link/options';
import { onRequestPost as deviceLinkVerify } from '../functions/api/device-link/verify';
import { openTestDatabase } from './support/opengym-d1';

const webauthn = vi.hoisted(() => ({ verifyRegistrationResponse: vi.fn() }));
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return { ...actual, verifyRegistrationResponse: webauthn.verifyRegistrationResponse };
});

const databases: Array<ReturnType<typeof openTestDatabase>> = [];
const makeDatabase = () => {
  const value = openTestDatabase();
  databases.push(value);
  return value;
};

const env = (database: ReturnType<typeof openTestDatabase>['d1']): SyncContext['env'] => ({
  DB: database,
  PASSWORD_LOGIN: '1',
  SESSION_SECRET: 'local-device-link-test-secret',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_RP_NAME: 'Radian',
  WEBAUTHN_ORIGIN: 'http://localhost',
});

const context = (
  database: ReturnType<typeof openTestDatabase>['d1'],
  path: string,
  body: unknown,
  cookie?: string,
): SyncContext => {
  const headers = new Headers({ 'Content-Type': 'application/json', Origin: 'http://localhost' });
  if (cookie) headers.set('Cookie', cookie);
  return {
    request: new Request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
    env: env(database),
  };
};

afterEach(() => { while (databases.length) databases.pop()?.database.close(); });
beforeEach(() => { webauthn.verifyRegistrationResponse.mockReset(); });

describe('enlace de dispositivo openGym', () => {
  it('usa un código de un solo uso para añadir una passkey y abrir sesión en la misma cuenta', async () => {
    const { database, d1 } = makeDatabase();
    const passwordHash = await hashPassword('correct horse battery staple');
    database.prepare('INSERT INTO gym_account_security (account_id, password_hash, password_set_at) VALUES (?, ?, ?)')
      .run('account-a', passwordHash, '2026-10-26T00:00:00.000Z');
    const session = await issueSessionCookie({ request: new Request('http://localhost/api/login/password'), env: env(d1) }, 'account-a', 0);
    const sessionCookie = session.split(';', 1)[0];
    const created = await createDeviceLink(context(d1, '/api/account/device-link', { current: 'correct horse battery staple' }, sessionCookie));
    const issued = await created.json() as { code: string; expires: number };

    expect(created.status).toBe(200);
    expect(issued.code).toMatch(/^[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}$/);
    expect(issued.expires).toBeGreaterThan(Date.now());
    const storedCode = database.prepare('SELECT code_hash AS codeHash FROM gym_device_link_codes WHERE account_id = ?')
      .get('account-a') as { codeHash: string };
    expect(storedCode.codeHash).not.toBe(issued.code);

    const optionsResponse = await deviceLinkOptions(context(d1, '/api/device-link/options', { code: issued.code }));
    const ceremony = await optionsResponse.json() as { cid: string; id: string; name: string };
    const challengeCookie = optionsResponse.headers.get('Set-Cookie')?.split(';', 1)[0];
    expect(optionsResponse.status).toBe(200);
    expect(ceremony).toMatchObject({ id: 'account-a', name: 'A' });
    expect(challengeCookie).toContain(`radian_challenge_${ceremony.cid}=`);

    webauthn.verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: { credential: { id: 'device-credential', publicKey: new Uint8Array([1, 2, 3]), counter: 0 } },
    });
    const verified = await deviceLinkVerify(context(d1, '/api/device-link/verify', {
      code: issued.code,
      cid: ceremony.cid,
      credential: { id: 'device-credential', response: { transports: ['internal'] } },
      name: 'Safari · Mac',
    }, challengeCookie));
    const response = await verified.json() as { user: { id: string; name: string } };
    const passkey = database.prepare('SELECT label FROM passkeys WHERE credential_id = ?').get('device-credential') as { label: string };
    const consumed = database.prepare('SELECT used_at AS usedAt FROM gym_device_link_codes WHERE account_id = ?')
      .get('account-a') as { usedAt: string | null };

    expect(verified.status).toBe(201);
    expect(response.user).toMatchObject({ id: 'account-a', name: 'A' });
    expect(verified.headers.get('Set-Cookie')).toContain('radian_session=');
    expect(passkey.label).toBe('Safari · Mac');
    expect(consumed.usedAt).not.toBeNull();
    expect((await deviceLinkOptions(context(d1, '/api/device-link/options', { code: issued.code }))).status).toBe(400);
  });
});

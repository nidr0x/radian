import { afterEach, describe, expect, it } from 'vitest';
import { getAuthenticatedContext, issueSessionCookie } from '../functions/lib/auth';
import type { SyncContext, D1DatabaseLike } from '../functions/types';
import { onRequestPost as registerPassword } from '../functions/api/register/password';
import { onRequestPost as loginPassword } from '../functions/api/login/password';
import { onRequestGet as getPasswordState, onRequestPost as setPassword } from '../functions/api/account/password';
import { onRequestPost as setEmail } from '../functions/api/account/email';
import { onRequestPost as issuePasswordReset } from '../functions/api/admin/user/password-reset';
import { onRequestPost as redeemPasswordReset } from '../functions/api/login/password-reset';
import { openTestDatabase } from './support/opengym-d1';

const databases: Array<ReturnType<typeof openTestDatabase>> = [];
const makeDatabase = () => {
  const value = openTestDatabase();
  databases.push(value);
  return value;
};

const requestContext = (database: D1DatabaseLike, path: string, body: unknown, cookie?: string, env: Partial<SyncContext['env']> = {}): SyncContext => {
  const headers = new Headers({ 'Content-Type': 'application/json', Origin: 'http://localhost' });
  if (cookie) headers.set('Cookie', cookie);
  return {
    request: new Request(`http://localhost${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
    env: { DB: database, PASSWORD_LOGIN: '1', ...env },
  };
};

const authenticatedCookie = async (database: D1DatabaseLike, accountId = 'account-a'): Promise<string> => {
  const context: SyncContext = { request: new Request('http://localhost/api/login/password'), env: { DB: database } };
  return (await issueSessionCookie(context, accountId, 0)).split(';', 1)[0];
};

afterEach(() => {
  while (databases.length) databases.pop()?.database.close();
});

describe('rutas de contraseña y email openGym', () => {
  it('registra una cuenta con contraseña hasheada y permite entrar por nombre o email', async () => {
    const { database, d1 } = makeDatabase();
    const registered = await registerPassword(requestContext(d1, '/api/register/password', {
      name: 'Ada', password: 'correct horse battery staple', email: 'ADA@example.com',
    }));
    const registration = await registered.json() as { user: { id: string; name: string } };
    const stored = database.prepare('SELECT password_hash AS passwordHash, email FROM gym_account_security WHERE account_id = ?')
      .get(registration.user.id) as { passwordHash: string; email: string };
    const byName = await loginPassword(requestContext(d1, '/api/login/password', { identifier: '  ada ', password: 'correct horse battery staple' }));
    const byEmail = await loginPassword(requestContext(d1, '/api/login/password', { identifier: 'ADA@example.com', password: 'correct horse battery staple' }));

    expect(registered.status).toBe(200);
    expect(registration.user.name).toBe('Ada');
    expect(stored.passwordHash).toMatch(/^scrypt\$/);
    expect(stored.passwordHash).not.toContain('correct horse battery staple');
    expect(stored.email).toBe('ada@example.com');
    expect(byName.status).toBe(200);
    expect(byEmail.status).toBe(200);
    expect(byName.headers.get('Set-Cookie')).toContain('radian_session=');
  });

  it('responde igual ante nombre inexistente y contraseña incorrecta', async () => {
    const { d1 } = makeDatabase();
    await registerPassword(requestContext(d1, '/api/register/password', { name: 'Ada', password: 'correct horse battery staple' }));
    const wrongPassword = await loginPassword(requestContext(d1, '/api/login/password', { name: 'Ada', password: 'incorrect horse battery staple' }));
    const unknownName = await loginPassword(requestContext(d1, '/api/login/password', { name: 'Unknown', password: 'incorrect horse battery staple' }));

    expect(wrongPassword.status).toBe(401);
    expect(unknownName.status).toBe(401);
    expect(await wrongPassword.json()).toMatchObject({ code: 'bad-credentials' });
    expect(await unknownName.json()).toMatchObject({ code: 'bad-credentials' });
  });

  it('requires a password or passkey proof before changing account credentials', async () => {
    const { d1 } = makeDatabase();
    const cookie = await authenticatedCookie(d1);
    const state = await getPasswordState(requestContext(d1, '/api/account/password', {}, cookie));
    const password = await setPassword(requestContext(d1, '/api/account/password', { next: 'correct horse battery staple' }, cookie));
    const email = await setEmail(requestContext(d1, '/api/account/email', { email: 'ada@example.com' }, cookie));

    expect(await state.json()).toMatchObject({ set: false, passkeys: 0, name: 'A' });
    expect(password.status).toBe(403);
    expect(await password.json()).toMatchObject({ code: 'passkey-required' });
    expect(email.status).toBe(403);
    expect(await email.json()).toMatchObject({ code: 'passkey-required' });
  });

  it('emite un código de reset de un solo uso, invalida sesiones y deja iniciar con la contraseña nueva', async () => {
    const { database, d1 } = makeDatabase();
    const registration = await registerPassword(requestContext(d1, '/api/register/password', {
      name: 'Ada', password: 'original horse battery staple', email: 'ada@example.com',
    }));
    const user = await registration.json() as { user: { id: string } };
    const oldCookie = registration.headers.get('Set-Cookie')?.split(';', 1)[0];
    database.prepare('UPDATE users SET is_admin = 1, is_owner = 1 WHERE id = ?').run('account-a');
    const adminCookie = await authenticatedCookie(d1);
    const issued = await issuePasswordReset(requestContext(d1, '/api/admin/user/password-reset', { id: user.user.id }, adminCookie));
    const result = await issued.json() as { code: string; expires: number };
    const stored = database.prepare('SELECT code_hash AS codeHash, used_at AS usedAt FROM gym_password_reset_codes WHERE account_id = ?')
      .get(user.user.id) as { codeHash: string; usedAt: string | null };

    expect(issued.status).toBe(200);
    expect(result.code).toMatch(/^[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}-[0-9A-HJKMNPQRSTVWXYZ]{4}$/);
    expect(stored.codeHash).not.toBe(result.code);
    expect(stored.usedAt).toBeNull();
    expect(oldCookie).toBeTruthy();
    await expect(getAuthenticatedContext(requestContext(d1, '/api/me', {}, oldCookie)).then((value) => value instanceof Response)).resolves.toBe(true);

    const wrong = await redeemPasswordReset(requestContext(d1, '/api/login/password-reset', { name: 'Ada', code: '0000-0000-0000', next: 'new correct horse battery staple' }));
    const redeemed = await redeemPasswordReset(requestContext(d1, '/api/login/password-reset', { name: 'Ada', code: result.code.toLowerCase(), next: 'new correct horse battery staple' }));
    const reused = await redeemPasswordReset(requestContext(d1, '/api/login/password-reset', { name: 'Ada', code: result.code, next: 'another correct horse battery staple' }));
    const oldPassword = await loginPassword(requestContext(d1, '/api/login/password', { name: 'Ada', password: 'original horse battery staple' }));
    const newPassword = await loginPassword(requestContext(d1, '/api/login/password', { name: 'Ada', password: 'new correct horse battery staple' }));

    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: 'reset-invalid' });
    expect(redeemed.status).toBe(200);
    expect(redeemed.headers.get('Set-Cookie')).toContain('radian_session=');
    expect(reused.status).toBe(400);
    expect(oldPassword.status).toBe(401);
    expect(newPassword.status).toBe(200);
  });
});

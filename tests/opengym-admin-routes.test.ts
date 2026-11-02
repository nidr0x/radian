import { afterEach, describe, expect, it } from 'vitest';
import { getAccountRoles, issueSessionCookie } from '../functions/lib/auth';
import type { SyncContext } from '../functions/types';
import { onRequestGet as adminUsers } from '../functions/api/admin/users';
import { onRequestGet as adminUser } from '../functions/api/admin/user';
import { onRequestPost as createInvite } from '../functions/api/admin/invites/new';
import { onRequestPost as setRole } from '../functions/api/admin/user/role';
import { onRequestPost as transferOwner } from '../functions/api/admin/owner';
import { onRequestPost as deleteUser } from '../functions/api/admin/user/delete';
import { onRequestGet as getAudit } from '../functions/api/admin/audit';
import { onRequestPost as clearAudit } from '../functions/api/admin/audit/clear';
import { onRequestPost as registerPassword } from '../functions/api/register/password';
import { openTestDatabase } from './support/opengym-d1';

const databases: Array<ReturnType<typeof openTestDatabase>> = [];
const makeDatabase = () => {
  const value = openTestDatabase();
  databases.push(value);
  return value;
};

const context = (
  database: ReturnType<typeof openTestDatabase>['d1'],
  path: string,
  body: unknown = {},
  cookie?: string,
  method: 'GET' | 'POST' = 'POST',
  env: Partial<SyncContext['env']> = {},
): SyncContext => {
  const headers = new Headers({ 'Content-Type': 'application/json', Origin: 'http://localhost' });
  if (cookie) headers.set('Cookie', cookie);
  return {
    request: new Request(`http://localhost${path}`, { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) }),
    env: { DB: database, PASSWORD_LOGIN: '1', ...env },
  };
};

const cookieFor = async (database: ReturnType<typeof openTestDatabase>['d1'], id: string): Promise<string> =>
  (await issueSessionCookie({ request: new Request('http://localhost/api/login/password'), env: { DB: database } }, id, 0)).split(';', 1)[0];

afterEach(() => { while (databases.length) databases.pop()?.database.close(); });

describe('rutas de administración openGym', () => {
  it('administra invitaciones y roles, protege al propietario y conserva el historial de auditoría', async () => {
    const { database, d1 } = makeDatabase();
    database.prepare('UPDATE users SET is_admin = 1, is_owner = 1 WHERE id = ?').run('account-a');
    database.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?), (?, ?, ?)')
      .run('account-c', 'Cora', '2026-10-26T00:00:00.000Z', 'account-d', 'Dina', '2026-10-26T00:00:01.000Z');
    const ownerCookie = await cookieFor(d1, 'account-a');

    const listed = await adminUsers(context(d1, '/api/admin/users', {}, ownerCookie, 'GET'));
    const listedBody = await listed.json() as { users: Array<{ id: string; owner: boolean; admin: boolean; workouts: number; live: unknown }> };
    expect(listed.status).toBe(200);
    expect(listedBody.users.find((user) => user.id === 'account-a')).toMatchObject({ owner: true, admin: true, workouts: 0, live: null });
    const detail = await adminUser(context(d1, '/api/admin/user?id=account-c', {}, ownerCookie, 'GET'));
    expect(await detail.json()).toMatchObject({ user: { id: 'account-c', name: 'Cora', disabled: false }, routines: [], bodyweight: [], measurements: [], workouts: [] });

    const minted = await createInvite(context(d1, '/api/admin/invites/new', { note: 'for Ada' }, ownerCookie));
    const inviteBody = await minted.json() as { invite: { code: string } };
    const registered = await registerPassword(context(d1, '/api/register/password', {
      name: 'Ada', password: 'correct horse battery staple', code: inviteBody.invite.code,
    }, undefined, 'POST', { INVITE_ONLY: '1' }));
    const newUser = await registered.json() as { user: { id: string } };
    const inviteRow = database.prepare('SELECT used_by_account_id AS usedBy FROM gym_invites WHERE code = ?')
      .get(inviteBody.invite.code) as { usedBy: string | null };
    expect(minted.status).toBe(200);
    expect(registered.status).toBe(200);
    expect(inviteRow.usedBy).toBe(newUser.user.id);
    expect((await registerPassword(context(d1, '/api/register/password', {
      name: 'Eve', password: 'correct horse battery staple', code: inviteBody.invite.code,
    }, undefined, 'POST', { INVITE_ONLY: '1' }))).status).toBe(403);

    expect((await setRole(context(d1, '/api/admin/user/role', { id: newUser.user.id, admin: true }, ownerCookie))).status).toBe(200);
    expect((await transferOwner(context(d1, '/api/admin/owner', { id: newUser.user.id }, ownerCookie))).status).toBe(200);
    expect(await getAccountRoles(d1, newUser.user.id, { DB: d1 })).toEqual({ admin: true, owner: true });
    expect(await getAccountRoles(d1, 'account-a', { DB: d1 })).toEqual({ admin: true, owner: false });
    const newOwnerCookie = await cookieFor(d1, newUser.user.id);
    expect((await clearAudit(context(d1, '/api/admin/audit/clear', {}, newOwnerCookie))).status).toBe(200);
    const audit = await getAudit(context(d1, '/api/admin/audit', {}, newOwnerCookie, 'GET'));
    expect(await audit.json()).toMatchObject({ events: [{ ev: 'admin.audit.clear', ok: true }], nextBefore: null });
    expect((await deleteUser(context(d1, '/api/admin/user/delete', { id: newUser.user.id }, ownerCookie))).status).toBe(400);
  });

  it('elimina una cuenta normal con su estado y registra una acción para la auditoría', async () => {
    const { database, d1 } = makeDatabase();
    database.prepare('UPDATE users SET is_admin = 1, is_owner = 1 WHERE id = ?').run('account-a');
    database.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').run('account-b', 'Bea', '2026-10-26T00:00:00.000Z');
    const cookie = await cookieFor(d1, 'account-a');
    const response = await deleteUser(context(d1, '/api/admin/user/delete', { id: 'account-b' }, cookie));
    const audit = await getAudit(context(d1, '/api/admin/audit?cat=admin', {}, cookie, 'GET'));

    expect(response.status).toBe(200);
    expect(database.prepare('SELECT id FROM users WHERE id = ?').get('account-b')).toBeUndefined();
    expect(await audit.json()).toMatchObject({ events: [{ ev: 'admin.user.delete', tname: 'Bea' }] });
  });
});

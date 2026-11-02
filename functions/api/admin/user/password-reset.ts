import { enforceAuthRateLimit, getAccountRoles, json } from '../../../lib/auth';
import { auditStatement, requireAdmin } from '../../../lib/radian-api/admin';
import { createOneTimeCode, hashCode } from '../../../lib/radian-api/one-time-code';
import { readSmallJson } from '../../../lib/radian-api/request';
import type { SyncContext } from '../../../types';

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  if (context.env.PASSWORD_LOGIN !== '1') return error(404, 'password-disabled', 'Password sign-in is disabled.');
  const admin = await requireAdmin(context);
  if (admin instanceof Response) return admin;
  const limited = await enforceAuthRateLimit(context, 'admin-password-reset', admin.user.id);
  if (limited) return limited;
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const id = typeof read.value.id === 'string' ? read.value.id.trim() : '';
  if (!id || id.length > 128) return error(400, 'missing', 'A user id is required.');

  const database = admin.env.DB!;
  const target = await database.prepare('SELECT id, display_name AS name FROM users WHERE id = ?').bind(id).first<{ id: string; name: string }>();
  if (!target) return error(404, 'not-found', 'No user with that id.');
  if ((await getAccountRoles(database, id, admin.env)).admin) return error(400, 'target-admin', 'An admin sets their own password in Settings.');

  const { value, display } = createOneTimeCode();
  const codeHash = await hashCode(value);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const statements = [
    database.prepare('INSERT OR IGNORE INTO gym_account_security (account_id) VALUES (?)').bind(id),
    database.prepare('UPDATE gym_account_security SET password_hash = NULL, password_set_at = NULL WHERE account_id = ?').bind(id),
    database.prepare(
      `INSERT INTO gym_password_reset_codes (account_id, code_hash, expires_at, created_at, used_at)
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT(account_id) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, created_at = excluded.created_at, used_at = NULL`,
    ).bind(id, codeHash, expires, now),
    database.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').bind(id),
    database.prepare('DELETE FROM gym_device_link_codes WHERE account_id = ?').bind(id),
  ];
  const audit = auditStatement(database, context, admin.user, 'admin.password.reset', true, { id, name: target.name });
  if (audit) statements.push(audit);
  try { await database.batch(statements); }
  catch { return error(503, 'busy', 'The server is busy. Try again in a moment.'); }
  return json({ ok: true, name: target.name, code: display, expires: Date.parse(expires) });
};

import { getAccountRoles, json } from '../../lib/auth';
import { auditStatement, requireAdmin } from '../../lib/radian-api/admin';
import { readSmallJson } from '../../lib/radian-api/request';
import type { SyncContext } from '../../types';

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const admin = await requireAdmin(context, true);
  if (admin instanceof Response) return admin;
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const id = typeof read.value.id === 'string' ? read.value.id.trim() : '';
  if (!id || id.length > 128) return error(400, 'missing', 'A user id is required.');
  if (id === admin.user.id) return error(400, 'same-owner', 'The owner role is already yours.');

  const database = admin.env.DB!;
  const target = await database.prepare('SELECT display_name AS name, disabled FROM users WHERE id = ?').bind(id)
    .first<{ name: string; disabled: number }>();
  if (!target) return error(404, 'not-found', 'No user with that id.');
  if (target.disabled === 1 || !(await getAccountRoles(database, id, admin.env)).admin) {
    return error(400, 'target-not-admin', 'The new owner must be an enabled admin.');
  }

  const configured = (admin.env.ADMIN_UIDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const configuredClause = configured.length ? `id IN (${configured.map(() => '?').join(', ')})` : '0';
  const eligible = `id = ? AND disabled = 0 AND (is_admin = 1 OR is_owner = 1 OR ${configuredClause})`;
  const audit = auditStatement(database, context, admin.user, 'admin.owner.transfer', true, { id, name: target.name });
  let results;
  try {
    results = await database.batch([
      database.prepare(`UPDATE users SET is_owner = 0 WHERE is_owner = 1 AND id <> ? AND EXISTS (SELECT 1 FROM users WHERE ${eligible})`)
        .bind(id, id, ...configured),
      database.prepare(`UPDATE users SET is_admin = 1, is_owner = 1 WHERE ${eligible}`)
        .bind(id, ...configured),
      ...(audit ? [audit] : []),
    ]);
  } catch { return error(503, 'busy', 'The server is busy. Try again in a moment.'); }
  if ((results[1]?.meta?.changes ?? 0) !== 1) return error(400, 'target-not-admin', 'The new owner must be an enabled admin.');
  return json({ ok: true, id });
};

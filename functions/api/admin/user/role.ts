import { getAccountRoles, json } from '../../../lib/auth';
import { auditStatement, requireAdmin } from '../../../lib/radian-api/admin';
import { readSmallJson } from '../../../lib/radian-api/request';
import type { SyncContext } from '../../../types';

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const admin = await requireAdmin(context, true);
  if (admin instanceof Response) return admin;
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const id = typeof read.value.id === 'string' ? read.value.id.trim() : '';
  const makeAdmin = read.value.admin;
  if (!id || id.length > 128 || typeof makeAdmin !== 'boolean') return error(400, 'missing', 'A user id and admin flag are required.');
  if (id === admin.user.id) return error(400, 'owner-protected', 'The owner role cannot be changed.');

  const database = admin.env.DB!;
  const target = await database.prepare('SELECT display_name AS name, disabled FROM users WHERE id = ?').bind(id)
    .first<{ name: string; disabled: number }>();
  if (!target) return error(404, 'not-found', 'No user with that id.');
  const roles = await getAccountRoles(database, id, admin.env);
  const configured = (admin.env.ADMIN_UIDS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (roles.owner || configured.includes(id)) return error(400, 'role-protected', 'The owner and configured admins cannot be changed here.');
  if (makeAdmin && target.disabled === 1 && (roles.admin || configured.includes(id))) {
    return error(400, 'disabled', 'An account must be enabled before it can be promoted.');
  }
  const event = makeAdmin ? 'admin.role.grant' : 'admin.role.revoke';
  const audit = auditStatement(database, context, admin.user, event, true, { id, name: target.name });
  try {
    await database.batch([
      database.prepare(
        `UPDATE users SET is_admin = ?, disabled = CASE WHEN ? = 1 THEN 0 ELSE disabled END
          WHERE id = ? AND is_owner = 0 AND id <> ? AND id NOT IN (${configured.length ? configured.map(() => '?').join(', ') : "''"})`,
      ).bind(makeAdmin ? 1 : 0, makeAdmin ? 1 : 0, id, admin.user.id, ...configured),
      ...(audit ? [audit] : []),
    ]);
  } catch { return error(503, 'busy', 'The server is busy. Try again in a moment.'); }
  return json({ ok: true, id, admin: makeAdmin });
};

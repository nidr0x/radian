import { getAccountRoles, json } from '../../../lib/auth';
import { auditStatement, requireAdmin } from '../../../lib/radian-api/admin';
import { readSmallJson } from '../../../lib/radian-api/request';
import type { SyncContext } from '../../../types';

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const admin = await requireAdmin(context);
  if (admin instanceof Response) return admin;
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const id = typeof read.value.id === 'string' ? read.value.id.trim() : '';
  const disabled = read.value.disabled;
  if (!id || id.length > 128 || typeof disabled !== 'boolean') return error(400, 'missing', 'A user id and disabled flag are required.');
  const database = admin.env.DB!;
  const target = await database.prepare('SELECT display_name AS name FROM users WHERE id = ?').bind(id).first<{ name: string }>();
  if (!target) return error(404, 'not-found', 'No user with that id.');
  if (disabled && (await getAccountRoles(database, id, admin.env)).admin) return error(400, 'target-admin', 'An admin cannot be disabled.');

  const event = disabled ? 'admin.user.disable' : 'admin.user.enable';
  const audit = auditStatement(database, context, admin.user, event, true, { id, name: target.name });
  let results;
  try {
    results = await database.batch([
      database.prepare(
        `UPDATE users SET disabled = ?, session_version = session_version + CASE WHEN ? = 1 THEN 1 ELSE 0 END
          WHERE id = ? AND disabled <> ? AND (? = 0 OR (is_admin = 0 AND is_owner = 0))`,
      ).bind(disabled ? 1 : 0, disabled ? 1 : 0, id, disabled ? 1 : 0, disabled ? 1 : 0),
      database.prepare('DELETE FROM gym_device_link_codes WHERE account_id = ? AND ? = 1 AND changes() = 1').bind(id, disabled ? 1 : 0),
      ...(audit ? [audit] : []),
    ]);
  } catch { return error(503, 'busy', 'The server is busy. Try again in a moment.'); }
  if ((results[0]?.meta?.changes ?? 0) === 0) {
    const current = await database.prepare('SELECT disabled FROM users WHERE id = ?').bind(id).first<{ disabled: number }>();
    if (!current) return error(404, 'not-found', 'No user with that id.');
    if (disabled && (await getAccountRoles(database, id, admin.env)).admin) return error(400, 'target-admin', 'An admin cannot be disabled.');
  }
  return json({ ok: true, id, disabled });
};

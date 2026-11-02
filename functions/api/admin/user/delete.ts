import { getAccountRoles, json } from '../../../lib/auth';
import { requireAdmin } from '../../../lib/radian-api/admin';
import { readSmallJson } from '../../../lib/radian-api/request';
import type { SyncContext } from '../../../types';

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const admin = await requireAdmin(context);
  if (admin instanceof Response) return admin;
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const id = typeof read.value.id === 'string' ? read.value.id.trim() : '';
  if (!id || id.length > 128) return error(400, 'missing', 'A user id is required.');
  if (id === admin.user.id) return error(400, 'self-delete', 'You cannot delete your own account.');

  const database = admin.env.DB!;
  const target = await database.prepare('SELECT display_name AS name FROM users WHERE id = ?').bind(id).first<{ name: string }>();
  if (!target) return error(404, 'not-found', 'No user with that id.');
  const targetRoles = await getAccountRoles(database, id, admin.env);
  const accounts = await database.prepare('SELECT id, is_admin AS isAdmin, is_owner AS isOwner FROM users ORDER BY created_at, id')
    .all<{ id: string; isAdmin: number; isOwner: number }>();
  const configured = new Set((admin.env.ADMIN_UIDS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  if (targetRoles.owner) return error(400, 'owner-protected', 'The owner cannot be deleted.');
  if (targetRoles.admin && !admin.owner) return error(403, 'forbidden', 'Only the owner can delete another admin.');
  const remainingAdmins = accounts.results.filter((account) => account.id !== id
    && (account.isAdmin === 1 || account.isOwner === 1 || configured.has(account.id)));
  if (targetRoles.admin && remainingAdmins.length === 0) return error(400, 'last-admin', 'The last admin cannot be deleted.');

  const configuredIds = [...configured];
  const configuredFor = (alias: string): string => configuredIds.length
    ? `${alias}.id IN (${configuredIds.map(() => '?').join(', ')})` : '0';
  const ordinaryUser = (alias: string): string => `(${alias}.is_admin = 0 AND ${alias}.is_owner = 0 AND NOT (${configuredFor(alias)}))`;
  const eligible = `u.id = ? AND u.id <> ? AND u.is_owner = 0 AND ? = 0
    AND (? = 1 OR ${ordinaryUser('u')})
    AND (${ordinaryUser('u')} OR EXISTS (
      SELECT 1 FROM users other WHERE other.id <> ?
        AND (other.is_admin = 1 OR other.is_owner = 1 OR ${configuredFor('other')})
    ))`;
  const eligibleValues = [id, admin.user.id, targetRoles.owner ? 1 : 0, admin.owner ? 1 : 0,
    ...configuredIds, ...configuredIds, id, ...configuredIds];
  const statements = [
    database.prepare(
      `INSERT OR IGNORE INTO gym_media_cleanup_objects (object_key, queued_at)
       SELECT m.object_key, ? FROM gym_media_objects m
        WHERE m.account_id = ? AND EXISTS (SELECT 1 FROM users u WHERE ${eligible})`,
    ).bind(new Date().toISOString(), id, ...eligibleValues),
    database.prepare(
      `DELETE FROM users WHERE id = ? AND EXISTS (SELECT 1 FROM users u WHERE ${eligible})`,
    ).bind(id, ...eligibleValues),
    ...(admin.env.AUDIT_LOG === '0' ? [] : [database.prepare(
      `INSERT INTO gym_admin_audit
       (created_at, event, ok, actor_account_id, actor_name, target_account_id, target_name, ip)
       SELECT ?, 'admin.user.delete', 1, ?, ?, ?, ?, NULL WHERE changes() = 1`,
    ).bind(new Date().toISOString(), admin.user.id, admin.user.displayName, id, target.name)]),
  ];
  let results;
  try { results = await database.batch(statements); }
  catch { return error(503, 'busy', 'The server is busy. Try again in a moment.'); }
  if ((results[1]?.meta?.changes ?? 0) !== 1) {
    const stillExists = await database.prepare('SELECT id FROM users WHERE id = ?').bind(id).first<{ id: string }>();
    if (!stillExists) return error(404, 'not-found', 'No user with that id.');
    return error(400, 'delete-refused', 'This account cannot be deleted while it is the owner or the last admin.');
  }
  return json({ ok: true, id });
};

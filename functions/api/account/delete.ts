import { clearSessionCookie, enforceAuthRateLimit, getAccountRoles, getAuthenticatedContext, json } from '../../lib/auth';
import { getAccountSecurity, getPasskeyCount, verifyOwnerProof } from '../../lib/radian-api/account-security';
import { auditStatement } from '../../lib/radian-api/admin';
import { readSmallJson } from '../../lib/radian-api/request';
import type { SyncContext } from '../../types';

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'account-delete', authenticated.user.id);
  if (limited) return limited;
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');

  const typedName = typeof read.value.name === 'string' ? read.value.name.trim() : '';
  if (!typedName || typedName.length > 128) return error(400, 'confirm-name', 'Type your account name to confirm.');
  const database = authenticated.env.DB!;
  try {
    const target = await database.prepare('SELECT display_name AS name FROM users WHERE id = ?')
      .bind(authenticated.user.id).first<{ name: string }>();
    if (!target) return error(401, 'not_authenticated', 'Sign in again to continue.');
    if (target.name.trim() !== typedName) return error(400, 'confirm-name', 'Type your account name to confirm.');

    const roles = await getAccountRoles(database, authenticated.user.id, authenticated.env);
    const accounts = await database.prepare('SELECT id, is_admin AS isAdmin, is_owner AS isOwner FROM users ORDER BY created_at, id')
      .all<{ id: string; isAdmin: number; isOwner: number }>();
    const configuredAdmins = new Set((authenticated.env.ADMIN_UIDS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
    const others = accounts.results.filter((account) => account.id !== authenticated.user.id);
    const anotherAdmin = others.some((account) => account.isAdmin === 1 || account.isOwner === 1 || configuredAdmins.has(account.id));
    if (roles.admin && others.length > 0 && !anotherAdmin) {
      return error(409, 'last-admin', 'The last admin cannot leave while other profiles remain.');
    }

    const security = await getAccountSecurity(database, authenticated.user.id);
    const proof = await verifyOwnerProof(authenticated, security, await getPasskeyCount(database, authenticated.user.id), read.value);
    if (proof !== 'ok') {
      const audit = auditStatement(database, context, authenticated.user, 'auth.proof.fail', false, {
        action: 'account-delete', message: proof,
      });
      if (audit) await audit.run().catch(() => {});
      return error(403, proof, proof === 'current-required' ? 'Your current password is required.' : 'Your account could not be confirmed.');
    }

    const configuredIds = [...configuredAdmins];
    const configuredFor = (alias: string): string => configuredIds.length
      ? `${alias}.id IN (${configuredIds.map(() => '?').join(', ')})` : '0';
    const ordinaryUser = (alias: string): string => `(${alias}.is_admin = 0 AND ${alias}.is_owner = 0 AND NOT (${configuredFor(alias)}))`;
    const eligible = `u.id = ? AND u.display_name = ? AND (
      ${ordinaryUser('u')}
      OR NOT EXISTS (SELECT 1 FROM users other WHERE other.id <> u.id)
      OR EXISTS (SELECT 1 FROM users other WHERE other.id <> u.id
        AND (other.is_admin = 1 OR other.is_owner = 1 OR ${configuredFor('other')}))
    )`;
    const eligibleValues = [authenticated.user.id, typedName, ...configuredIds, ...configuredIds];
    const now = new Date().toISOString();
    const proofMethod = typeof read.value.current === 'string' && read.value.current.length > 0 ? 'password' : 'passkey';
    const statements = [
      database.prepare(
        `INSERT OR IGNORE INTO gym_media_cleanup_objects (object_key, queued_at)
         SELECT m.object_key, ? FROM gym_media_objects m
          WHERE m.account_id = ? AND EXISTS (SELECT 1 FROM users u WHERE ${eligible})`,
      ).bind(now, authenticated.user.id, ...eligibleValues),
      database.prepare(
        `DELETE FROM users WHERE id = ? AND display_name = ?
          AND EXISTS (SELECT 1 FROM users u WHERE ${eligible})`,
      ).bind(authenticated.user.id, typedName, ...eligibleValues),
      ...(authenticated.env.AUDIT_LOG === '0' ? [] : [database.prepare(
        `INSERT INTO gym_admin_audit
         (created_at, event, ok, actor_account_id, actor_name, target_account_id, target_name, action, message, ip)
         SELECT ?, 'auth.account.delete', 1, ?, ?, ?, ?, ?, NULL, NULL WHERE changes() = 1`,
      ).bind(now, authenticated.user.id, authenticated.user.displayName, authenticated.user.id, target.name, proofMethod)]),
    ];
    const results = await database.batch(statements);
    if ((results[1]?.meta?.changes ?? 0) !== 1) {
      const latest = await database.prepare('SELECT display_name AS name FROM users WHERE id = ?')
        .bind(authenticated.user.id).first<{ name: string }>();
      if (!latest) return error(401, 'not_authenticated', 'Sign in again to continue.');
      if (latest.name.trim() !== typedName) return error(400, 'confirm-name', 'Type your account name to confirm.');
      const latestRoles = await getAccountRoles(database, authenticated.user.id, authenticated.env);
      const latestOthers = await database.prepare('SELECT id, is_admin AS isAdmin, is_owner AS isOwner FROM users WHERE id <> ?')
        .bind(authenticated.user.id).all<{ id: string; isAdmin: number; isOwner: number }>();
      const latestAnotherAdmin = latestOthers.results.some((account) => account.isAdmin === 1 || account.isOwner === 1 || configuredAdmins.has(account.id));
      if (latestRoles.admin && latestOthers.results.length > 0 && !latestAnotherAdmin) {
        return error(409, 'last-admin', 'The last admin cannot leave while other profiles remain.');
      }
      return error(503, 'busy', 'The server is busy. Try again in a moment.');
    }
    return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(context) });
  } catch {
    return error(503, 'busy', 'The server is busy. Try again in a moment.');
  }
};

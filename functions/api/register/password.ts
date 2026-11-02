import { enforceAuthRateLimit, getAccountRoles, issueSessionCookie, json, randomId, requireDatabase } from '../../lib/auth';
import type { SyncContext } from '../../types';
import { hashPassword, normalizeEmail, normalizeLoginIdentifier, passwordPolicyError } from '../../lib/radian-api/password-core';
import { findActiveInvite } from '../../lib/radian-api/one-time-code';
import { readSmallJson } from '../../lib/radian-api/request';
import { auditStatement } from '../../lib/radian-api/admin';

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);
const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  if (context.env.PASSWORD_LOGIN !== '1') return error(404, 'password-disabled', 'Password sign-in is disabled.');
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const body = read.value;
  const name = typeof body.name === 'string' ? body.name.normalize('NFKC').trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!name || !password || [...name].length > 40) return error(400, 'missing', 'Name and password are required.');
  const policy = passwordPolicyError(password);
  if (policy) return error(400, policy, policy === 'too-common' ? 'This password is too easy to guess.' : 'The password does not meet the length policy.');
  const nameKey = normalizeLoginIdentifier(name);
  const limit = await enforceAuthRateLimit(context, 'password-register-ip');
  if (limit) return limit;
  const nameHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(nameKey))));
  const nameLimit = await enforceAuthRateLimit(context, 'password-register-name', nameHash);
  if (nameLimit) return nameLimit;

  const suppliedCode = typeof body.code === 'string' ? body.code : '';
  const inviteOnly = context.env.INVITE_ONLY === '1';
  const initialInvite = suppliedCode.trim() ? await findActiveInvite(database, suppliedCode) : null;
  if ((inviteOnly && !initialInvite) || (suppliedCode.trim() && !initialInvite)) {
    return error(403, 'invite', 'A valid invite code is required.');
  }
  const passwordHash = await hashPassword(password);
  const invite = initialInvite ? await findActiveInvite(database, suppliedCode) : null;
  if ((inviteOnly && !invite) || (suppliedCode.trim() && !invite)) return error(403, 'invite', 'A valid invite code is required.');
  let email: string | null = null;
  if (body.email !== undefined && body.email !== null) {
    if (typeof body.email !== 'string' || !normalizeEmail(body.email)) return error(400, 'email-invalid', 'That is not an e-mail address.');
    email = normalizeEmail(body.email);
  }
  const id = randomId(16);
  const createdAt = new Date().toISOString();
  try {
    await database.batch([
      ...(invite ? [database.prepare(
        'UPDATE gym_invites SET used_by_account_id = ?, used_at = ? WHERE code_hash = ? AND used_at IS NULL',
      ).bind(id, createdAt, invite.codeHash)] : []),
      invite ? database.prepare(
        `INSERT INTO users (id, display_name, created_at, invited_by_code)
         SELECT ?, ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM gym_invites WHERE code_hash = ? AND used_by_account_id = ? AND used_at = ?
         )`,
      ).bind(id, name, createdAt, invite.code, invite.codeHash, id, createdAt)
        : database.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').bind(id, name, createdAt),
      database.prepare('INSERT INTO gym_account_security (account_id, password_hash, password_set_at, email) VALUES (?, ?, ?, ?)').bind(id, passwordHash, createdAt, email),
      database.prepare("INSERT INTO gym_login_identifiers (identifier_key, account_id, kind, value) VALUES (?, ?, 'name', ?)").bind(nameKey, id, name),
      ...(email ? [database.prepare("INSERT INTO gym_login_identifiers (identifier_key, account_id, kind, value) VALUES (?, ?, 'email', ?)").bind(email, id, email)] : []),
      database.prepare(
        "UPDATE users SET is_admin = 1, is_owner = 1 WHERE id = ? AND ? = '1' AND (SELECT COUNT(*) FROM users) = 1 AND NOT EXISTS (SELECT 1 FROM users WHERE is_owner = 1)",
      ).bind(id, context.env.FIRST_USER_ADMIN ?? '0'),
    ]);
  } catch {
    if (invite && !await database.prepare('SELECT code FROM gym_invites WHERE code_hash = ? AND used_at IS NULL').bind(invite.codeHash).first<{ code: string }>().catch(() => null)) {
      return error(403, 'invite', 'A valid invite code is required.');
    }
    const [nameTaken, emailTaken] = await Promise.all([
      database.prepare("SELECT account_id FROM gym_login_identifiers WHERE identifier_key = ? AND kind = 'name'").bind(nameKey).first<{ accountId: string }>().catch(() => null),
      email ? database.prepare("SELECT account_id FROM gym_login_identifiers WHERE identifier_key = ? AND kind = 'email'").bind(email).first<{ accountId: string }>().catch(() => null) : null,
    ]);
    if (nameTaken) return error(409, 'name-taken', 'Another profile already signs in with this name.');
    if (emailTaken) return error(409, 'email-taken', 'Another profile already uses this e-mail address.');
    return error(503, 'busy', 'The server is busy. Try again in a moment.');
  }

  try {
    const cookie = await issueSessionCookie(context, id, 0);
    const roles = await getAccountRoles(database, id, context.env);
    const audit = auditStatement(database, context, { id, displayName: name }, 'auth.register.ok');
    if (audit) await audit.run().catch(() => {});
    return json({ user: { id, name, created: createdAt, ...roles } }, 200, { 'Set-Cookie': cookie });
  } catch {
    return error(503, 'busy', 'The server is busy. Try again in a moment.');
  }
};

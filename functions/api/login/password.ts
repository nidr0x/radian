import { enforceAuthRateLimit, getAccountRoles, issueSessionCookie, json, requireDatabase } from '../../lib/auth';
import type { SyncContext } from '../../types';
import { normalizeEmail, normalizeLoginIdentifier, verifyPassword } from '../../lib/radian-api/password-core';
import { readSmallJson } from '../../lib/radian-api/request';
import { auditStatement } from '../../lib/radian-api/admin';

interface PasswordLoginRow {
  id: string;
  displayName: string;
  createdAt: string;
  sessionVersion: number;
  disabled: number;
  passwordHash: string | null;
}

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);
const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

const findPasswordProfile = async (
  database: NonNullable<SyncContext['env']['DB']>,
  key: string,
  kind: 'name' | 'email',
): Promise<PasswordLoginRow | null> => database.prepare(
  `SELECT u.id, u.display_name AS displayName, u.created_at AS createdAt,
          u.session_version AS sessionVersion, u.disabled, s.password_hash AS passwordHash
     FROM gym_login_identifiers i
     JOIN users u ON u.id = i.account_id
     LEFT JOIN gym_account_security s ON s.account_id = u.id
    WHERE i.identifier_key = ? AND i.kind = ?`,
).bind(key, kind).first<PasswordLoginRow>();

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  if (context.env.PASSWORD_LOGIN !== '1') return error(404, 'password-disabled', 'Password sign-in is disabled.');
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  const bodyRead = await readSmallJson(context.request);
  if (!bodyRead.ok) return error(bodyRead.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const body = bodyRead.value;
  const password = typeof body.password === 'string' ? body.password : '';
  const requestedEmail = typeof body.email === 'string';
  const typedIdentifier = typeof body.identifier === 'string' ? body.identifier
    : typeof body.name === 'string' ? body.name
      : typeof body.email === 'string' ? body.email : '';
  if (!typedIdentifier.trim() || !password) return error(400, 'missing', 'Name and password are required.');

  const emailOnly = requestedEmail && typeof body.identifier !== 'string' && typeof body.name !== 'string';
  const email = normalizeEmail(typedIdentifier);
  const key = email ?? normalizeLoginIdentifier(typedIdentifier);
  const [ipLimit, identityHash] = await Promise.all([
    enforceAuthRateLimit(context, 'password-login-ip'),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)).then((digest) => hex(new Uint8Array(digest))),
  ]);
  if (ipLimit) return ipLimit;
  const identityLimit = await enforceAuthRateLimit(context, 'password-login-identifier', identityHash);
  if (identityLimit) return identityLimit;

  let profile: PasswordLoginRow | null = null;
  if (emailOnly) {
    if (email) profile = await findPasswordProfile(database, email, 'email');
  } else if (typedIdentifier.includes('@')) {
    if (email) profile = await findPasswordProfile(database, email, 'email');
    profile ??= await findPasswordProfile(database, normalizeLoginIdentifier(typedIdentifier), 'name');
  } else {
    profile = await findPasswordProfile(database, key, 'name');
  }

  const boundedPassword = [...password].length <= 256 ? password : 'oversized-password';
  let valid = false;
  try { valid = await verifyPassword(boundedPassword, profile?.passwordHash); }
  catch { return error(503, 'busy', 'The server is busy. Try again in a moment.'); }
  if (!profile || !valid) {
    const audit = auditStatement(database, context, { id: profile?.id ?? null, displayName: profile?.displayName ?? 'unknown caller' }, 'auth.password.fail', false, { message: profile ? 'bad-password' : 'unknown-name' });
    if (audit) await audit.run().catch(() => {});
    return error(401, 'bad-credentials', 'Wrong name, e-mail or password.');
  }
  if (profile.disabled === 1) {
    const audit = auditStatement(database, context, { id: profile.id, displayName: profile.displayName }, 'auth.password.fail', false, { message: 'account-disabled' });
    if (audit) await audit.run().catch(() => {});
    return error(403, 'disabled', 'This account has been disabled.');
  }

  const latest = await database.prepare(
    `SELECT u.session_version AS sessionVersion, u.disabled, s.password_hash AS passwordHash
       FROM users u JOIN gym_account_security s ON s.account_id = u.id WHERE u.id = ?`,
  ).bind(profile.id).first<{ sessionVersion: number; disabled: number; passwordHash: string | null }>();
  if (!latest || latest.passwordHash !== profile.passwordHash) return error(401, 'bad-credentials', 'Wrong name, e-mail or password.');
  if (latest.disabled === 1) return error(403, 'disabled', 'This account has been disabled.');

  try {
    const cookie = await issueSessionCookie(context, profile.id, latest.sessionVersion);
    const roles = await getAccountRoles(database, profile.id, context.env);
    const audit = auditStatement(database, context, { id: profile.id, displayName: profile.displayName }, 'auth.password.ok');
    if (audit) await audit.run().catch(() => {});
    return json({ user: { id: profile.id, name: profile.displayName, created: profile.createdAt, ...roles } }, 200, { 'Set-Cookie': cookie });
  } catch {
    return error(503, 'busy', 'The server is busy. Try again in a moment.');
  }
};

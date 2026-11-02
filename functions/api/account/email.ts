import { enforceAuthRateLimit, getAuthenticatedContext, json } from '../../lib/auth';
import type { SyncContext } from '../../types';
import { getAccountSecurity, getPasskeyCount, passwordLoginEnabled, verifyOwnerProof } from '../../lib/radian-api/account-security';
import { normalizeEmail } from '../../lib/radian-api/password-core';
import { readSmallJson } from '../../lib/radian-api/request';

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);

const saveEmail = async (context: SyncContext, requestedEmail: string | null, suppliedBody?: Record<string, unknown>): Promise<Response> => {
  if (!passwordLoginEnabled(context)) return error(404, 'password-disabled', 'Password sign-in is disabled.');
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'account-email', authenticated.user.id);
  if (limited) return limited;
  const read = suppliedBody ? { ok: true as const, value: suppliedBody } : await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const nextEmail = requestedEmail === null || requestedEmail.trim() === '' ? null : normalizeEmail(requestedEmail);
  if (requestedEmail !== null && requestedEmail.trim() !== '' && !nextEmail) {
    return error(400, 'email-invalid', 'That is not an e-mail address.');
  }
  const key = nextEmail;

  const database = authenticated.env.DB!;
  try {
    const security = await getAccountSecurity(database, authenticated.user.id);
    if ((security?.email ?? null) === nextEmail) return json({ ok: true, email: nextEmail });
    const proof = await verifyOwnerProof(authenticated, security, await getPasskeyCount(database, authenticated.user.id), read.value);
    if (proof !== 'ok') return error(403, proof, proof === 'current-required' ? 'Your current password is required.' : 'Your account could not be confirmed.');

    const results = await database.batch([
      database.prepare('INSERT OR IGNORE INTO gym_account_security (account_id) VALUES (?)').bind(authenticated.user.id),
      database.prepare(
        `DELETE FROM gym_login_identifiers
          WHERE account_id = ? AND kind = 'email'
            AND (? IS NULL OR NOT EXISTS (
              SELECT 1 FROM gym_login_identifiers WHERE identifier_key = ? AND account_id <> ?
            ))`,
      ).bind(authenticated.user.id, key, key, authenticated.user.id),
      ...(key ? [database.prepare(
        `INSERT INTO gym_login_identifiers (identifier_key, account_id, kind, value)
         SELECT ?, ?, 'email', ?
          WHERE NOT EXISTS (SELECT 1 FROM gym_login_identifiers WHERE identifier_key = ? AND account_id <> ?)`,
      ).bind(key, authenticated.user.id, key, key, authenticated.user.id)] : []),
      database.prepare(
        `UPDATE gym_account_security SET email = ? WHERE account_id = ?
          AND (? IS NULL OR NOT EXISTS (
            SELECT 1 FROM gym_login_identifiers WHERE identifier_key = ? AND account_id <> ?
          ))`,
      ).bind(key, authenticated.user.id, key, key, authenticated.user.id),
    ]);
    const updateIndex = results.length - 1;
    if ((results[updateIndex]?.meta?.changes ?? 0) !== 1) return error(409, 'email-taken', 'Another profile already uses this e-mail address.');
    return json({ ok: true, email: key });
  } catch {
    const conflict = key ? await database.prepare(
      'SELECT account_id FROM gym_login_identifiers WHERE identifier_key = ? AND account_id <> ?',
    ).bind(key, authenticated.user.id).first<{ accountId: string }>().catch(() => null) : null;
    return conflict
      ? error(409, 'email-taken', 'Another profile already uses this e-mail address.')
      : error(503, 'busy', 'The server is busy. Try again in a moment.');
  }
};

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  if (!Object.hasOwn(read.value, 'email')) return error(400, 'missing', 'An e-mail address is required.');
  const value = read.value.email;
  if (value !== null && typeof value !== 'string') return error(400, 'email-invalid', 'That is not an e-mail address.');
  return saveEmail(context, typeof value === 'string' ? value : null, read.value);
};

export const onRequestDelete = async (context: SyncContext): Promise<Response> => saveEmail(context, null);

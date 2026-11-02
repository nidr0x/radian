import { enforceAuthRateLimit, getAuthenticatedContext, json } from '../../lib/auth';
import { getAccountSecurity, getPasskeyCount, verifyOwnerProof } from '../../lib/radian-api/account-security';
import { auditStatement } from '../../lib/radian-api/admin';
import { createOneTimeCode, hashCode } from '../../lib/radian-api/one-time-code';
import { readSmallJson } from '../../lib/radian-api/request';
import type { SyncContext } from '../../types';

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'device-link-create', authenticated.user.id);
  if (limited) return limited;
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');

  const database = authenticated.env.DB!;
  const passkeys = await getPasskeyCount(database, authenticated.user.id);
  if (passkeys >= 20) return error(409, 'passkey-limit', 'A profile can have at most 20 passkeys.');
  const proof = await verifyOwnerProof(authenticated, await getAccountSecurity(database, authenticated.user.id), passkeys, read.value);
  if (proof !== 'ok') return error(403, proof, proof === 'current-required' ? 'Your current password is required.' : 'Your account could not be confirmed.');

  const { value, display } = createOneTimeCode();
  const codeHash = await hashCode(value);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const audit = auditStatement(database, context, authenticated.user, 'auth.link.create', true, { action: proof });
  try {
    await database.batch([
      database.prepare(
        `INSERT INTO gym_device_link_codes (account_id, code_hash, created_at, expires_at, used_at)
         VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(account_id) DO UPDATE SET code_hash = excluded.code_hash, created_at = excluded.created_at, expires_at = excluded.expires_at, used_at = NULL`,
      ).bind(authenticated.user.id, codeHash, createdAt, expiresAt),
      ...(audit ? [audit] : []),
    ]);
  } catch {
    return error(503, 'busy', 'The server is busy. Try again in a moment.');
  }
  return json({ code: display, expires: Date.parse(expiresAt) });
};

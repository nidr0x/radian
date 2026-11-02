import { json } from '../../../lib/auth';
import { auditStatement, requireAdmin } from '../../../lib/radian-api/admin';
import { hashCode, normalizeInviteCode } from '../../../lib/radian-api/one-time-code';
import { readSmallJson } from '../../../lib/radian-api/request';
import type { SyncContext } from '../../../types';

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const admin = await requireAdmin(context);
  if (admin instanceof Response) return admin;
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const code = typeof read.value.code === 'string' ? normalizeInviteCode(read.value.code) : '';
  if (!/^[A-F0-9]{16}$/.test(code)) return error(400, 'invalid-code', 'An invite code is required.');
  const database = admin.env.DB!;
  const codeHash = await hashCode(code);
  const invite = await database.prepare('SELECT used_at AS usedAt FROM gym_invites WHERE code_hash = ?').bind(codeHash).first<{ usedAt: string | null }>();
  if (!invite) return error(404, 'not-found', 'No invite with that code.');
  if (invite.usedAt) return error(400, 'already-used', 'A used invite cannot be revoked.');
  const audit = auditStatement(database, context, admin.user, 'admin.invite.revoke', true, { message: code });
  const statements = [database.prepare('DELETE FROM gym_invites WHERE code_hash = ? AND used_at IS NULL').bind(codeHash)];
  if (audit) statements.push(audit);
  try {
    const results = await database.batch(statements);
    if ((results[0]?.meta?.changes ?? 0) !== 1) return error(400, 'already-used', 'A used invite cannot be revoked.');
  } catch { return error(503, 'busy', 'The server is busy. Try again in a moment.'); }
  return json({ ok: true, code });
};

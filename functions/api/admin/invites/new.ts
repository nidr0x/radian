import { json } from '../../../lib/auth';
import { auditStatement, requireAdmin } from '../../../lib/radian-api/admin';
import { createInviteCode, hashCode } from '../../../lib/radian-api/one-time-code';
import { readSmallJson } from '../../../lib/radian-api/request';
import type { SyncContext } from '../../../types';

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const admin = await requireAdmin(context);
  if (admin instanceof Response) return admin;
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const note = typeof read.value.note === 'string' ? read.value.note.trim().slice(0, 120) : '';
  const code = createInviteCode();
  const codeHash = await hashCode(code);
  const created = new Date().toISOString();
  const audit = auditStatement(admin.env.DB!, context, admin.user, 'admin.invite.create', true, { message: code });
  try {
    await admin.env.DB!.batch([
      admin.env.DB!.prepare(
        `INSERT INTO gym_invites (code, code_hash, note, created_by_account_id, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(code, codeHash, note, admin.user.id, created),
      ...(audit ? [audit] : []),
    ]);
  } catch { return error(503, 'busy', 'The server is busy. Try again in a moment.'); }
  return json({ invite: { code, note, createdBy: admin.user.id, created, usedBy: null, usedAt: null, usedByName: null } });
};

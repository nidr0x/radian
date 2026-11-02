import { json } from '../../../lib/auth';
import { auditStatement, requireAdmin } from '../../../lib/radian-api/admin';
import type { SyncContext } from '../../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const admin = await requireAdmin(context, true);
  if (admin instanceof Response) return admin;
  const audit = auditStatement(admin.env.DB!, context, admin.user, 'admin.audit.clear', true, undefined, true);
  const statements = [admin.env.DB!.prepare('DELETE FROM gym_admin_audit')];
  if (audit) statements.push(audit);
  try { await admin.env.DB!.batch(statements); }
  catch { return json({ error: 'busy', message: 'The server is busy. Try again in a moment.' }, 503); }
  return json({ ok: true });
};

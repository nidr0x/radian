import { json } from '../../lib/auth';
import { requireAdmin } from '../../lib/radian-api/admin';
import type { SyncContext } from '../../types';

interface InviteRow {
  code: string;
  note: string;
  createdBy: string | null;
  created: string;
  usedBy: string | null;
  usedAt: string | null;
  usedByName: string | null;
}

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const admin = await requireAdmin(context);
  if (admin instanceof Response) return admin;
  const invites = await admin.env.DB!.prepare(
    `SELECT i.code, i.note, i.created_by_account_id AS createdBy, i.created_at AS created,
            i.used_by_account_id AS usedBy, i.used_at AS usedAt, u.display_name AS usedByName
       FROM gym_invites i LEFT JOIN users u ON u.id = i.used_by_account_id
      ORDER BY i.created_at DESC, i.code`,
  ).all<InviteRow>();
  return json({ invites: invites.results, invite_only: admin.env.INVITE_ONLY === '1' });
};

import { json } from '../../lib/auth';
import { requireAdmin } from '../../lib/radian-api/admin';
import type { SyncContext } from '../../types';

interface AdminListRow {
  id: string;
  name: string;
  created: string;
  disabled: number;
  isAdmin: number;
  isOwner: number;
  invitedBy: string | null;
  workouts: number;
  lastWorkout: string | null;
  lastSyncAt: string | null;
  hasPush: number;
  passwordHash: string | null;
  email: string | null;
  liveAccountId: string | null;
  liveName: string | null;
  liveExIdx: number | null;
  liveExTotal: number | null;
  liveSetsDone: number | null;
  liveSetsTotal: number | null;
  liveStartedAt: number | null;
  liveUpdatedAt: number | null;
}

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const admin = await requireAdmin(context);
  if (admin instanceof Response) return admin;
  const database = admin.env.DB!;
  const now = Date.now();
  await database.prepare(
    `DELETE FROM gym_activity_presence
      WHERE account_id IN (
        SELECT account_id FROM gym_activity_presence
         WHERE updated_at <= ? OR (hidden_at IS NOT NULL AND hidden_at <= ?)
         ORDER BY updated_at LIMIT 100
      )`,
  ).bind(now - 70_000, now - 45_000).run();
  const rows = await database.prepare(
    `SELECT u.id, u.display_name AS name, u.created_at AS created, u.disabled,
            u.is_admin AS isAdmin, u.is_owner AS isOwner, u.invited_by_code AS invitedBy,
            COALESCE(w.workouts, 0) AS workouts, w.last_workout AS lastWorkout,
            s.updated_at AS lastSyncAt, COALESCE(p.has_push, 0) AS hasPush,
            a.password_hash AS passwordHash, a.email,
            l.account_id AS liveAccountId, l.name AS liveName, l.ex_idx AS liveExIdx,
            l.ex_total AS liveExTotal, l.sets_done AS liveSetsDone,
            l.sets_total AS liveSetsTotal, l.started_at AS liveStartedAt, l.updated_at AS liveUpdatedAt
       FROM users u
       LEFT JOIN (SELECT account_id, COUNT(*) AS workouts, MAX(session_date) AS last_workout
                    FROM gym_sessions GROUP BY account_id) w ON w.account_id = u.id
       LEFT JOIN gym_sync_state s ON s.account_id = u.id
       LEFT JOIN (SELECT account_id, 1 AS has_push FROM gym_push_subscriptions GROUP BY account_id) p ON p.account_id = u.id
       LEFT JOIN gym_account_security a ON a.account_id = u.id
       LEFT JOIN gym_activity_presence l ON l.account_id = u.id
        AND l.updated_at > ? AND (l.hidden_at IS NULL OR l.hidden_at > ?)
      ORDER BY u.created_at, u.id`,
  ).bind(now - 70_000, now - 45_000).all<AdminListRow>();

  const configuredAdmins = new Set((admin.env.ADMIN_UIDS ?? '').split(',').map((id) => id.trim()).filter(Boolean));
  const explicitOwner = rows.results.find((row) => row.isOwner === 1)?.id;
  const ownerId = explicitOwner ?? rows.results.find((row) => configuredAdmins.has(row.id))?.id
    ?? rows.results.find((row) => row.isAdmin === 1)?.id;
  const users = rows.results.map((row) => ({
    id: row.id,
    name: row.name,
    created: row.created,
    disabled: row.disabled === 1,
    owner: row.id === ownerId,
    admin: row.isAdmin === 1 || row.isOwner === 1 || configuredAdmins.has(row.id) || row.id === ownerId,
    invitedBy: row.invitedBy,
    workouts: row.workouts,
    lastWorkout: row.lastWorkout,
    lastSync: row.lastSyncAt && Number.isFinite(Date.parse(row.lastSyncAt)) ? Date.parse(row.lastSyncAt) : null,
    hasPush: row.hasPush === 1,
    live: row.liveAccountId ? {
      name: row.liveName ?? '',
      exIdx: row.liveExIdx ?? 0,
      exTotal: row.liveExTotal ?? 0,
      setsDone: row.liveSetsDone ?? 0,
      setsTotal: row.liveSetsTotal ?? 0,
      startedAt: row.liveStartedAt ?? now,
      updatedAt: row.liveUpdatedAt ?? now,
    } : null,
    ...(admin.env.PASSWORD_LOGIN === '1' ? { password: !!row.passwordHash, email: row.email } : {}),
  }));
  return json({
    users,
    invite_only: admin.env.INVITE_ONLY === '1',
    ...(admin.env.PASSWORD_LOGIN === '1' ? { password_login: true } : {}),
    now,
  });
};

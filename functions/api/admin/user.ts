import { isRecord, json } from '../../lib/auth';
import { readGymState } from '../../lib/db/radian/state';
import { getAccountRoles } from '../../lib/auth';
import { getAccountSecurity } from '../../lib/radian-api/account-security';
import { requireAdmin } from '../../lib/radian-api/admin';
import type { SyncContext } from '../../types';

interface AdminUserRow {
  id: string;
  name: string;
  created: string;
  disabled: number;
  invitedBy: string | null;
  updatedAt: string | null;
}

const objects = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.filter(isRecord) : [];
const milliseconds = (value: string | null): number | null => value && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const admin = await requireAdmin(context);
  if (admin instanceof Response) return admin;
  const id = new URL(context.request.url).searchParams.get('id')?.trim() ?? '';
  if (!id || id.length > 128) return json({ error: 'missing', message: 'A user id is required.' }, 400);
  const database = admin.env.DB!;
  const user = await database.prepare(
    `SELECT u.id, u.display_name AS name, u.created_at AS created, u.disabled,
            u.invited_by_code AS invitedBy, s.updated_at AS updatedAt
       FROM users u LEFT JOIN gym_sync_state s ON s.account_id = u.id WHERE u.id = ?`,
  ).bind(id).first<AdminUserRow>();
  if (!user) return json({ error: 'not-found', message: 'No user with that id.' }, 404);
  const [roles, security, reset, snapshot] = await Promise.all([
    getAccountRoles(database, id, admin.env),
    admin.env.PASSWORD_LOGIN === '1' ? getAccountSecurity(database, id) : Promise.resolve(null),
    admin.env.PASSWORD_LOGIN === '1'
      ? database.prepare('SELECT expires_at AS expiresAt FROM gym_password_reset_codes WHERE account_id = ? AND used_at IS NULL AND expires_at > ?')
        .bind(id, new Date().toISOString()).first<{ expiresAt: string }>()
      : Promise.resolve(null),
    readGymState(database, id),
  ]);
  const state = snapshot.state ?? {};
  const workouts = objects(state.workouts).filter((workout) => Array.isArray(workout.entries)
    && workout.entries.every((entry) => isRecord(entry) && Array.isArray(entry.sets)))
    .map((workout) => {
      const { media: _media, ...ownerOnlyMedia } = workout;
      return ownerOnlyMedia;
    });
  return json({
    user: {
      id: user.id,
      name: user.name,
      created: user.created,
      disabled: user.disabled === 1,
      ...roles,
      invitedBy: user.invitedBy,
      ...(admin.env.PASSWORD_LOGIN === '1' ? {
        password: !!security?.passwordHash,
        email: security?.email ?? null,
        resetUntil: milliseconds(reset?.expiresAt ?? null),
      } : {}),
    },
    unit: state.unit === 'lb' ? 'lb' : 'kg',
    lastSync: milliseconds(user.updatedAt),
    routines: objects(state.routines),
    bodyweight: objects(state.bodyweight),
    measurements: objects(state.measurements),
    workouts,
  });
};

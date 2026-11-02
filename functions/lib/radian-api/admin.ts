import { getAccountRoles, getAuthenticatedContext, json } from '../auth';
import type { AuthenticatedContext } from '../auth';
import type { D1DatabaseLike, SyncContext } from '../../types';

export interface AdminContext extends AuthenticatedContext {
  admin: boolean;
  owner: boolean;
}

export const requireAdmin = async (context: SyncContext, ownerOnly = false): Promise<AdminContext | Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const roles = await getAccountRoles(authenticated.env.DB!, authenticated.user.id, authenticated.env);
  if (!roles.admin || (ownerOnly && !roles.owner)) {
    await recordAdminEvent(authenticated.env.DB!, context, authenticated.user, 'admin.denied', false).catch(() => {});
    return json({ error: 'forbidden', code: 'forbidden' }, 403);
  }
  return { ...authenticated, admin: roles.admin, owner: roles.owner };
};

const ipForAudit = (context: SyncContext): string | null => {
  const mode = context.env.AUDIT_IP;
  if (mode !== 'net' && mode !== 'full') return null;
  const value = context.request.headers.get('CF-Connecting-IP')?.trim();
  if (!value) return null;
  if (mode === 'full') return value.slice(0, 64);
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)) return `${value.split('.').slice(0, 3).join('.')}.0`;
  const groups = value.toLowerCase().split(':').filter(Boolean);
  return groups.length ? `${groups.slice(0, 3).join(':')}::/48` : null;
};

export const auditStatement = (
  database: D1DatabaseLike,
  context: SyncContext,
  actor: { id: string | null; displayName: string },
  event: string,
  ok = true,
  target?: { id?: string; name?: string; action?: string; message?: string },
  force = false,
) => context.env.AUDIT_LOG === '0' && !force ? null : database.prepare(
  `INSERT INTO gym_admin_audit
   (created_at, event, ok, actor_account_id, actor_name, target_account_id, target_name, action, message, ip)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(new Date().toISOString(), event, ok ? 1 : 0, actor.id, actor.displayName, target?.id ?? null, target?.name ?? null, target?.action ?? null, target?.message ?? null, ipForAudit(context));

export const recordAdminEvent = async (
  database: D1DatabaseLike,
  context: SyncContext,
  actor: { id: string | null; displayName: string },
  event: string,
  ok = true,
  target?: { id?: string; name?: string },
): Promise<void> => {
  const statement = auditStatement(database, context, actor, event, ok, target);
  if (statement) await statement.run();
};

export const auditRetention = (context: SyncContext): { max: number; days: number; ipMode: 'off' | 'net' | 'full' } => {
  const bounded = (value: string | undefined, fallback: number, max: number): number => {
    if (!value || !/^\d+$/.test(value)) return fallback;
    return Math.min(Number(value), max);
  };
  return {
    max: bounded(context.env.AUDIT_MAX, 5000, 100_000),
    days: bounded(context.env.AUDIT_DAYS, 90, 3650),
    ipMode: context.env.AUDIT_IP === 'net' || context.env.AUDIT_IP === 'full' ? context.env.AUDIT_IP : 'off',
  };
};

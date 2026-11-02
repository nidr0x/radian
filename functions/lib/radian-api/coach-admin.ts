import { enforceAuthRateLimit, json } from '../auth';
import type { AdminContext } from './admin';
import { auditStatement, requireAdmin } from './admin';
import { readSmallJson } from './request';
import type { SyncContext } from '../../types';

export const sameOriginCoachMutation = (context: SyncContext): boolean => {
  const origin = context.request.headers.get('Origin');
  const fetchSite = context.request.headers.get('Sec-Fetch-Site');
  return (origin === null || origin === new URL(context.request.url).origin) && fetchSite !== 'cross-site';
};

export const coachAdminGuard = async (
  context: SyncContext,
  action: string,
  mutation = false,
): Promise<AdminContext | Response> => {
  if (mutation && !sameOriginCoachMutation(context)) return json({ error: 'cross_origin' }, 403);
  const admin = await requireAdmin(context);
  if (admin instanceof Response) return admin;
  const limited = await enforceAuthRateLimit(context, `coach-admin-${action}`, admin.user.id);
  if (limited) return limited;
  return admin;
};

export const coachAdminBody = async (request: Request, maxBytes = 16_384) => {
  const result = await readSmallJson(request, maxBytes);
  return result.ok ? result.value : null;
};

export const coachAdminInvalidBody = () => json({ error: 'invalid_request' }, 400);

export const coachAdminAudit = async (
  admin: AdminContext,
  context: SyncContext,
  event: string,
  action: string,
): Promise<void> => {
  const statement = auditStatement(admin.env.DB!, context, admin.user, event, true, { action });
  if (statement) await statement.run().catch(() => {});
};

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

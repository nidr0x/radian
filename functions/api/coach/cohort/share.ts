import { enforceAuthRateLimit, getAuthenticatedContext, json } from '../../../lib/auth';
import { coachRuntime } from '../../../lib/radian-api/coach.js';
import { sameOriginCoachMutation } from '../../../lib/radian-api/coach-admin';
import { coachAdminBody } from '../../../lib/radian-api/coach-admin';
import type { CoachApiContext } from '../../../lib/radian-api/coach-routes';

export const onRequestPost = async (context: CoachApiContext): Promise<Response> => {
  if (!sameOriginCoachMutation(context)) return json({ error: 'cross_origin' }, 403);
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'coach-cohort', authenticated.user.id);
  if (limited) return limited;
  const body = await coachAdminBody(context.request, 2048);
  if (!body || typeof body.share !== 'boolean') return json({ error: 'invalid_request' }, 400);
  if (body.share) {
    const runtime = await coachRuntime(authenticated.env);
    if (runtime.reason === 'config_unavailable') return json({ error: 'coach_off' }, 503);
    if (!runtime.enabled || !runtime.community) return json({ error: 'cohort_disabled' }, 409);
  }
  try {
    await authenticated.env.DB!.prepare(`INSERT INTO gym_coach_cohort_shares(account_id, sharing, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET sharing = excluded.sharing, updated_at = excluded.updated_at`)
      .bind(authenticated.user.id, body.share ? 1 : 0, new Date().toISOString()).run();
  } catch { return json({ error: 'cohort_unavailable' }, 503); }
  return json({ ok: true, sharing: body.share });
};

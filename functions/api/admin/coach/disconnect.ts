import { json } from '../../../lib/auth';
import { HTTP_PROVIDERS } from '../../../../api/coach/core/providers.js';
import { readCoachSettings, removeCoachCredential, type CoachSettings, type CoachWorkerEnvironment } from '../../../lib/radian-api/coach.js';
import { coachAdminAudit, coachAdminBody, coachAdminGuard } from '../../../lib/radian-api/coach-admin';
import type { SyncContext } from '../../../types';

type CoachContext = SyncContext & { env: SyncContext['env'] & CoachWorkerEnvironment };

export const onRequestPost = async (context: CoachContext): Promise<Response> => {
  const admin = await coachAdminGuard(context, 'disconnect', true);
  if (admin instanceof Response) return admin;
  const body = await coachAdminBody(context.request, 2048);
  if (!body) return json({ error: 'invalid_request' }, 400);
  let settings: CoachSettings;
  try { settings = await readCoachSettings(context.env); }
  catch { return json({ error: 'config_unavailable' }, 503); }
  const provider = typeof body.provider === 'string' ? body.provider : settings.provider;
  if (typeof provider !== 'string' || !Object.hasOwn(HTTP_PROVIDERS, provider)) return json({ error: 'provider_unavailable' }, 400);
  try { await removeCoachCredential(context.env, provider); }
  catch { return json({ error: 'credential_remove_unavailable' }, 503); }
  await coachAdminAudit(admin, context, 'coach.credential.removed', 'disconnect');
  return json({ ok: true, connected: false });
};

import { json } from '../../../lib/auth';
import { HTTP_PROVIDERS } from '../../../../api/coach/core/providers.js';
import { readCoachSettings, saveCoachCredential, type CoachSettings, type CoachWorkerEnvironment } from '../../../lib/radian-api/coach.js';
import { coachAdminAudit, coachAdminBody, coachAdminGuard, coachAdminInvalidBody } from '../../../lib/radian-api/coach-admin';
import type { SyncContext } from '../../../types';

type CoachContext = SyncContext & { env: SyncContext['env'] & CoachWorkerEnvironment };

export const onRequestPost = async (context: CoachContext): Promise<Response> => {
  const admin = await coachAdminGuard(context, 'connect', true);
  if (admin instanceof Response) return admin;
  const body = await coachAdminBody(context.request, 8192);
  if (!body) return coachAdminInvalidBody();
  if (body.type !== 'apikey') return json({ error: 'runtime_unavailable', reason: 'Only HTTPS API keys are supported in Cloudflare Workers.' }, 400);
  if (typeof body.token !== 'string' || !body.token.trim() || body.token.length > 4096) return json({ error: 'invalid_credential' }, 400);
  let settings: CoachSettings;
  try { settings = await readCoachSettings(context.env); }
  catch { return json({ error: 'config_unavailable' }, 503); }
  const provider = typeof body.provider === 'string' ? body.provider : settings.provider;
  if (typeof provider !== 'string' || !Object.hasOwn(HTTP_PROVIDERS, provider)) return json({ error: 'provider_unavailable' }, 400);
  try { await saveCoachCredential(context.env, provider, body.token); }
  catch (error) {
    const code = error instanceof Error ? error.message : 'credential_save_unavailable';
    return json({ error: code === 'credential_wrap_unavailable' ? code : 'credential_save_unavailable' }, 503);
  }
  await coachAdminAudit(admin, context, 'coach.credential.saved', 'connect');
  return json({ ok: true, connected: true });
};

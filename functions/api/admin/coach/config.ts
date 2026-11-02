import { json } from '../../../lib/auth';
import { HTTP_PROVIDERS, validateHeaders } from '../../../../api/coach/core/providers.js';
import { readCoachSettings, saveCoachConfig, validateCoachWorkerBaseUrl, type CoachSettings, type CoachWorkerEnvironment } from '../../../lib/radian-api/coach.js';
import { coachAdminAudit, coachAdminBody, coachAdminGuard, coachAdminInvalidBody, isRecord } from '../../../lib/radian-api/coach-admin';
import type { SyncContext } from '../../../types';

type CoachContext = SyncContext & { env: SyncContext['env'] & CoachWorkerEnvironment };

const intIn = (value: unknown, min: number, max: number): value is number => Number.isInteger(value) && Number(value) >= min && Number(value) <= max;

export const onRequestPost = async (context: CoachContext): Promise<Response> => {
  const admin = await coachAdminGuard(context, 'config', true);
  if (admin instanceof Response) return admin;
  const body = await coachAdminBody(context.request);
  if (!body) return coachAdminInvalidBody();
  let current: CoachSettings;
  try { current = await readCoachSettings(context.env); }
  catch { return json({ error: 'config_unavailable' }, 503); }
  const provider = body.provider === undefined ? current.provider : body.provider;
  if (typeof provider !== 'string' || !Object.hasOwn(HTTP_PROVIDERS, provider)) return json({ error: 'provider_unavailable' }, 400);
  const models = isRecord(current.models) ? { ...current.models } : {};
  if (body.model !== undefined) {
    if (typeof body.model !== 'string' || body.model.length > 80) return json({ error: 'invalid_model' }, 400);
    if (body.model.trim()) models[provider] = body.model.trim(); else delete models[provider];
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return json({ error: 'invalid_enabled' }, 400);
  if (body.community !== undefined && typeof body.community !== 'boolean') return json({ error: 'invalid_community' }, 400);
  const caps = isRecord(body.caps) ? { ...current.caps } : current.caps;
  if (body.caps !== undefined && !isRecord(body.caps)) return json({ error: 'invalid_caps' }, 400);
  if (isRecord(body.caps)) {
    for (const key of ['perProfileDaily', 'instanceDaily'] as const) {
      if (body.caps[key] !== undefined && !intIn(body.caps[key], 0, key === 'perProfileDaily' ? 200 : 5000)) return json({ error: 'invalid_caps' }, 400);
      if (body.caps[key] !== undefined) caps[key] = body.caps[key] as number;
    }
  }
  const maxMessageLen = body.maxMessageLen === undefined ? current.maxMessageLen : body.maxMessageLen;
  if (!intIn(maxMessageLen, 200, 4000)) return json({ error: 'invalid_max_message_len' }, 400);
  const maxOutputTokens = body.maxOutputTokens === undefined ? current.maxOutputTokens : body.maxOutputTokens;
  if (!intIn(maxOutputTokens, 1024, 65536)) return json({ error: 'invalid_max_output_tokens' }, 400);
  let baseUrl = current.provider === provider ? current.baseUrl : null;
  if (body.baseUrl !== undefined) {
    if (typeof body.baseUrl !== 'string' || body.baseUrl.length > 2048) return json({ error: 'invalid_base_url' }, 400);
    const checked = validateCoachWorkerBaseUrl(body.baseUrl);
    if (!checked.ok) return json({ error: 'invalid_base_url', reason: checked.error }, 400);
    baseUrl = checked.value;
  }
  let headers = current.provider === provider ? current.headers : null;
  if (body.headers !== undefined) {
    const checked = validateHeaders(body.headers);
    if (!checked.ok) return json({ error: 'invalid_headers' }, 400);
    headers = checked.value;
  }
  const next = {
    enabled: body.enabled === undefined ? current.enabled : body.enabled,
    provider,
    model: typeof models[provider] === 'string' ? models[provider] : null,
    models,
    ...(provider === 'compatible' ? { baseUrl: baseUrl || '' } : {}),
    headers: provider === 'compatible' ? headers : null,
    community: body.community === undefined ? current.community : body.community,
    caps,
    maxMessageLen,
    maxOutputTokens,
  };
  try { await saveCoachConfig(context.env, next); }
  catch { return json({ error: 'config_save_unavailable' }, 503); }
  await coachAdminAudit(admin, context, 'coach.config.updated', 'updated');
  return json({ ok: true });
};

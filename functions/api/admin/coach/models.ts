import { json } from '../../../lib/auth';
import { coachExplicitProvider, type CoachWorkerEnvironment } from '../../../lib/radian-api/coach.js';
import { coachAdminAudit, coachAdminGuard } from '../../../lib/radian-api/coach-admin';
import type { SyncContext } from '../../../types';

type CoachContext = SyncContext & { env: SyncContext['env'] & CoachWorkerEnvironment };
type ExplicitProvider = {
  reason: string | null; provider: string; adapter: { models(cfg: unknown, env: Record<string, string>, opts?: Record<string, unknown>): Promise<{ ok: boolean; models: string[]; error?: string }> };
  cfg: unknown; apiKey: string | null; meta: { apiKeyEnv?: string };
};

export const onRequestPost = async (context: CoachContext): Promise<Response> => {
  const admin = await coachAdminGuard(context, 'models', true);
  if (admin instanceof Response) return admin;
  const config = await coachExplicitProvider(context.env) as unknown as ExplicitProvider;
  if (config.reason) return json({ ok: false, models: [], error: config.reason }, 503);
  if (!config.adapter || !config.meta?.apiKeyEnv) return json({ ok: false, models: [], error: 'provider_unavailable' }, 400);
  const result = await config.adapter.models(config.cfg, config.apiKey ? { [config.meta.apiKeyEnv]: config.apiKey } : {});
  await coachAdminAudit(admin, context, 'coach.models.listed', 'models');
  return json({ ok: result.ok, models: result.models.slice(0, 300).map(model => model.slice(0, 120)), ...(result.error ? { error: result.error.slice(0, 240) } : {}) });
};

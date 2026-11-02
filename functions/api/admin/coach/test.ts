import { json } from '../../../lib/auth';
import { coachExplicitProvider, type CoachWorkerEnvironment } from '../../../lib/radian-api/coach.js';
import { coachAdminAudit, coachAdminGuard } from '../../../lib/radian-api/coach-admin';
import type { SyncContext } from '../../../types';

type CoachContext = SyncContext & { env: SyncContext['env'] & CoachWorkerEnvironment };
type ExplicitProvider = {
  reason: string | null; provider: string; model: string | null;
  adapter: { invoke(opts: Record<string, unknown>): Promise<{ code: number; text?: string; stderr?: string; timedOut?: boolean; spawnError?: boolean }> };
  cfg: unknown; apiKey: string | null; meta: { apiKeyEnv?: string };
};

export const onRequestPost = async (context: CoachContext): Promise<Response> => {
  const admin = await coachAdminGuard(context, 'test', true);
  if (admin instanceof Response) return admin;
  const config = await coachExplicitProvider(context.env) as unknown as ExplicitProvider;
  if (config.reason) return json({ ok: false, error: config.reason }, 503);
  if (!config.adapter || !config.meta?.apiKeyEnv) return json({ ok: false, error: 'provider_unavailable' }, 400);
  if (!config.model) return json({ ok: false, error: 'model_unavailable' }, 400);
  const result = await config.adapter.invoke({
    cfg: config.cfg,
    prompt: 'Return exactly the JSON object {"ok":true}.',
    system: 'This is a connection check. Do not include any other text.',
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
    env: config.apiKey ? { [config.meta.apiKeyEnv]: config.apiKey } : {},
    model: config.model,
    timeoutMs: 90_000,
    maxTokens: 128,
  });
  let answer: unknown = null;
  if (result.code === 0) {
    try { answer = JSON.parse(String(result.text || '').trim()); } catch { /* invalid provider output is a failed check */ }
  }
  const ok = result.code === 0 && !!answer && typeof answer === 'object' && !Array.isArray(answer) && (answer as { ok?: unknown }).ok === true;
  await coachAdminAudit(admin, context, 'coach.connection.tested', 'test');
  return json({ ok, ...(ok ? { version: config.provider } : { error: result.timedOut ? 'timed out' : result.stderr?.slice(0, 240) || 'provider response did not match the test contract' }) });
};

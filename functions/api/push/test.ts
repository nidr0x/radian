import { enforceAuthRateLimit, getAuthenticatedContext, json, randomId } from '../../lib/auth';
import { enqueueDurableJob } from '../../lib/radian-api/jobs';
import { pushIsReady, type PushEnvironment } from '../../lib/radian-api/push';
import type { SyncContext } from '../../types';

type PushContext = SyncContext & { env: SyncContext['env'] & PushEnvironment };

export const onRequestPost = async (context: PushContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'push-test', authenticated.user.id);
  if (limited) return limited;
  if (!pushIsReady(context.env)) return json({ error: 'push_unavailable' }, 503);
  const accountId = authenticated.user.id;
  const existing = await authenticated.env.DB!.prepare(
    'SELECT 1 AS present FROM gym_push_subscriptions WHERE account_id = ? LIMIT 1',
  ).bind(accountId).first<{ present: number }>();
  if (!existing) return json({ ok: true });
  const queued = await enqueueDurableJob(authenticated.env.DB!, context.env.PUSH_QUEUE, {
    accountId,
    type: 'push',
    idempotencyKey: randomId(18),
    payload: { kind: 'test' },
  });
  return queued.ok ? json({ ok: true }) : json({ error: queued.error }, 503);
};

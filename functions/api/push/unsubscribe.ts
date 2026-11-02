import { enforceAuthRateLimit, getAuthenticatedContext, json, isRecord } from '../../lib/auth';
import { isSafePushEndpoint } from '../../lib/radian-api/webpush';
import { pushEndpointHash, readPushJson, type PushEnvironment } from '../../lib/radian-api/push';
import type { SyncContext } from '../../types';

type PushContext = SyncContext & { env: SyncContext['env'] & PushEnvironment };

export const onRequestPost = async (context: PushContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'push-unsubscribe', authenticated.user.id);
  if (limited) return limited;
  const body = await readPushJson(context.request);
  if (!body || !isRecord(body) || typeof body.endpoint !== 'string' || !isSafePushEndpoint(body.endpoint)) {
    return json({ error: 'invalid_endpoint' }, 400);
  }
  const endpointHash = await pushEndpointHash(body.endpoint);
  await authenticated.env.DB!.prepare(
    'DELETE FROM gym_push_subscriptions WHERE account_id = ? AND endpoint_hash = ?',
  ).bind(authenticated.user.id, endpointHash).run();
  return json({ ok: true });
};

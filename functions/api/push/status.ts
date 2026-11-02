import { enforceAuthRateLimit, getAuthenticatedContext, json } from '../../lib/auth';
import { pushEndpointHash, type PushEnvironment } from '../../lib/radian-api/push';
import type { SyncContext } from '../../types';

type PushContext = SyncContext & { env: SyncContext['env'] & PushEnvironment };

export const onRequestGet = async (context: PushContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'push-status', authenticated.user.id);
  if (limited) return limited;
  const endpoint = new URL(context.request.url).searchParams.get('endpoint') ?? '';
  if (!endpoint || endpoint.length > 2048) return json({ error: 'invalid_endpoint' }, 400);
  const endpointHash = await pushEndpointHash(endpoint);
  const row = await authenticated.env.DB!.prepare(
    'SELECT device_id AS deviceId FROM gym_push_subscriptions WHERE account_id = ? AND endpoint_hash = ?',
  ).bind(authenticated.user.id, endpointHash).first<{ deviceId: string | null }>();
  return json(row ? { subscribed: true, deviceId: row.deviceId } : { subscribed: false });
};

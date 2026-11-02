import { cancelRestTimers } from '../../../lib/radian-api/jobs';
import { enforceAuthRateLimit, getAuthenticatedContext, json, isRecord } from '../../../lib/auth';
import { isDeviceId, readPushJson, type PushEnvironment } from '../../../lib/radian-api/push';
import type { SyncContext } from '../../../types';

type PushContext = SyncContext & { env: SyncContext['env'] & PushEnvironment };

export const onRequestPost = async (context: PushContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'push-rest-timer-cancel', authenticated.user.id);
  if (limited) return limited;
  const body = await readPushJson(context.request, 12_000, true);
  if (!body || !isRecord(body)) return json({ error: 'invalid_request' }, 400);
  if (body.deviceId !== undefined && !isDeviceId(body.deviceId)) return json({ error: 'invalid_device_id' }, 400);
  await cancelRestTimers(authenticated.env.DB!, authenticated.user.id, body.deviceId as string | undefined);
  return json({ ok: true });
};

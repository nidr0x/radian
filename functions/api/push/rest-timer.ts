import { enforceAuthRateLimit, getAuthenticatedContext, json, isRecord } from '../../lib/auth';
import { replaceRestTimer, isDeviceId, pushIsReady, readPushJson, type PushEnvironment } from '../../lib/radian-api/push';
import type { SyncContext } from '../../types';

type PushContext = SyncContext & { env: SyncContext['env'] & PushEnvironment };

export const onRequestPost = async (context: PushContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'push-rest-timer', authenticated.user.id);
  if (limited) return limited;
  if (!pushIsReady(context.env) || !context.env.PUSH_QUEUE) return json({ error: 'push_unavailable' }, 503);
  const body = await readPushJson(context.request);
  if (!body || !isRecord(body)) return json({ error: 'invalid_request' }, 400);
  const rawSeconds = body.seconds;
  const secondsValue = typeof rawSeconds === 'number' ? rawSeconds
    : typeof rawSeconds === 'string' && rawSeconds.trim() ? Number(rawSeconds) : Number.NaN;
  if (!Number.isFinite(secondsValue) || secondsValue < 1) return json({ error: 'seconds_required' }, 400);
  if (body.deviceId !== undefined && !isDeviceId(body.deviceId)) return json({ error: 'invalid_device_id' }, 400);
  const seconds = Math.ceil(Math.min(secondsValue, 3600));
  const queued = await replaceRestTimer(authenticated.env.DB!, context.env.PUSH_QUEUE, authenticated.user.id, seconds, body.deviceId as string | undefined);
  return queued.ok ? json({ ok: true }) : json({ error: queued.error }, 503);
};

import { getAuthenticatedContext, json } from '../lib/auth';
import type { SyncContext } from '../types';
import { mediaConfig, type MediaEnvironment } from '../lib/media/objects';
import { pushIsReady, type PushEnvironment } from '../lib/radian-api/push';
import { coachRuntime } from '../lib/radian-api/coach.js';
import type { CoachWorkerEnvironment } from '../lib/radian-api/coach.js';

interface ConfigContext extends SyncContext { env: SyncContext['env'] & MediaEnvironment & PushEnvironment & CoachWorkerEnvironment }

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const env = context.env as ConfigContext['env'];
  const response: Record<string, unknown> = {
    allow_guest: context.env.ALLOW_GUEST !== '0',
    invite_only: context.env.INVITE_ONLY === '1',
    password_login: context.env.PASSWORD_LOGIN === '1',
    media: env.MEDIA_BUCKET ? mediaConfig(env) : false,
    push: pushIsReady(env),
  };
  let signedIn = false;
  if (env.DB) {
    try { signedIn = !(await getAuthenticatedContext(context) instanceof Response); } catch { /* public flags remain available if auth storage is down */ }
  }
  if (signedIn) {
    const coach = await coachRuntime(env);
    response.coach = coach.enabled && coach.configured && Boolean(env.PUSH_QUEUE)
      ? { enabled: true, provider: coach.provider, providerLabel: coach.providerLabel, authMode: 'instance' }
      : null;
  }
  return json(response);
};

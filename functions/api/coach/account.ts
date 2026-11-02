import { getAuthenticatedContext, json } from '../../lib/auth';
import { coachRuntime } from '../../lib/radian-api/coach.js';
import type { CoachApiContext } from '../../lib/radian-api/coach-routes';

export const onRequestGet = async (context: CoachApiContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const runtime = await coachRuntime(context.env);
  return json({
    mode: 'instance', provider: runtime.provider, providerLabel: runtime.providerLabel,
    account: null, connected: runtime.enabled && runtime.configured && !!context.env.PUSH_QUEUE,
    reason: runtime.configured ? (context.env.PUSH_QUEUE ? null : 'queue_unavailable') : runtime.reason,
    message: null,
  });
};

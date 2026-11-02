import { getAuthenticatedContext, json } from '../../lib/auth';
import { DATA_CATEGORIES } from '../../../api/coach/core/categories.js';
import { coachRuntime } from '../../lib/radian-api/coach.js';
import type { CoachApiContext } from '../../lib/radian-api/coach-routes';

export const onRequestGet = async (context: CoachApiContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const runtime = await coachRuntime(context.env);
  const ready = runtime.enabled && runtime.configured && !!context.env.PUSH_QUEUE;
  return json({ provider: ready ? runtime.provider : null, providerLabel: ready ? runtime.providerLabel : null, host: ready ? runtime.host : null,
    categories: DATA_CATEGORIES, version: 1, payer: 'instance' });
};

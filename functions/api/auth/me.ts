import { getAuthenticatedContext, json } from '../../lib/auth';
import type { SyncContext } from '../../types';

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  return json({ user: authenticated.user });
};

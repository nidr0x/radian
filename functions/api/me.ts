import { getAccountRoles, getAuthenticatedContext, json } from '../lib/auth';
import { legacyUserShape } from '../lib/radian-api/compat';
import type { SyncContext } from '../types';

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const roles = await getAccountRoles(authenticated.env.DB!, authenticated.user.id, authenticated.env);
  return json({ user: legacyUserShape({ ...authenticated.user, ...roles }) });
};

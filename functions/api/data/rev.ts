import { getAuthenticatedContext, json } from '../../lib/auth';
import { readGymRevision } from '../../lib/db/radian/state';
import type { SyncContext } from '../../types';

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const revision = await readGymRevision(authenticated.env.DB!, authenticated.user.id);
  return json(revision);
};

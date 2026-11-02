import { onRequestPost as registerOptions } from '../auth/register/options';
import { mapLegacyAuthResponse, rewriteJsonRequest } from '../../lib/radian-api/compat';
import type { SyncContext } from '../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const mapped = await rewriteJsonRequest(context, (body) => ({
    ...body,
    displayName: body.name ?? body.displayName,
  }));
  return mapLegacyAuthResponse(await registerOptions(mapped), mapped);
};

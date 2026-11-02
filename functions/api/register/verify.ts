import { onRequestPost as registerVerify } from '../auth/register/verify';
import { mapLegacyAuthResponse, rewriteJsonRequest } from '../../lib/radian-api/compat';
import type { SyncContext } from '../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const mapped = await rewriteJsonRequest(context, (body) => ({ ...body, challengeId: body.cid ?? body.challengeId }));
  return mapLegacyAuthResponse(await registerVerify(mapped), context);
};

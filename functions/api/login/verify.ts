import { onRequestPost as loginVerify } from '../auth/login/verify';
import { mapLegacyAuthResponse, rewriteJsonRequest } from '../../lib/radian-api/compat';
import type { SyncContext } from '../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const mapped = await rewriteJsonRequest(context, (body) => ({ ...body, challengeId: body.cid ?? body.challengeId }));
  return mapLegacyAuthResponse(await loginVerify(mapped), context);
};

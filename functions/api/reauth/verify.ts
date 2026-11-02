import { onRequestPost as reauthVerify } from '../auth/reauth/verify';
import { rewriteJsonRequest } from '../../lib/radian-api/compat';
import type { SyncContext } from '../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const mapped = await rewriteJsonRequest(context, (body) => ({ ...body, challengeId: body.cid ?? body.challengeId }));
  return reauthVerify(mapped);
};

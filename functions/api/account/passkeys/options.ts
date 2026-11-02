import { onRequestPost as addPasskeyOptions } from '../../auth/passkeys/options';
import { mapLegacyAuthResponse, rewriteJsonRequest } from '../../../lib/radian-api/compat';
import type { SyncContext } from '../../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const mapped = await rewriteJsonRequest(context, (body) => ({ ...body, passkeyLabel: body.name ?? body.passkeyLabel }));
  return mapLegacyAuthResponse(await addPasskeyOptions(mapped), mapped);
};

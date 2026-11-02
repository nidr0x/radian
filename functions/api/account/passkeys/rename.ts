import { onRequestPatch as renamePasskey } from '../../auth/passkeys/index';
import { rewriteJsonRequest } from '../../../lib/radian-api/compat';
import type { SyncContext } from '../../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const mapped = await rewriteJsonRequest(context, (body) => ({
    ...body,
    credentialId: body.id ?? body.credentialId,
    label: body.name ?? body.label,
  }));
  return renamePasskey({ ...mapped, request: new Request(mapped.request, { method: 'PATCH' }) });
};

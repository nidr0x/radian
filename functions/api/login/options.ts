import { onRequestPost as loginOptions } from '../auth/login/options';
import { mapLegacyAuthResponse } from '../../lib/radian-api/compat';
import type { SyncContext } from '../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> =>
  mapLegacyAuthResponse(await loginOptions(context), context);

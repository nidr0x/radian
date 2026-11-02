import { onRequestPost as reauthOptions } from '../auth/reauth/options';
import { mapLegacyAuthResponse } from '../../lib/radian-api/compat';
import type { SyncContext } from '../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> =>
  mapLegacyAuthResponse(await reauthOptions(context), context);

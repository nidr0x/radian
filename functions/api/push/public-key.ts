import { json } from '../../lib/auth';
import { pushIsReady, pushVapidConfig, type PushEnvironment } from '../../lib/radian-api/push';
import type { SyncContext } from '../../types';

type PushContext = SyncContext & { env: SyncContext['env'] & PushEnvironment };

export const onRequestGet = (context: PushContext): Response => {
  const config = pushVapidConfig(context.env);
  if (!pushIsReady(context.env) || !config) return json({ error: 'push_unavailable' }, 503);
  return json({ key: config.publicKey });
};

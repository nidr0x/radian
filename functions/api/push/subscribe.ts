import { enforceAuthRateLimit, getAuthenticatedContext, isRecord, json, randomId } from '../../lib/auth';
import { parsePushSubscription, pushEndpointHash, pushIsReady, readPushJson, type PushEnvironment } from '../../lib/radian-api/push';
import type { SyncContext } from '../../types';

type PushContext = SyncContext & { env: SyncContext['env'] & PushEnvironment };

export const onRequestPost = async (context: PushContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'push-subscribe', authenticated.user.id);
  if (limited) return limited;
  if (!pushIsReady(context.env)) return json({ error: 'push_unavailable' }, 503);
  const body = await readPushJson(context.request);
  if (!body || !isRecord(body.subscription)) return json({ error: 'invalid_subscription' }, 400);
  const subscription = parsePushSubscription({ ...body.subscription, deviceId: body.deviceId });
  if (!subscription) return json({ error: 'invalid_subscription' }, 400);

  const database = authenticated.env.DB!;
  const endpointHash = await pushEndpointHash(subscription.endpoint);
  const now = new Date().toISOString();
  const accountId = authenticated.user.id;
  const insert = database.prepare(
    `INSERT INTO gym_push_subscriptions
       (account_id, subscription_id, endpoint_hash, endpoint, public_key, auth_secret, device_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(endpoint_hash) DO UPDATE SET
       account_id = excluded.account_id,
       subscription_id = excluded.subscription_id,
       endpoint = excluded.endpoint,
       public_key = excluded.public_key,
       auth_secret = excluded.auth_secret,
       device_id = COALESCE(excluded.device_id, gym_push_subscriptions.device_id),
       created_at = CASE WHEN gym_push_subscriptions.account_id = excluded.account_id
                         THEN gym_push_subscriptions.created_at ELSE excluded.created_at END,
       updated_at = excluded.updated_at
     WHERE gym_push_subscriptions.account_id = excluded.account_id
        OR (gym_push_subscriptions.public_key = excluded.public_key AND gym_push_subscriptions.auth_secret = excluded.auth_secret)`,
  ).bind(accountId, randomId(12), endpointHash, subscription.endpoint, subscription.p256dh, subscription.auth, subscription.deviceId ?? null, now, now);
  const trim = database.prepare(
    `DELETE FROM gym_push_subscriptions WHERE account_id = ? AND subscription_id NOT IN (
       SELECT subscription_id FROM gym_push_subscriptions WHERE account_id = ?
        ORDER BY created_at DESC, subscription_id DESC LIMIT 20
     ) AND EXISTS (
       SELECT 1 FROM gym_push_subscriptions WHERE account_id = ? AND endpoint_hash = ?
     )`,
  ).bind(accountId, accountId, accountId, endpointHash);
  let result;
  try { [result] = await database.batch([insert, trim]); }
  catch { return json({ error: 'subscription_store_failed' }, 503); }
  if ((result?.meta?.changes ?? 0) !== 1) return json({ error: 'subscription_belongs_to_another_account' }, 409);
  return json({ ok: true });
};

import { decodeBase64Url, randomId } from '../auth';
import { readSmallText } from './request';
import { isSafePushEndpoint } from './webpush';
import type { D1DatabaseLike } from '../../types';
import type { JobQueueLike } from './jobs';

export interface PushEnvironment {
  PUSH_QUEUE?: JobQueueLike;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export interface ParsedPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceId?: string;
}

const DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const isDeviceId = (value: unknown): value is string => typeof value === 'string' && DEVICE_ID.test(value);

export const pushVapidConfig = (env: PushEnvironment): { publicKey: string; privateKey: string; subject: string } | null => {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env;
  if (!publicKey || !privateKey || !subject || !/^(?:mailto:.+|https:\/\/.+)$/.test(subject)) return null;
  try {
    const publicBytes = decodeBase64Url(publicKey);
    const privateBytes = decodeBase64Url(privateKey);
    if (publicBytes.length !== 65 || publicBytes[0] !== 4 || privateBytes.length !== 32) return null;
  } catch { return null; }
  return { publicKey, privateKey, subject };
};

export const pushIsReady = (env: PushEnvironment): boolean => Boolean(env.PUSH_QUEUE && pushVapidConfig(env));

export const parsePushSubscription = (value: unknown): ParsedPushSubscription | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const subscription = value as Record<string, unknown>;
  const keys = subscription.keys;
  if (typeof subscription.endpoint !== 'string' || !isSafePushEndpoint(subscription.endpoint)
    || !keys || typeof keys !== 'object' || Array.isArray(keys)) return null;
  const keyValues = keys as Record<string, unknown>;
  if (typeof keyValues.p256dh !== 'string' || typeof keyValues.auth !== 'string') return null;
  try {
    const publicKey = decodeBase64Url(keyValues.p256dh);
    const auth = decodeBase64Url(keyValues.auth);
    if (publicKey.length !== 65 || publicKey[0] !== 4 || auth.length !== 16) return null;
  } catch { return null; }
  return {
    endpoint: subscription.endpoint,
    p256dh: keyValues.p256dh,
    auth: keyValues.auth,
    ...(isDeviceId(subscription.deviceId) ? { deviceId: subscription.deviceId } : {}),
  };
};

export const readPushJson = async (request: Request, maxBytes = 12_000, allowEmpty = false): Promise<Record<string, unknown> | null> => {
  if (allowEmpty && request.body === null) return {};
  const text = await readSmallText(request, maxBytes);
  if (!text.ok) return null;
  if (!text.value.trim() && allowEmpty) return {};
  try {
    const body: unknown = JSON.parse(text.value);
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch { return null; }
};

export const pushEndpointHash = async (endpoint: string): Promise<string> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const replaceRestTimer = async (
  database: D1DatabaseLike,
  queue: JobQueueLike,
  accountId: string,
  seconds: number,
  deviceId?: string,
): Promise<{ ok: true; jobId: string } | { ok: false; error: string }> => {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600) return { ok: false, error: 'invalid_seconds' };
  const jobId = randomId(18);
  const idempotencyKey = randomId(18);
  const runAt = new Date(Date.now() + seconds * 1000).toISOString();
  const payloadJson = JSON.stringify({ kind: 'rest_timer', ...(deviceId ? { deviceId } : {}) });
  const now = new Date().toISOString();
  const cancel = database.prepare(
    `UPDATE gym_durable_jobs SET status = 'cancelled', updated_at = ?
      WHERE account_id = ? AND job_type = 'rest_timer' AND status = 'queued'
        AND (? IS NULL OR json_extract(payload_json, '$.deviceId') = ?)`,
  ).bind(now, accountId, deviceId ?? null, deviceId ?? null);
  const insert = database.prepare(
    `INSERT INTO gym_durable_jobs
       (job_id, account_id, owner_type, owner_key, job_type, idempotency_key, status, payload_json, run_at, created_at, updated_at)
     VALUES (?, ?, 'account', ?, 'rest_timer', ?, 'queued', ?, ?, ?, ?)`,
  ).bind(jobId, accountId, accountId, idempotencyKey, payloadJson, runAt, now, now);
  try {
    const results = await database.batch([cancel, insert]);
    if ((results[1]?.meta?.changes ?? 0) !== 1) return { ok: false, error: 'job_store_failed' };
  } catch { return { ok: false, error: 'job_store_failed' }; }
  try { await queue.send({ jobId }, { delaySeconds: seconds }); } catch { /* the scheduled dispatcher picks up persisted jobs */ }
  return { ok: true, jobId };
};

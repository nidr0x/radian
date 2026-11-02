import type { D1DatabaseLike } from '../../types';
import { pushVapidConfig, type PushEnvironment } from './push';
import { sendWebPush } from './webpush';
import type { JobQueueLike } from './jobs';
import { readGymState } from '../db/radian/state';
import { runCoachJob, type CoachJobInput, type CoachWorkerEnvironment } from './coach.js';

export interface QueueMessageLike<T = unknown> {
  body: T;
  attempts: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface JobWorkerEnvironment extends PushEnvironment, CoachWorkerEnvironment {
  DB: D1DatabaseLike;
  JOB_DLQ_QUEUE?: string;
  PUSH_QUEUE?: JobQueueLike;
}

export interface QueueBatchLike {
  queue: string;
  messages: readonly QueueMessageLike[];
}

interface JobRow {
  jobId: string;
  accountId: string | null;
  jobType: string;
  status: string;
  payloadJson: string;
  runAt: string;
  updatedAt: string;
  attempt: number;
  resultJson: string | null;
}

interface SubscriptionRow {
  subscriptionId: string;
  endpointHash: string;
  endpoint: string;
  publicKey: string;
  authSecret: string;
  deviceId: string | null;
}

const nowIso = (): string => new Date().toISOString();
const decodeObject = (value: string | null): Record<string, unknown> => {
  try {
    const parsed: unknown = value ? JSON.parse(value) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
};

const hasCoachConsent = (state: Record<string, unknown> | null): boolean => {
  const coach = state?.coach;
  const consent = coach && typeof coach === 'object' && !Array.isArray(coach)
    ? (coach as Record<string, unknown>).consent : null;
  return !!consent && typeof consent === 'object' && !Array.isArray(consent)
    && !!(consent as Record<string, unknown>).agreedAt;
};

const setJobStatus = async (database: D1DatabaseLike, jobId: string, status: string, result?: Record<string, unknown>): Promise<void> => {
  await database.prepare(
    `UPDATE gym_durable_jobs SET status = ?, result_json = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running'`,
  ).bind(status, result ? JSON.stringify(result) : null, nowIso(), jobId).run();
};

const finishCoachJob = async (database: D1DatabaseLike, job: JobRow, env: JobWorkerEnvironment): Promise<void> => {
  if (!job.accountId) {
    await setJobStatus(database, job.jobId, 'failed', { outcome: 'failed', errorClass: 'nostate' });
    return;
  }
  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(job.payloadJson);
    input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    await setJobStatus(database, job.jobId, 'failed', { outcome: 'failed', errorClass: 'internal' });
    return;
  }
  const kind = input.kind;
  if (kind !== 'create' && kind !== 'review' && kind !== 'debrief') {
    await setJobStatus(database, job.jobId, 'failed', { outcome: 'failed', errorClass: 'internal' });
    return;
  }
  const snapshot = await readGymState(database, job.accountId);
  if (!snapshot.state) {
    await setJobStatus(database, job.jobId, 'failed', { kind, outcome: 'failed', errorClass: 'nostate' });
    return;
  }
  const result = await runCoachJob(snapshot.state, {
    jobId: job.jobId,
    accountId: job.accountId,
    kind,
    lang: typeof input.lang === 'string' ? input.lang : undefined,
    options: input.options && typeof input.options === 'object' && !Array.isArray(input.options)
      ? input.options as Record<string, unknown> : {},
  } satisfies CoachJobInput, env);
  if (!result.ok) {
    if (result.retryable) throw new Error(`coach_retryable_${result.errorClass}`);
    await setJobStatus(database, job.jobId, 'failed', { kind, outcome: 'failed', errorClass: result.errorClass });
    return;
  }
  const current = await readGymState(database, job.accountId);
  if (!hasCoachConsent(current.state)) {
    await setJobStatus(database, job.jobId, 'failed', { kind, outcome: 'failed', errorClass: 'consent' });
    return;
  }
  if ('nochange' in result) {
    await setJobStatus(database, job.jobId, 'succeeded', { kind, outcome: 'nochange', reading: result.reading });
    return;
  }

  const createdAt = new Date(result.pending.createdAt as number).toISOString();
  const updatedAt = nowIso();
  const pendingJson = JSON.stringify(result.pending);
  await database.batch([
    database.prepare(`UPDATE gym_coach_proposals SET status = 'stale', updated_at = ?
      WHERE account_id = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM gym_durable_jobs WHERE job_id = ? AND status = 'running')`)
      .bind(updatedAt, job.accountId, job.jobId),
    database.prepare(`INSERT INTO gym_coach_proposals
      (account_id, proposal_id, job_id, status, payload_json, created_at, updated_at)
      SELECT ?, ?, ?, 'pending', ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM gym_durable_jobs WHERE job_id = ? AND status = 'running')`)
      .bind(job.accountId, job.jobId, job.jobId, pendingJson, createdAt, updatedAt, job.jobId),
    database.prepare(`UPDATE gym_durable_jobs SET status = 'succeeded', result_json = ?, updated_at = ?
      WHERE job_id = ? AND status = 'running'`).bind(JSON.stringify({ kind, outcome: 'ready' }), updatedAt, job.jobId),
  ]);
};

const retryDelay = (attempts: number): number => Math.min(300, Math.max(5, 5 * (2 ** Math.min(attempts, 6))));

const pushMessage = (kind: string, language: string): Record<string, unknown> => {
  const spanish = language.toLowerCase().startsWith('es');
  if (kind === 'test') return {
    title: 'Radian',
    body: spanish ? 'Las notificaciones están listas.' : 'Push notifications are ready.',
    tag: 'push-test',
  };
  return {
    title: 'Radian',
    body: spanish ? 'Se acabó el descanso, a la siguiente serie.' : 'Rest is over. Ready for the next set?',
    tag: 'rest-timer',
  };
};

const subscriptionsFor = async (database: D1DatabaseLike, accountId: string, deviceId?: string): Promise<SubscriptionRow[]> => {
  const statement = deviceId
    ? database.prepare(
      `SELECT subscription_id AS subscriptionId, endpoint_hash AS endpointHash, endpoint,
              public_key AS publicKey, auth_secret AS authSecret, device_id AS deviceId
         FROM gym_push_subscriptions WHERE account_id = ? AND (device_id = ? OR device_id IS NULL)`,
    ).bind(accountId, deviceId)
    : database.prepare(
      `SELECT subscription_id AS subscriptionId, endpoint_hash AS endpointHash, endpoint,
              public_key AS publicKey, auth_secret AS authSecret, device_id AS deviceId
         FROM gym_push_subscriptions WHERE account_id = ?`,
    ).bind(accountId);
  return (await statement.all<SubscriptionRow>()).results;
};

const localeFor = async (database: D1DatabaseLike, accountId: string): Promise<string> => {
  const row = await database.prepare(
    `SELECT COALESCE(
       (SELECT json_extract(value_json, '$') FROM gym_state_fields WHERE account_id = ? AND field_key = 'lang'),
       (SELECT language FROM gym_profile WHERE account_id = ?), 'en'
     ) AS language`,
  ).bind(accountId, accountId).first<{ language: string | null }>();
  return row?.language ?? 'en';
};

export const dispatchDueJobs = async (database: D1DatabaseLike, queue: JobQueueLike, now = new Date()): Promise<number> => {
  const stamp = now.toISOString();
  const cutoff = new Date(now.getTime() - 60_000).toISOString();
  const rows = await database.prepare(
    `SELECT job_id AS jobId, updated_at AS updatedAt FROM gym_durable_jobs
      WHERE status = 'queued' AND attempt = 0 AND run_at <= ? AND updated_at <= ?
      ORDER BY run_at, created_at LIMIT 100`,
  ).bind(stamp, cutoff).all<{ jobId: string; updatedAt: string }>();
  let dispatched = 0;
  for (const row of rows.results) {
    try {
      await queue.send({ jobId: row.jobId });
      await database.prepare(
        `UPDATE gym_durable_jobs SET updated_at = ?
          WHERE job_id = ? AND status = 'queued' AND attempt = 0 AND updated_at = ?`,
      ).bind(stamp, row.jobId, row.updatedAt).run();
      dispatched++;
    } catch { /* retain queued state for the next scheduled sweep */ }
  }
  return dispatched;
};

export const processJobMessage = async (
  message: QueueMessageLike,
  queueName: string,
  env: JobWorkerEnvironment,
  send = sendWebPush,
  now = new Date(),
): Promise<void> => {
  const body = message.body;
  const jobId = body && typeof body === 'object' ? (body as { jobId?: unknown }).jobId : undefined;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(jobId)) { message.ack(); return; }
  const database = env.DB;
  if (env.JOB_DLQ_QUEUE && queueName === env.JOB_DLQ_QUEUE) {
    await database.prepare(
      `UPDATE gym_durable_jobs SET status = 'failed',
          result_json = CASE WHEN job_type = 'coach'
            THEN json_set(COALESCE(result_json, '{}'), '$.outcome', 'failed', '$.errorClass', 'provider')
            ELSE result_json END,
          updated_at = ?
        WHERE job_id = ? AND status IN ('queued', 'running')`,
    ).bind(now.toISOString(), jobId).run();
    message.ack();
    return;
  }

  const job = await database.prepare(
    `SELECT job_id AS jobId, account_id AS accountId, job_type AS jobType, status, payload_json AS payloadJson,
            run_at AS runAt, updated_at AS updatedAt, attempt, result_json AS resultJson
       FROM gym_durable_jobs WHERE job_id = ?`,
  ).bind(jobId).first<JobRow>();
  if (!job) { message.ack(); return; }
  const recoverRunning = job.status === 'running' && Date.parse(job.updatedAt) <= now.getTime() - 16 * 60_000;
  if (job.status === 'running' && !recoverRunning) { message.retry({ delaySeconds: 300 }); return; }
  if (job.status !== 'queued' && !recoverRunning) { message.ack(); return; }
  const runAt = Date.parse(job.runAt);
  if (Number.isFinite(runAt) && runAt > now.getTime()) {
    message.retry({ delaySeconds: Math.min(86_400, Math.max(1, Math.ceil((runAt - now.getTime()) / 1000))) });
    return;
  }
  const claimed = await database.prepare(
    `UPDATE gym_durable_jobs SET status = 'running', attempt = attempt + 1, updated_at = ?
      WHERE job_id = ? AND (status = 'queued' OR (status = 'running' AND updated_at <= ?)) AND run_at <= ?`,
  ).bind(now.toISOString(), jobId, new Date(now.getTime() - 16 * 60_000).toISOString(), now.toISOString()).run();
  if ((claimed.meta?.changes ?? 0) !== 1) { message.ack(); return; }

  let result = decodeObject(job.resultJson);
  delete result.error;
  try {
    if (job.jobType === 'coach') {
      await finishCoachJob(database, job, env);
      message.ack();
      return;
    }
    if (job.jobType !== 'push' && job.jobType !== 'rest_timer') throw new Error('unsupported_job_type');
    if (!job.accountId) throw new Error('account_required');
    const config = pushVapidConfig(env);
    if (!config) throw new Error('push_config_unavailable');
    const payload = JSON.parse(job.payloadJson) as { kind?: unknown; deviceId?: unknown };
    const kind = job.jobType === 'rest_timer' ? 'rest_timer' : payload.kind === 'test' ? 'test' : '';
    if (!kind) throw new Error('invalid_push_job');
    const targets = await subscriptionsFor(database, job.accountId, kind === 'rest_timer' && typeof payload.deviceId === 'string' ? payload.deviceId : undefined);
    const notification = pushMessage(kind, await localeFor(database, job.accountId));
    const sent = Array.isArray(result.sent) ? result.sent.filter((item): item is string => typeof item === 'string') : [];
    const delivered = new Set(sent);
    for (const target of targets) {
      if (delivered.has(target.endpointHash)) continue;
      const response = await send({ endpoint: target.endpoint, p256dh: target.publicKey, auth: target.authSecret }, notification, config);
      if (response.status === 403 || response.status === 404 || response.status === 410) {
        await database.prepare(
          'DELETE FROM gym_push_subscriptions WHERE account_id = ? AND subscription_id = ?',
        ).bind(job.accountId, target.subscriptionId).run();
        continue;
      }
      if (response.status === 429 || response.status >= 500) throw new Error(`push_retryable_status_${response.status}`);
      if (!response.ok) continue;
      delivered.add(target.endpointHash);
      result = { ...result, sent: [...delivered] };
      await database.prepare(
        `UPDATE gym_durable_jobs SET result_json = ?, updated_at = ? WHERE job_id = ? AND status = 'running'`,
      ).bind(JSON.stringify(result), nowIso(), jobId).run();
    }
    await setJobStatus(database, jobId, 'succeeded', { ...result, sent: [...delivered] });
    message.ack();
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 120) : 'job_failed';
    if (['coach_adapter_unavailable', 'unsupported_job_type', 'account_required', 'push_config_unavailable', 'invalid_push_job'].includes(code)) {
      await setJobStatus(database, jobId, 'failed', { ...result, error: code });
      message.ack();
      return;
    }
    await database.prepare(
      `UPDATE gym_durable_jobs SET status = 'queued', result_json = ?, updated_at = ?
        WHERE job_id = ? AND status = 'running'`,
    ).bind(JSON.stringify({ ...result, error: code }), nowIso(), jobId).run();
    message.retry({ delaySeconds: retryDelay(message.attempts) });
  }
};

export const processQueueBatch = async (
  batch: QueueBatchLike,
  env: JobWorkerEnvironment,
  send = sendWebPush,
): Promise<void> => {
  for (const message of batch.messages) await processJobMessage(message, batch.queue, env, send);
};

import { randomId } from '../auth';
import type { D1DatabaseLike } from '../../types';

export type DurableJobType = 'coach' | 'push' | 'rest_timer';

export interface JobQueueLike {
  send(message: { jobId: string }, options?: { delaySeconds: number }): Promise<unknown>;
}

export interface EnqueueJobInput {
  accountId: string;
  type: DurableJobType;
  idempotencyKey: string;
  payload: unknown;
  runAt?: string;
  coachAdmission?: {
    perProfileDaily: number;
    instanceDaily: number;
    dayStart: string;
  };
}

export type EnqueueJobResult =
  | { ok: true; jobId: string; status: string; replayed: boolean; dispatched: boolean }
  | { ok: false; error: string };

const MAX_JOB_BYTES = 65_536;
const MAX_QUEUE_DELAY_SECONDS = 86_400;

export const enqueueDurableJob = async (
  database: D1DatabaseLike,
  queue: JobQueueLike | undefined,
  input: EnqueueJobInput,
): Promise<EnqueueJobResult> => {
  if (!input.accountId || input.accountId.length > 128 || !/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey)) {
    return { ok: false, error: 'invalid_idempotency_key' };
  }
  if (!queue) return { ok: false, error: 'queue_unavailable' };
  let payloadJson: string;
  try { payloadJson = JSON.stringify(input.payload); }
  catch { return { ok: false, error: 'invalid_job_payload' }; }
  if (payloadJson === undefined) return { ok: false, error: 'invalid_job_payload' };
  if (new TextEncoder().encode(payloadJson).byteLength > MAX_JOB_BYTES) return { ok: false, error: 'job_payload_too_large' };
  if (input.type === 'coach') {
    const limits = input.coachAdmission;
    if (!limits || !Number.isInteger(limits.perProfileDaily) || limits.perProfileDaily < 0 || limits.perProfileDaily > 200
      || !Number.isInteger(limits.instanceDaily) || limits.instanceDaily < 0 || limits.instanceDaily > 5000
      || !Number.isFinite(Date.parse(limits.dayStart))) return { ok: false, error: 'invalid_job_admission' };
  } else if (input.coachAdmission) return { ok: false, error: 'invalid_job_admission' };
  const now = new Date().toISOString();
  const runAt = input.runAt ?? now;
  const delaySeconds = Math.ceil((Date.parse(runAt) - Date.now()) / 1000);
  if (!Number.isFinite(Date.parse(runAt)) || delaySeconds > MAX_QUEUE_DELAY_SECONDS) return { ok: false, error: 'invalid_run_at' };

  const jobId = randomId(18);
  const baseInsert = `INSERT OR IGNORE INTO gym_durable_jobs
    (job_id, account_id, owner_type, owner_key, job_type, idempotency_key, status, payload_json, run_at, created_at, updated_at)`;
  const inserted = input.type === 'coach'
    ? await database.prepare(`${baseInsert}
      SELECT ?, ?, 'account', ?, ?, ?, 'queued', ?, ?, ?, ?
      WHERE (? = 0 OR (SELECT COUNT(*) FROM gym_durable_jobs
        WHERE job_type = 'coach' AND account_id = ? AND created_at >= ?) < ?)
        AND (? = 0 OR (SELECT COUNT(*) FROM gym_durable_jobs
        WHERE job_type = 'coach' AND created_at >= ?) < ?)`)
      .bind(jobId, input.accountId, input.accountId, input.type, input.idempotencyKey, payloadJson, runAt, now, now,
        input.coachAdmission!.perProfileDaily, input.accountId, input.coachAdmission!.dayStart, input.coachAdmission!.perProfileDaily,
        input.coachAdmission!.instanceDaily, input.coachAdmission!.dayStart, input.coachAdmission!.instanceDaily).run()
    : await database.prepare(`${baseInsert}
      VALUES (?, ?, 'account', ?, ?, ?, 'queued', ?, ?, ?, ?)`).bind(
      jobId, input.accountId, input.accountId, input.type, input.idempotencyKey, payloadJson, runAt, now, now,
    ).run();
  const row = await database.prepare(
    `SELECT job_id AS jobId, status FROM gym_durable_jobs
      WHERE job_type = ? AND owner_key = ? AND idempotency_key = ?`,
  ).bind(input.type, input.accountId, input.idempotencyKey).first<{ jobId: string; status: string }>();
  if (!row) {
    if (input.type === 'coach' && (inserted.meta?.changes ?? 0) !== 1) {
      const limits = input.coachAdmission!;
      const [profileCount, instanceCount] = await Promise.all([
        limits.perProfileDaily > 0 ? database.prepare(`SELECT COUNT(*) AS used FROM gym_durable_jobs
          WHERE job_type = 'coach' AND account_id = ? AND created_at >= ?`).bind(input.accountId, limits.dayStart).first<{ used: number }>() : null,
        limits.instanceDaily > 0 ? database.prepare(`SELECT COUNT(*) AS used FROM gym_durable_jobs
          WHERE job_type = 'coach' AND created_at >= ?`).bind(limits.dayStart).first<{ used: number }>() : null,
      ]);
      if ((profileCount?.used ?? 0) >= limits.perProfileDaily && limits.perProfileDaily > 0
        || (instanceCount?.used ?? 0) >= limits.instanceDaily && limits.instanceDaily > 0) {
        return { ok: false, error: 'coach_cap' };
      }
    }
    return { ok: false, error: 'job_store_failed' };
  }

  let dispatched = false;
  if (row.status === 'queued') {
    try {
      if (delaySeconds > 0) await queue.send({ jobId: row.jobId }, { delaySeconds });
      else await queue.send({ jobId: row.jobId });
      dispatched = true;
    } catch { /* the persisted queued row is picked up by the queue dispatcher's scheduled sweep */ }
  }
  return { ok: true, jobId: row.jobId, status: row.status, replayed: (inserted.meta?.changes ?? 0) !== 1, dispatched };
};

export const cancelRestTimers = async (database: D1DatabaseLike, accountId: string, deviceId?: string): Promise<number> => {
  const result = await database.prepare(
    `UPDATE gym_durable_jobs SET status = 'cancelled', updated_at = ?
      WHERE account_id = ? AND job_type = 'rest_timer' AND status = 'queued'
        AND (? IS NULL OR json_extract(payload_json, '$.deviceId') = ?)`,
  ).bind(new Date().toISOString(), accountId, deviceId ?? null, deviceId ?? null).run();
  return result.meta?.changes ?? 0;
};

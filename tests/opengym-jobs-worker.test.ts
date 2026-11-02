import { describe, expect, it, vi } from 'vitest';
import { dispatchDueJobs, processJobMessage } from '../functions/lib/radian-api/jobs-worker';
import type { JobWorkerEnvironment, QueueMessageLike } from '../functions/lib/radian-api/jobs-worker';
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from '../functions/types';
import type { sendWebPush } from '../functions/lib/radian-api/webpush';

interface MemoryJob {
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

class JobDb implements D1DatabaseLike {
  job: MemoryJob | null = null;
  subscriptions: Array<{ subscriptionId: string; endpointHash: string; endpoint: string; publicKey: string; authSecret: string; deviceId: string | null }> = [];
  dueJobs: Array<{ jobId: string; updatedAt: string }> = [];

  prepare(sql: string): D1PreparedStatementLike {
    let args: unknown[] = [];
    return {
      bind(...values) { args = values; return this; },
      first: async <T>() => {
        if (sql.includes('FROM gym_durable_jobs')) {
          const row = this.job;
          return row && row.jobId === args[0] ? {
            jobId: row.jobId, accountId: row.accountId, jobType: row.jobType, status: row.status,
            payloadJson: row.payloadJson, runAt: row.runAt, updatedAt: row.updatedAt,
            attempt: row.attempt, resultJson: row.resultJson,
          } as T : null;
        }
        if (sql.includes('SELECT COALESCE')) return { language: 'es' } as T;
        return null;
      },
      all: async <T>() => {
        if (sql.includes('FROM gym_push_subscriptions')) {
          const accountId = args[0];
          const deviceId = args[1];
          const rows = this.subscriptions.filter(() => accountId === 'account-a')
            .filter(row => typeof deviceId !== 'string' || row.deviceId === deviceId || row.deviceId === null);
          return { results: rows as T[] };
        }
        if (sql.includes('FROM gym_durable_jobs')) return { results: this.dueJobs as T[] };
        return { results: [] as T[] };
      },
      run: async () => {
        const row = this.job;
        if (sql.includes("SET status = 'running'")) {
          if (!row || row.jobId !== args[1] || (row.status !== 'queued' && !(row.status === 'running' && row.updatedAt <= String(args[2]))) || row.runAt > String(args[3])) {
            return { success: true, meta: { changes: 0 } };
          }
          row.status = 'running'; row.attempt++; row.updatedAt = String(args[0]);
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes('SET result_json = ?')) {
          if (row && row.jobId === args[2] && row.status === 'running') {
            row.resultJson = String(args[0]); row.updatedAt = String(args[1]);
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
        if (sql.includes("SET status = 'queued'")) {
          if (row && row.jobId === args[2] && row.status === 'running') {
            row.status = 'queued'; row.resultJson = String(args[0]); row.updatedAt = String(args[1]);
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
        if (sql.includes("SET status = 'failed'")) {
          if (row && row.jobId === args[1] && (row.status === 'queued' || row.status === 'running')) {
            row.status = 'failed'; row.updatedAt = String(args[0]);
            return { success: true, meta: { changes: 1 } };
          }
        }
        if (sql.includes('SET status = ?')) {
          if (row && row.jobId === args[3]) {
            row.status = String(args[0]); row.resultJson = String(args[1]); row.updatedAt = String(args[2]);
            return { success: true, meta: { changes: 1 } };
          }
        }
        if (sql.startsWith('DELETE FROM gym_push_subscriptions')) {
          this.subscriptions = this.subscriptions.filter(item => item.subscriptionId !== args[1]);
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
    };
  }

  async batch(_statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]> { return []; }
}

const envFor = (db: JobDb): JobWorkerEnvironment => ({
  DB: db,
  VAPID_PUBLIC_KEY: 'B'.repeat(87),
  VAPID_PRIVATE_KEY: 'C'.repeat(43),
  VAPID_SUBJECT: 'mailto:push@example.test',
  JOB_DLQ_QUEUE: 'jobs-dlq',
});

const queuedJob = (): MemoryJob => ({
  jobId: 'job_12345678901234567890',
  accountId: 'account-a',
  jobType: 'push',
  status: 'queued',
  payloadJson: JSON.stringify({ kind: 'test' }),
  runAt: '2026-10-26T12:00:00.000Z',
  updatedAt: '2026-10-26T11:59:00.000Z',
  attempt: 0,
  resultJson: null,
});

const message = (attempts = 1): QueueMessageLike => ({
  body: { jobId: 'job_12345678901234567890' },
  attempts,
  ack: vi.fn(),
  retry: vi.fn(),
});

describe('consumidor durable openGym', () => {
  it('envía los pushes en el idioma de la cuenta, marca éxito y es idempotente por endpoint', async () => {
    const db = new JobDb();
    db.job = queuedJob();
    db.subscriptions = [{ subscriptionId: 'sub-a', endpointHash: 'hash-a', endpoint: 'https://push.example.test', publicKey: 'key', authSecret: 'auth', deviceId: 'device-a' }];
    const env = envFor(db);
    const send = vi.fn(async () => new Response(null, { status: 201 })) as unknown as typeof sendWebPush;
    const delivered = message();

    await processJobMessage(delivered, 'jobs', env, send, new Date('2026-10-26T12:01:00.000Z'));

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ endpoint: 'https://push.example.test' }), expect.objectContaining({ body: 'Las notificaciones están listas.', tag: 'push-test' }), expect.any(Object));
    expect(db.job).toMatchObject({ status: 'succeeded', attempt: 1 });
    expect(JSON.parse(db.job!.resultJson!).sent).toEqual(['hash-a']);
    expect(delivered.ack).toHaveBeenCalledOnce();
    expect(delivered.retry).not.toHaveBeenCalled();
  });

  it('elimina endpoints caducados sin reintentar el job', async () => {
    const db = new JobDb();
    db.job = queuedJob();
    db.subscriptions = [{ subscriptionId: 'sub-a', endpointHash: 'hash-a', endpoint: 'https://push.example.test', publicKey: 'key', authSecret: 'auth', deviceId: null }];
    const send = vi.fn(async () => new Response(null, { status: 410 })) as unknown as typeof sendWebPush;
    const delivered = message();

    await processJobMessage(delivered, 'jobs', envFor(db), send, new Date('2026-10-26T12:01:00.000Z'));

    expect(db.subscriptions).toEqual([]);
    expect(db.job?.status).toBe('succeeded');
    expect(delivered.ack).toHaveBeenCalledOnce();
    expect(delivered.retry).not.toHaveBeenCalled();
  });

  it('restaura el job a queued y solicita retry si el push service falla', async () => {
    const db = new JobDb();
    db.job = queuedJob();
    db.subscriptions = [{ subscriptionId: 'sub-a', endpointHash: 'hash-a', endpoint: 'https://push.example.test', publicKey: 'key', authSecret: 'auth', deviceId: null }];
    const send = vi.fn(async () => { throw new Error('network'); }) as unknown as typeof sendWebPush;
    const delivered = message(1);

    await processJobMessage(delivered, 'jobs', envFor(db), send, new Date('2026-10-26T12:01:00.000Z'));

    expect(db.job?.status).toBe('queued');
    expect(delivered.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(delivered.ack).not.toHaveBeenCalled();
  });

  it('marca fallos en la cola DLQ y reconoce duplicados ya procesados', async () => {
    const db = new JobDb();
    db.job = queuedJob();
    const delivered = message();

    await processJobMessage(delivered, 'jobs-dlq', envFor(db), vi.fn() as unknown as typeof sendWebPush, new Date('2026-10-26T12:01:00.000Z'));
    expect(db.job.status).toBe('failed');
    expect(delivered.ack).toHaveBeenCalledOnce();

    db.job.status = 'succeeded';
    const duplicate = message();
    await processJobMessage(duplicate, 'jobs', envFor(db), vi.fn() as unknown as typeof sendWebPush, new Date('2026-10-26T12:01:00.000Z'));
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(duplicate.retry).not.toHaveBeenCalled();
  });

  it('recupera jobs encolados si falla el primer envío al Queue', async () => {
    const db = new JobDb();
    db.dueJobs = [{ jobId: 'job_12345678901234567890', updatedAt: '2026-10-26T11:58:00.000Z' }];
    const queue = { send: vi.fn().mockResolvedValue(undefined) };

    const count = await dispatchDueJobs(db, queue, new Date('2026-10-26T12:00:00.000Z'));

    expect(count).toBe(1);
    expect(queue.send).toHaveBeenCalledWith({ jobId: 'job_12345678901234567890' });
  });
});

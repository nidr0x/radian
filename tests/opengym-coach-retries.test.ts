import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from '../functions/types';
import type { JobWorkerEnvironment, QueueMessageLike } from '../functions/lib/radian-api/jobs-worker';

const mocks = vi.hoisted(() => ({ runCoachJob: vi.fn(), readGymState: vi.fn() }));
vi.mock('../functions/lib/radian-api/coach.js', () => ({ runCoachJob: mocks.runCoachJob }));
vi.mock('../functions/lib/db/radian/state', () => ({ readGymState: mocks.readGymState }));

import { processJobMessage } from '../functions/lib/radian-api/jobs-worker';

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

class CoachJobDb implements D1DatabaseLike {
  job: MemoryJob = {
    jobId: 'coach-job-12345678', accountId: 'account-a', jobType: 'coach', status: 'queued',
    payloadJson: JSON.stringify({ kind: 'review', options: {} }), runAt: '2026-10-26T12:00:00.000Z',
    updatedAt: '2026-10-26T11:59:00.000Z', attempt: 0, resultJson: null,
  };
  proposals: string[] = [];

  prepare(sql: string): D1PreparedStatementLike {
    let args: unknown[] = [];
    return {
      bind(...values) { args = values; return this; },
      first: async <T>() => sql.includes('FROM gym_durable_jobs') ? this.job as T : null,
      all: async <T>() => ({ results: [] as T[] }),
      run: async () => {
        if (sql.includes("SET status = 'running'")) {
          this.job.status = 'running'; this.job.attempt++; this.job.updatedAt = String(args[0]);
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("SET status = 'queued'")) {
          this.job.status = 'queued'; this.job.resultJson = String(args[0]); this.job.updatedAt = String(args[1]);
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("SET status = 'succeeded'")) {
          if (this.job.status !== 'running') return { success: true, meta: { changes: 0 } };
          this.job.status = 'succeeded'; this.job.resultJson = String(args[0]); this.job.updatedAt = String(args[1]);
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes('INSERT INTO gym_coach_proposals')) {
          if (this.job.status !== 'running') return { success: true, meta: { changes: 0 } };
          this.proposals.push(String(args[1]));
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes('UPDATE gym_coach_proposals')) return { success: true, meta: { changes: 0 } };
        if (sql.includes('SET status = ?')) {
          if (this.job.status !== 'running') return { success: true, meta: { changes: 0 } };
          this.job.status = String(args[0]); this.job.resultJson = String(args[1]); this.job.updatedAt = String(args[2]);
          return { success: true, meta: { changes: 1 } };
        }
        return { success: true, meta: { changes: 0 } };
      },
    };
  }

  async batch(statements: D1PreparedStatementLike[]): Promise<D1ResultLike[]> {
    const results: D1ResultLike[] = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  }
}

const queueMessage = (): QueueMessageLike => ({
  body: { jobId: 'coach-job-12345678' }, attempts: 1, ack: vi.fn(), retry: vi.fn(),
});

const environment = (DB: D1DatabaseLike): JobWorkerEnvironment => ({ DB, JOB_DLQ_QUEUE: 'jobs-dlq' });

describe('reintentos de Coach en Queue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readGymState.mockResolvedValue({ state: { coach: { consent: { agreedAt: '2026-10-26T12:00:00.000Z' } } } });
  });

  it('mantiene queued y reintenta un fallo transitorio del proveedor', async () => {
    mocks.runCoachJob.mockResolvedValue({ ok: false, errorClass: 'provider', retryable: true });
    const db = new CoachJobDb();
    const message = queueMessage();

    await processJobMessage(message, 'jobs', environment(db), undefined, new Date('2026-10-26T12:01:00.000Z'));

    expect(db.job.status).toBe('queued');
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('marca un error definitivo como fallido y reconoce la entrega', async () => {
    mocks.runCoachJob.mockResolvedValue({ ok: false, errorClass: 'unusable', retryable: false });
    const db = new CoachJobDb();
    const message = queueMessage();

    await processJobMessage(message, 'jobs', environment(db), undefined, new Date('2026-10-26T12:01:00.000Z'));

    expect(db.job.status).toBe('failed');
    expect(JSON.parse(db.job.resultJson || '{}')).toMatchObject({ outcome: 'failed', errorClass: 'unusable' });
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('no recrea una propuesta si olvidar Coach cancela el trabajo durante la respuesta del proveedor', async () => {
    const db = new CoachJobDb();
    mocks.runCoachJob.mockImplementation(async () => {
      db.job.status = 'cancelled';
      return { ok: true, pending: { id: db.job.jobId, kind: 'review', createdAt: Date.now(), expiresAt: Date.now() + 1000 } };
    });
    const message = queueMessage();

    await processJobMessage(message, 'jobs', environment(db), undefined, new Date('2026-10-26T12:01:00.000Z'));

    expect(db.job.status).toBe('cancelled');
    expect(db.proposals).toEqual([]);
    expect(message.ack).toHaveBeenCalledOnce();
  });
});

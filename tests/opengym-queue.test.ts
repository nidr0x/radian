import { describe, expect, it, vi } from 'vitest';
import { enqueueDurableJob, cancelRestTimers } from '../functions/lib/radian-api/jobs';
import { replaceRestTimer } from '../functions/lib/radian-api/push';
import type { D1DatabaseLike, D1PreparedStatementLike, D1ResultLike } from '../functions/types';

interface JobRow { jobId: string; accountId: string; jobType: string; idempotencyKey: string; status: string; payloadJson: string; runAt: string }

class JobDb implements D1DatabaseLike {
  rows = new Map<string, JobRow>();
  prepare(sql: string): D1PreparedStatementLike {
    let args: unknown[] = [];
    return {
      bind(...values) { args = values; return this; },
      first: async <T>() => {
        if (sql.includes('FROM gym_durable_jobs')) {
          const row = [...this.rows.values()].find(value => value.jobType === args[0] && value.accountId === args[1] && value.idempotencyKey === args[2]);
          return (row ?? null) as T | null;
        }
        return null;
      },
      all: async <T>() => ({ results: [] as T[] }),
      run: async () => {
        if (sql.includes('INSERT OR IGNORE INTO gym_durable_jobs') || sql.includes('INSERT INTO gym_durable_jobs')) {
          const restTimer = sql.includes("'rest_timer'");
          const [jobId, accountId, ownerKey, jobType, idempotencyKey, payloadJson, runAt] = restTimer
            ? [args[0], args[1], args[2], 'rest_timer', args[3], args[4], args[5]] as string[]
            : args as string[];
          const key = `${jobType}:${ownerKey}:${idempotencyKey}`;
          if (!this.rows.has(key)) {
            this.rows.set(key, { jobId, accountId, jobType, idempotencyKey, status: 'queued', payloadJson, runAt });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        }
        if (sql.includes("SET status = 'cancelled'")) {
          let changes = 0;
          for (const row of this.rows.values()) {
            const wantedDevice = args[2];
            if (row.accountId !== args[1] || row.jobType !== 'rest_timer' || row.status !== 'queued') continue;
            if (typeof wantedDevice === 'string' && JSON.parse(row.payloadJson).deviceId !== wantedDevice) continue;
            row.status = 'cancelled'; changes++;
          }
          return { success: true, meta: { changes } };
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

describe('trabajos durables openGym', () => {
  it('guarda el job antes de encolarlo y reutiliza la clave idempotente', async () => {
    const db = new JobDb();
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const input = {
      accountId: 'account-1', type: 'coach' as const, idempotencyKey: 'request-1', payload: { kind: 'review' },
      coachAdmission: { perProfileDaily: 0, instanceDaily: 0, dayStart: '2026-10-28T00:00:00.000Z' },
    };

    const first = await enqueueDurableJob(db, queue, input);
    const replay = await enqueueDurableJob(db, queue, input);

    if (!first.ok) throw new Error(first.error);
    expect(first).toMatchObject({ replayed: false, status: 'queued' });
    expect(replay).toMatchObject({ ok: true, replayed: true, jobId: first.jobId });
    expect(db.rows.size).toBe(1);
    expect(queue.send).toHaveBeenCalledTimes(2);
    expect(JSON.parse([...db.rows.values()][0].payloadJson)).toEqual({ kind: 'review' });
  });

  it('no envía datos si la clave de idempotencia o el tamaño son inválidos', async () => {
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    const db = new JobDb();
    const invalid = await enqueueDurableJob(db, queue, { accountId: 'account-1', type: 'coach', idempotencyKey: '', payload: {} });
    const oversized = await enqueueDurableJob(db, queue, { accountId: 'account-1', type: 'coach', idempotencyKey: 'request-2', payload: { note: 'x'.repeat(70_000) } });

    expect(invalid).toEqual({ ok: false, error: 'invalid_idempotency_key' });
    expect(oversized).toEqual({ ok: false, error: 'job_payload_too_large' });
    expect(db.rows.size).toBe(0);
    expect(queue.send).not.toHaveBeenCalled();
  });

  it('cancela solo los temporizadores propios y deja intacta otra cuenta', async () => {
    const db = new JobDb();
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    await enqueueDurableJob(db, queue, { accountId: 'account-1', type: 'rest_timer', idempotencyKey: 'timer-a1', payload: { deviceId: 'device-a' } });
    await enqueueDurableJob(db, queue, { accountId: 'account-1', type: 'rest_timer', idempotencyKey: 'timer-b1', payload: { deviceId: 'device-b' } });
    await enqueueDurableJob(db, queue, { accountId: 'account-2', type: 'rest_timer', idempotencyKey: 'timer-c1', payload: { deviceId: 'device-a' } });

    await cancelRestTimers(db, 'account-1', 'device-a');

    expect([...db.rows.values()].map(row => row.status)).toEqual(['cancelled', 'queued', 'queued']);
  });

  it('reemplaza el temporizador de un dispositivo en una escritura durable y difiere su mensaje', async () => {
    const db = new JobDb();
    const queue = { send: vi.fn().mockResolvedValue(undefined) };
    await enqueueDurableJob(db, queue, { accountId: 'account-1', type: 'rest_timer', idempotencyKey: 'old-timer-1', payload: { deviceId: 'device-a' } });
    await enqueueDurableJob(db, queue, { accountId: 'account-1', type: 'rest_timer', idempotencyKey: 'other-timer-1', payload: { deviceId: 'device-b' } });

    const scheduled = await replaceRestTimer(db, queue, 'account-1', 90, 'device-a');

    expect(scheduled.ok).toBe(true);
    expect([...db.rows.values()].map(row => row.status)).toEqual(['cancelled', 'queued', 'queued']);
    expect(queue.send).toHaveBeenLastCalledWith({ jobId: scheduled.ok ? scheduled.jobId : '' }, { delaySeconds: 90 });
  });
});

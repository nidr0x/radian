import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoachApiContext } from '../functions/lib/radian-api/coach-routes';
import type { D1PreparedStatementLike, D1ResultLike } from '../functions/types';

const mocks = vi.hoisted(() => ({
  getAuthenticatedContext: vi.fn(),
  enforceAuthRateLimit: vi.fn(),
  readGymState: vi.fn(),
  enqueueDurableJob: vi.fn(),
}));

vi.mock('../functions/lib/auth', () => ({
  getAuthenticatedContext: mocks.getAuthenticatedContext,
  enforceAuthRateLimit: mocks.enforceAuthRateLimit,
  isRecord: (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value),
  json: (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json; charset=utf-8' },
  }),
  randomId: () => 'coach-idempotency-key-123456',
}));
vi.mock('../functions/lib/db/radian/state', () => ({ readGymState: mocks.readGymState }));
vi.mock('../functions/lib/radian-api/jobs', () => ({ enqueueDurableJob: mocks.enqueueDurableJob }));

import { onRequestPost as startCoachPlan } from '../functions/api/coach/plan';
import { onRequestGet as getCoachStatus } from '../functions/api/coach/status';

const database = {
  prepare: vi.fn<(sql: string) => D1PreparedStatementLike>((sql: string) => {
    let values: unknown[] = [];
    return {
      bind(...next: unknown[]) { values = next; return this; },
      first: async <T>() => (sql.includes('COUNT(*)') ? { used: 0 } : null) as T | null,
      all: async <T>() => ({ results: [] as T[] }),
      run: async () => ({ success: true, meta: { changes: 1 } }),
      get values() { return values; },
    };
  }),
  batch: vi.fn<(statements: D1PreparedStatementLike[]) => Promise<D1ResultLike[]>>(async () => []),
};

const context = (body: unknown): CoachApiContext => {
  const request = new Request('https://gym.example.test/api/coach/plan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { request, env: {
    DB: database as never,
    PUSH_QUEUE: { send: vi.fn(async () => undefined) },
    COACH_PROVIDER: 'openai',
    COACH_HANDLE_SECRET: 'test-only-handle-secret-value-1234567890',
    OPENAI_API_KEY: 'test-only-key',
  } };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getAuthenticatedContext.mockImplementation(async (ctx: CoachApiContext) => ({
    ...ctx, env: { ...ctx.env, DB: database }, user: { id: 'account-a', displayName: 'Ana', createdAt: '2026-10-26' },
  }));
  mocks.enforceAuthRateLimit.mockResolvedValue(undefined);
  mocks.readGymState.mockResolvedValue({ state: { coach: { consent: { agreedAt: '2026-10-26T12:00:00.000Z' } }, routines: [] } });
  mocks.enqueueDurableJob.mockResolvedValue({ ok: true, jobId: 'coach-job-12345678', status: 'queued', replayed: false, dispatched: true });
});

describe('rutas de trabajos Coach', () => {
  it('usa el bucket de limitación específico del sondeo de estado', async () => {
    const routeContext = context({});
    const response = await getCoachStatus({
      ...routeContext,
      request: new Request('https://gym.example.test/api/coach/status'),
    });

    expect(response.status).toBe(200);
    expect(mocks.enforceAuthRateLimit).toHaveBeenCalledWith(expect.any(Object), 'coach-status', 'account-a');
  });

  it('encola el plan bajo la cuenta autenticada con la opción de intake validada', async () => {
    const response = await startCoachPlan(context({ intake: { goal: 'strength' }, lang: 'es' }));

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ job: { id: 'coach-job-12345678', kind: 'create', state: 'queued' } });
    expect(mocks.enqueueDurableJob).toHaveBeenCalledWith(database, expect.any(Object), expect.objectContaining({
      accountId: 'account-a', type: 'coach', payload: { kind: 'create', lang: 'es', options: { intake: { goal: 'strength' } } },
    }));
  });

  it('rechaza solicitudes sin consentimiento y contenido de refinamiento no válido', async () => {
    mocks.readGymState.mockResolvedValueOnce({ state: { coach: {} } });
    const noConsent = await startCoachPlan(context({ intake: { goal: 'strength' } }));
    const invalid = await startCoachPlan(context({ refine: 'x'.repeat(1001) }));

    expect(noConsent.status).toBe(403);
    expect(invalid.status).toBe(400);
    expect(mocks.enqueueDurableJob).not.toHaveBeenCalled();
  });

  it('traduce la carrera de inserción a busy después del conflicto atómico', async () => {
    mocks.enqueueDurableJob.mockResolvedValue({ ok: false, error: 'job_store_failed' });
    let activeChecks = 0;
    database.prepare.mockImplementation((sql: string): D1PreparedStatementLike => {
      return {
        bind(..._next: unknown[]) { return this; },
        first: async <T>() => {
          let row: unknown = null;
          if (sql.includes('COUNT(*)')) row = { used: 0 };
          if (sql.includes('gym_durable_jobs') && sql.includes("status IN ('queued', 'running')")) {
            activeChecks++;
            row = activeChecks === 1 ? null : { jobId: 'existing-coach-job', createdAt: '2026-10-26T12:00:00.000Z', payloadJson: '{"kind":"review"}' };
          }
          return row as T | null;
        },
        all: async <T>() => ({ results: [] as T[] }),
        run: async () => ({ success: true, meta: { changes: 1 } }),
      };
    });

    const response = await startCoachPlan(context({ intake: { goal: 'strength' } }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'busy' });
  });
});

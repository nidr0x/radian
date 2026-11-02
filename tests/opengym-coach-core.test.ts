import { describe, expect, it } from 'vitest';
import { coachRuntime, isRetryableCoachFailure, runCoachJob } from '../functions/lib/radian-api/coach.js';

describe('adaptador del Coach para Workers', () => {
  it('declara solo proveedor y host y exige secreto de pseudónimo y credencial de proveedor', async () => {
    expect(await coachRuntime({ COACH_PROVIDER: 'openai' })).toMatchObject({
      provider: 'openai', host: 'api.openai.com', configured: false, reason: 'handle_secret_unavailable',
    });
    expect(await coachRuntime({ COACH_PROVIDER: 'openai', COACH_HANDLE_SECRET: 'h'.repeat(40), OPENAI_API_KEY: 'test-only' }))
      .toMatchObject({ configured: true, provider: 'openai', host: 'api.openai.com' });
    expect(await coachRuntime({ COACH_PROVIDER: 'unlisted', COACH_HANDLE_SECRET: 'h'.repeat(40) }))
      .toMatchObject({ configured: false, provider: null, host: null });
  });

  it('bloquea el envío cuando el estado de la cuenta no contiene consentimiento', async () => {
    const fetchImpl = async () => { throw new Error('no debe llamar al proveedor'); };
    const result = await runCoachJob({ coach: {} }, {
      jobId: 'coach-job-12345678', accountId: 'account-a', kind: 'review',
    }, { COACH_PROVIDER: 'openai', COACH_HANDLE_SECRET: 'h'.repeat(40), OPENAI_API_KEY: 'test-only' }, new Date(), fetchImpl);

    expect(result).toEqual({ ok: false, errorClass: 'consent' });
  });

  it('reintenta solo errores transitorios; no vuelve a llamar al proveedor para errores definitivos', () => {
    expect(isRetryableCoachFailure({ errorClass: 'provider', detail: '503 overloaded' })).toBe(true);
    expect(isRetryableCoachFailure({ errorClass: 'provider', detail: '429 rate limited' })).toBe(true);
    expect(isRetryableCoachFailure({ errorClass: 'provider', detail: '400 invalid model' })).toBe(false);
    expect(isRetryableCoachFailure({ errorClass: 'timeout' })).toBe(true);
    expect(isRetryableCoachFailure({ errorClass: 'auth', detail: '401' })).toBe(false);
    expect(isRetryableCoachFailure({ errorClass: 'unusable' })).toBe(false);
  });
});

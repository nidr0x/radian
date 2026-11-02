import { describe, expect, it } from 'vitest';
import { isRetryableCoachFailure } from '../functions/lib/radian-api/coach.js';

describe('clasificación de fallos Coach', () => {
  it('reintenta 429/5xx, timeout y red, pero deja definitivos los errores de petición/auth/validación', () => {
    expect(isRetryableCoachFailure({ errorClass: 'provider', detail: '503 overloaded' })).toBe(true);
    expect(isRetryableCoachFailure({ errorClass: 'provider', detail: '429 rate limited' })).toBe(true);
    expect(isRetryableCoachFailure({ errorClass: 'provider', detail: 'could not reach api.example' })).toBe(true);
    expect(isRetryableCoachFailure({ errorClass: 'provider', detail: '400 invalid model' })).toBe(false);
    expect(isRetryableCoachFailure({ errorClass: 'timeout' })).toBe(true);
    expect(isRetryableCoachFailure({ errorClass: 'auth', detail: '401' })).toBe(false);
    expect(isRetryableCoachFailure({ errorClass: 'unusable' })).toBe(false);
  });
});

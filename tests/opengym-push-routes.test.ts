import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncContext, D1DatabaseLike, D1PreparedStatementLike } from '../functions/types';

const mocks = vi.hoisted(() => ({ getAuthenticatedContext: vi.fn(), enforceAuthRateLimit: vi.fn() }));

vi.mock('../functions/lib/auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('../functions/lib/auth')>(),
  getAuthenticatedContext: mocks.getAuthenticatedContext,
  enforceAuthRateLimit: mocks.enforceAuthRateLimit,
}));

import { onRequestGet as publicKey } from '../functions/api/push/public-key';
import { onRequestPost as subscribe } from '../functions/api/push/subscribe';
import { onRequestGet as status } from '../functions/api/push/status';
import { onRequestPost as unsubscribe } from '../functions/api/push/unsubscribe';
import { onRequestPost as scheduleRest } from '../functions/api/push/rest-timer';
import { onRequestPost as cancelRest } from '../functions/api/push/rest-timer/cancel';
import { pushEndpointHash } from '../functions/lib/radian-api/push';

const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const vapidPublic = encode(Uint8Array.from([4, ...new Uint8Array(64)]));
const vapidPrivate = encode(new Uint8Array(32));
const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/device-token',
  keys: { p256dh: encode(Uint8Array.from([4, ...new Uint8Array(64)])), auth: encode(new Uint8Array(16)) },
};

const dbCallLog: Array<{ sql: string; args: unknown[] }> = [];
const db = {
  prepare(sql: string): D1PreparedStatementLike {
    let args: unknown[] = [];
    const record = () => dbCallLog.push({ sql, args: [...args] });
    return {
      bind(...values) { args = values; return this; },
      first: async <T>() => { record(); return null as T | null; },
      all: async <T>() => { record(); return { results: [] as T[] }; },
      run: async () => { record(); return { success: true, meta: { changes: 1 } }; },
    };
  },
  batch: vi.fn(async (_statements: D1PreparedStatementLike[]) => [
    { success: true, meta: { changes: 1 } }, { success: true, meta: { changes: 1 } },
  ]),
} as unknown as D1DatabaseLike & { batch: ReturnType<typeof vi.fn> };

const vapidEnv = {
  DB: db,
  PUSH_QUEUE: { send: vi.fn().mockResolvedValue(undefined) },
  VAPID_PUBLIC_KEY: vapidPublic,
  VAPID_PRIVATE_KEY: vapidPrivate,
  VAPID_SUBJECT: 'mailto:push@example.test',
};

const context = (url: string, method = 'GET', body?: unknown, env: Record<string, unknown> = vapidEnv): SyncContext => ({
  request: new Request(url, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  }),
  env: env as SyncContext['env'],
});

beforeEach(() => {
  vi.clearAllMocks();
  dbCallLog.length = 0;
  mocks.getAuthenticatedContext.mockImplementation(async (received: SyncContext) => ({
    ...received,
    user: { id: 'account-a', displayName: 'Ana', createdAt: '2026-10-26' },
  }));
  mocks.enforceAuthRateLimit.mockResolvedValue(undefined);
});

describe('rutas Web Push de openGym', () => {
  it('expone solo la clave pública y desactiva la ruta si faltan bindings o claves', async () => {
    const ready = await publicKey(context('https://app.example/api/push/public-key'));
    const unavailable = await publicKey(context('https://app.example/api/push/public-key', 'GET', undefined, { DB: db }));

    expect(await ready.json()).toEqual({ key: vapidPublic });
    expect(unavailable.status).toBe(503);
  });

  it('rechaza una suscripción que pertenece a otra cuenta si las claves no coinciden', async () => {
    db.batch.mockResolvedValueOnce([{ success: true, meta: { changes: 0 } }, { success: true, meta: { changes: 0 } }]);

    const response = await subscribe(context('https://app.example/api/push/subscribe', 'POST', { subscription }));

    expect(response.status).toBe(409);
    expect(db.batch).toHaveBeenCalledOnce();
    expect(dbCallLog).toEqual([]);
  });

  it('consulta y elimina endpoints solo dentro de la cuenta autenticada', async () => {
    const endpointHash = await pushEndpointHash(subscription.endpoint);
    const stored = await status(context(`https://app.example/api/push/status?endpoint=${encodeURIComponent(subscription.endpoint)}`));
    const removed = await unsubscribe(context('https://app.example/api/push/unsubscribe', 'POST', { endpoint: subscription.endpoint }, { DB: db }));

    expect(await stored.json()).toEqual({ subscribed: false });
    expect(await removed.json()).toEqual({ ok: true });
    expect(dbCallLog[0]).toMatchObject({ args: ['account-a', endpointHash] });
    expect(dbCallLog[1]).toMatchObject({ args: ['account-a', endpointHash] });
  });

  it('rechaza segundos inválidos antes de crear un job', async () => {
    const response = await scheduleRest(context('https://app.example/api/push/rest-timer', 'POST', { seconds: 'nope' }));

    expect(response.status).toBe(400);
    expect(db.batch).not.toHaveBeenCalled();
    expect(vapidEnv.PUSH_QUEUE.send).not.toHaveBeenCalled();
  });

  it('acepta un temporizador acotado y lo encola con delivery delay', async () => {
    const response = await scheduleRest(context('https://app.example/api/push/rest-timer', 'POST', { seconds: '4000', deviceId: 'device_123' }));

    expect(await response.json()).toEqual({ ok: true });
    expect(db.batch).toHaveBeenCalledOnce();
    expect(vapidEnv.PUSH_QUEUE.send).toHaveBeenCalledWith(expect.objectContaining({ jobId: expect.any(String) }), { delaySeconds: 3600 });
  });

  it('permite cancelar sin configuración push y acepta un cuerpo vacío', async () => {
    const response = await cancelRest(context('https://app.example/api/push/rest-timer/cancel', 'POST', undefined, { DB: db }));

    expect(await response.json()).toEqual({ ok: true });
    expect(dbCallLog[0]?.sql).toContain("SET status = 'cancelled'");
    expect(dbCallLog[0]?.args).toEqual([expect.any(String), 'account-a', null, null]);
  });
});

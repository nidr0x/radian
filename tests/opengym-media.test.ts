import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { detectMediaMime, mediaConfig, mediaLimitBytes, readBoundedBytes, sha256Hex, validateMediaPayload } from '../functions/lib/media/objects';
import { mp4, webm } from '../frontend/src/lib/media-samples.test-util.js';
import type { D1PreparedStatementLike, SyncContext } from '../functions/types';
import type { R2BucketLike } from '../functions/lib/media/objects';
import { writeGymState } from '../functions/lib/db/radian/state';
import { openTestDatabase } from './support/opengym-d1';

const mocks = vi.hoisted(() => ({ getAuthenticatedContext: vi.fn(), enforceAuthRateLimit: vi.fn() }));
vi.mock('../functions/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../functions/lib/auth')>();
  return { ...actual, getAuthenticatedContext: mocks.getAuthenticatedContext, enforceAuthRateLimit: mocks.enforceAuthRateLimit };
});

import { onRequestPut } from '../functions/api/media/[hash]';
import { onRequestPost as sweepMedia } from '../functions/api/media/sweep';

const openDatabases: Array<ReturnType<typeof openTestDatabase>> = [];
const makeDatabase = () => {
  const opened = openTestDatabase();
  openDatabases.push(opened);
  return opened;
};
const objectBytes = new Map<string, Uint8Array>();
const requestBody = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};
const makeBucket = (put?: R2BucketLike['put']): R2BucketLike => ({
  get: async () => null,
  head: async () => null,
  put: put ?? (async (key, value) => { objectBytes.set(key, Uint8Array.from(value)); }),
  delete: async (key) => { objectBytes.delete(key); },
});
beforeEach(() => {
  vi.clearAllMocks();
  objectBytes.clear();
  mocks.enforceAuthRateLimit.mockResolvedValue(undefined);
  mocks.getAuthenticatedContext.mockImplementation(async (context: SyncContext) => ({
    ...context, user: { id: 'account-a', displayName: 'Ana', createdAt: '2026-10-26' }, sessionId: 'session-a',
  }));
});
afterEach(() => { while (openDatabases.length) openDatabases.pop()?.database.close(); });

describe('almacén de medios openGym', () => {
  it('detecta el formato por la firma, no por el MIME declarado', () => {
    expect(detectMediaMime(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]))).toBe('image/jpeg');
    expect(detectMediaMime(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(detectMediaMime(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(detectMediaMime(new TextEncoder().encode('RIFF0000WEBP'))).toBe('image/webp');
    expect(detectMediaMime(new TextEncoder().encode('0000ftypqt  '))).toBe('video/quicktime');
    expect(detectMediaMime(new TextEncoder().encode('0000ftypisom'))).toBe('video/mp4');
    expect(detectMediaMime(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]))).toBe('video/webm');
  });

  it('aplica límites por tipo y valores configurables con defaults acotados', () => {
    expect(mediaConfig({})).toEqual({ imageMB: 2, gifMB: 8, videoMB: 40, videoSec: 60, quotaMB: 200 });
    const limits = mediaConfig({ MEDIA_IMAGE_MB: '1.5', MEDIA_GIF_MB: '4', MEDIA_VIDEO_MB: '12', MEDIA_QUOTA_MB: '0' });
    expect(mediaLimitBytes('image/png', limits)).toBe(1.5 * 1024 * 1024);
    expect(mediaLimitBytes('image/gif', limits)).toBe(4 * 1024 * 1024);
    expect(mediaLimitBytes('video/mp4', limits)).toBe(12 * 1024 * 1024);
    expect(limits.quotaMB).toBe(0);
  });

  it('rechaza el cuerpo al superar el límite y acepta el tamaño máximo exacto', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await readBoundedBytes(new Request('https://example.test', { method: 'PUT', body: bytes }), 2)).toBeNull();
    expect(await readBoundedBytes(new Request('https://example.test', { method: 'PUT', body: bytes }), 3)).toEqual(bytes);
  });

  it('calcula SHA-256 hexadecimal estable', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('acepta los siete formatos web y rechaza MIME falsificado o vídeo inválido', () => {
    const limits = mediaConfig({});
    const quicktime = mp4({ brand: 'qt  ', seconds: 30 }).file;
    const mp4File = mp4({ brand: 'isom', seconds: 30 }).file;
    const webmFile = webm({ durationMs: 30_000 });

    expect(validateMediaPayload(quicktime, 'video/quicktime', limits)).toBeNull();
    expect(validateMediaPayload(mp4File, 'video/mp4', limits)).toBeNull();
    expect(validateMediaPayload(webmFile, 'video/webm', limits)).toBeNull();
    expect(validateMediaPayload(mp4File, 'video/webm', limits)).toBe('media_type_mismatch');
    expect(validateMediaPayload(new TextEncoder().encode('0000ftypisom'), 'video/mp4', limits)).toBe('invalid_media');
  });

  it('rechaza clips que superan la duración máxima del servidor', () => {
    const limits = mediaConfig({ MEDIA_VIDEO_MB: '40' });
    expect(validateMediaPayload(mp4({ seconds: 62 }).file, 'video/mp4', limits)).toBe('media_too_long');
    expect(validateMediaPayload(webm({ durationMs: 62_000 }), 'video/webm', limits)).toBe('media_too_long');
  });

  it('aplica la cuota agregada aunque dos cuentas suban en paralelo y limpia el objeto rechazado', async () => {
    const { database, d1 } = makeDatabase();
    let putCount = 0;
    let releasePuts!: () => void;
    const bothPuts = new Promise<void>((resolve) => { releasePuts = resolve; });
    const bucket = makeBucket(async (key, value) => {
      objectBytes.set(key, Uint8Array.from(value));
      if (++putCount === 2) releasePuts();
      await bothPuts;
    });
    const firstBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x01]);
    const secondBytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x02]);
    const firstHash = await sha256Hex(firstBytes);
    const secondHash = await sha256Hex(secondBytes);
    const request = (bytes: Uint8Array, hash: string) => ({
      request: new Request(`https://opengym.local/api/media/${hash}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: requestBody(bytes) }),
      env: { DB: d1, MEDIA_BUCKET: bucket, MEDIA_QUOTA_MB: '0.000006' },
    });

    const responses = await Promise.all([onRequestPut(request(firstBytes, firstHash)), onRequestPut(request(secondBytes, secondHash))]);

    expect(responses.map(response => response.status).sort()).toEqual([200, 413]);
    expect(database.prepare('SELECT SUM(byte_size) AS bytes FROM gym_media_objects WHERE account_id = ?').get('account-a'))
      .toEqual({ bytes: 4 });
    expect(objectBytes.size).toBe(1);
  });

  it('limpia el objeto de R2 si falla la escritura de metadatos D1', async () => {
    const { d1 } = makeDatabase();
    const bucket = makeBucket();
    const prepare = d1.prepare.bind(d1);
    const failingStatement = {
      bind() { return this; },
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => { throw new Error('write_failed'); },
    } as unknown as D1PreparedStatementLike;
    const spy = vi.spyOn(d1, 'prepare').mockImplementation((sql: string) =>
      sql.includes('INSERT INTO gym_media_objects') ? failingStatement : prepare(sql));
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0x03]);
    const hash = await sha256Hex(bytes);
    try {
      const response = await onRequestPut({
        request: new Request(`https://opengym.local/api/media/${hash}`, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: requestBody(bytes) }),
        env: { DB: d1, MEDIA_BUCKET: bucket, MEDIA_QUOTA_MB: '0' },
      });

      expect(response.status).toBe(503);
      expect(objectBytes.size).toBe(0);
    } finally { spy.mockRestore(); }
  });

  it('encola la limpieza R2 después de quitar una referencia huérfana', async () => {
    const { database, d1 } = makeDatabase();
    const state = await writeGymState(d1, 'account-a', { state: { workouts: [] }, baseRev: 0 });
    expect(state.ok).toBe(true);
    database.prepare(
      'INSERT INTO gym_media_objects (account_id, media_id, object_key, sha256, mime_type, byte_size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('account-a', 'a'.repeat(64), 'orphan/photo', 'a'.repeat(64), 'image/jpeg', 4, '2020-01-01T00:00:00.000Z');
    const bucket = { ...makeBucket(), delete: vi.fn(async () => { throw new Error('temporary R2 failure'); }) };

    const response = await sweepMedia({
      request: new Request('https://opengym.local/api/media/sweep', { method: 'POST' }),
      env: { DB: d1, MEDIA_BUCKET: bucket },
    });

    expect(response.status).toBe(200);
    expect(database.prepare('SELECT object_key FROM gym_media_cleanup_objects').all()).toEqual([{ object_key: 'orphan/photo' }]);
    expect(database.prepare('SELECT object_key FROM gym_media_objects WHERE media_id = ?').all('a'.repeat(64))).toEqual([]);
    expect(bucket.delete).not.toHaveBeenCalled();
  });
});

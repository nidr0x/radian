import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PairContext, PairR2Bucket } from '../functions/lib/pairing/v2';
import { onRequestPut as putPair } from '../functions/api/pair/v2';
import { onRequestPut as putPairMedia } from '../functions/api/pair/v2/media';
import { revokePair, sha256Hex } from '../functions/lib/pairing/v2';
import type { D1DatabaseLike } from '../functions/types';
import radianJobs from '../workers/radian-jobs';
import { openTestDatabase } from './support/opengym-d1';

const databases: Array<ReturnType<typeof openTestDatabase>> = [];
const makeDatabase = () => {
  const value = openTestDatabase();
  databases.push(value);
  return value;
};

afterEach(() => { while (databases.length) databases.pop()?.database.close(); });

describe('pairing v2', () => {
  it('comparte el límite de escrituras por IP entre snapshots y media antes de leer el cuerpo', async () => {
    const { database, d1 } = makeDatabase();
    const authKey = 'B'.repeat(43);
    const verifier = await sha256Hex(authKey);
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const pairIds = Array.from({ length: 2 }, (_, index) => `${index.toString(36).padStart(8, '0')}${'A'.repeat(35)}`);
    const bodyReads = { value: 0 };
    const bytes = new Uint8Array(29).fill(7);
    const put = vi.fn(async () => undefined);
    const bucket: PairR2Bucket = { put, get: async () => null, delete: async () => undefined };

    for (const pairId of pairIds) {
      database.prepare(
        `INSERT INTO gym_pair_channels (pair_id, authorization_verifier, revision, ciphertext, ciphertext_sha256,
          ciphertext_bytes, last_active_at, expires_at) VALUES (?, ?, 1, 'ciphertext', ?, 29, ?, ?)`,
      ).run(pairId, verifier, '0'.repeat(64), new Date().toISOString(), expiresAt);
    }

    const request = (url: string, headers: Record<string, string>): Request => ({
      url,
      headers: new Headers({ ...headers, 'CF-Connecting-IP': '192.0.2.10' }),
      body: {
        getReader: () => {
          bodyReads.value += 1;
          let read = false;
          return {
            read: async () => {
              if (read) return { done: true as const };
              read = true;
              return { done: false as const, value: bytes };
            },
            cancel: async () => undefined,
            releaseLock: () => undefined,
          };
        },
      },
    } as unknown as Request);
    const context = (requestValue: Request): PairContext => ({ request: requestValue, env: { DB: d1, PAIR_OBJECTS: bucket } });

    for (let index = 0; index < 51; index += 1) {
      const response = await putPairMedia(context(request(
        `https://gym.example.test/api/pair/v2/media?id=${pairIds[0]}&objectId=${String(index).padStart(16, '0')}`,
        { 'Content-Type': 'application/octet-stream', Authorization: `Pair ${authKey}` },
      )));
      expect(response.status).toBe(200);
    }

    for (let index = 0; index < 4; index += 1) {
      const response = await putPair(context(request('https://gym.example.test/api/pair/v2', {
        'Content-Type': 'application/octet-stream', 'X-Pair-Id': pairIds[0]!,
        Authorization: `Pair ${authKey}`, 'If-Match': `"${index + 1}"`,
      })));
      expect(response.status).toBe(200);
    }

    const blockedPairId = pairIds[1]!;
    const blocked = await putPairMedia(context(request(
      `https://gym.example.test/api/pair/v2/media?id=${blockedPairId}&objectId=${'9'.repeat(16)}`,
      { 'Content-Type': 'application/octet-stream', Authorization: `Pair ${authKey}` },
    )));

    expect(blocked.status).toBe(429);
    expect(bodyReads.value).toBe(55);
    expect(put).toHaveBeenCalledTimes(51);
  });

  it('drena más de 20 objetos en ciclos programados, reintenta fallos y borra metadata al revocar', async () => {
    const { database, d1 } = makeDatabase();
    const pairId = 'P'.repeat(43);
    const authKey = 'C'.repeat(43);
    const now = new Date().toISOString();
    const verifier = await sha256Hex(authKey);
    const snapshotKey = `${pairId}/snapshot`;
    database.prepare(
      `INSERT INTO gym_pair_channels (pair_id, authorization_verifier, revision, ciphertext, r2_object_key,
        ciphertext_sha256, ciphertext_bytes, last_active_at, expires_at)
       VALUES (?, ?, 1, NULL, ?, ?, 29, ?, ?)`,
    ).run(pairId, verifier, snapshotKey, '0'.repeat(64), now, new Date(Date.now() + 86400000).toISOString());

    const keys = [snapshotKey, ...Array.from({ length: 45 }, (_, index) => `${pairId}/media/${String(index).padStart(16, '0')}`)];
    keys.slice(1).forEach((key, index) => database.prepare(
      `INSERT INTO gym_pair_media_objects (pair_id, object_id, object_key, ciphertext_sha256, ciphertext_bytes, created_revision, created_at)
       VALUES (?, ?, ?, ?, 29, 1, ?)`,
    ).run(pairId, `media_${String(index).padStart(12, '0')}`, key, '0'.repeat(64), now));

    const deleted = new Set<string>();
    let failOnce = true;
    const bucket: PairR2Bucket = {
      put: async () => undefined,
      get: async () => null,
      delete: async (key) => {
        if (typeof key !== 'string') throw new Error('unexpected multi-key delete');
        if (failOnce) { failOnce = false; throw new Error('temporary R2 failure'); }
        deleted.add(key);
      },
    };
    let releaseBatches!: () => void;
    const bothBatches = new Promise<void>((resolve) => { releaseBatches = resolve; });
    let batchCount = 0;
    const concurrentDb: D1DatabaseLike = {
      prepare: (sql) => d1.prepare(sql),
      batch: async (statements) => {
        batchCount += 1;
        if (batchCount === 2) releaseBatches();
        await bothBatches;
        return d1.batch(statements);
      },
    };
    const context: PairContext = { request: new Request('https://gym.example.test/api/pair/v2'), env: { DB: concurrentDb, PAIR_OBJECTS: bucket } };

    const revocations = await Promise.all([
      revokePair(context, pairId, authKey),
      revokePair(context, pairId, authKey),
    ]);

    expect(revocations.map((response) => response.status).sort()).toEqual([200, 410]);
    expect(database.prepare('SELECT COUNT(*) AS count FROM gym_pair_media_objects WHERE pair_id = ?').get(pairId)).toEqual({ count: 0 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM gym_pair_cleanup_objects WHERE pair_id = ?').get(pairId)).toEqual({ count: 27 });
    expect(database.prepare('SELECT attempts, last_error AS lastError FROM gym_pair_cleanup_objects WHERE attempts > 0').get()).toEqual({ attempts: 1, lastError: 'r2_delete_failed' });

    const runScheduled = async () => {
      const pending: Promise<unknown>[] = [];
      radianJobs.scheduled(
        { cron: '* * * * *' },
        { DB: d1, PAIR_OBJECTS: bucket } as never,
        { waitUntil: (promise) => pending.push(promise) },
      );
      await Promise.all(pending);
    };
    await runScheduled();
    expect(database.prepare('SELECT COUNT(*) AS count FROM gym_pair_cleanup_objects WHERE pair_id = ?').get(pairId)).toEqual({ count: 7 });
    await runScheduled();

    expect(deleted).toEqual(new Set(keys));
    expect(database.prepare('SELECT COUNT(*) AS count FROM gym_pair_cleanup_objects WHERE pair_id = ?').get(pairId)).toEqual({ count: 0 });
    expect((await revokePair(context, pairId, authKey)).status).toBe(410);
    expect(database.prepare('SELECT COUNT(*) AS count FROM gym_pair_cleanup_objects WHERE pair_id = ?').get(pairId)).toEqual({ count: 0 });
  });
});

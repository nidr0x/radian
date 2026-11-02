import { enforceAuthRateLimit, json } from '../auth';
import { MEDIA_MB, mediaConfig, type MediaEnvironment } from '../media/objects';
import type { D1DatabaseLike, D1PreparedStatementLike, SyncContext } from '../../types';

export const PAIR_INLINE_LIMIT = 42 * 1024;
export const PAIR_CIPHERTEXT_LIMIT = 8 * 1024 * 1024;
// The client encrypts media in small chunks; retain this hard per-object cap for Worker buffering.
export const PAIR_MEDIA_CIPHERTEXT_LIMIT = 8 * 1024 * 1024;
const PAIR_IDLE_DAYS = 90;
const TOMBSTONE_DAYS = 365;

export interface PairR2Bucket {
  put(key: string, value: ArrayBuffer | ArrayBufferView | ReadableStream, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
  get(key: string): Promise<PairR2Object | null>;
  delete(key: string | string[]): Promise<void>;
}

interface PairR2Object {
  body: ReadableStream;
  writeHttpMetadata(headers: Headers): void;
}

export interface PairContext extends SyncContext {
  env: SyncContext['env'] & MediaEnvironment & { PAIR_OBJECTS?: PairR2Bucket };
}

export interface PairRow {
  pairId: string;
  authorizationVerifier: string;
  revision: number;
  ciphertext: string | null;
  r2ObjectKey: string | null;
  ciphertextSha256: string | null;
  ciphertextBytes: number;
  lastActiveAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export const isPairId = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(value);
export const isPairAuthKey = (value: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(value);

export const base64UrlEncode = (value: Uint8Array): string => {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

export const readBoundedBytes = async (request: Request, maxBytes: number): Promise<Uint8Array | undefined> => {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return undefined;
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
};

export const sha256Hex = async (value: Uint8Array | string): Promise<string> => {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', digestInput.buffer));
  return Array.from(digest, (part) => part.toString(16).padStart(2, '0')).join('');
};

const constantTimeHexEqual = (left: string, right: string): boolean => {
  if (left.length !== 64 || right.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < 64; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

export const pairAuthKey = (request: Request): string | undefined => {
  const value = request.headers.get('Authorization') ?? '';
  const match = /^Pair ([A-Za-z0-9_-]{43})$/.exec(value);
  return match?.[1];
};

export const pairRow = (database: D1DatabaseLike, pairId: string) => database.prepare(
  `SELECT pair_id AS pairId, authorization_verifier AS authorizationVerifier, revision, ciphertext,
          r2_object_key AS r2ObjectKey, ciphertext_sha256 AS ciphertextSha256,
          ciphertext_bytes AS ciphertextBytes, last_active_at AS lastActiveAt,
          expires_at AS expiresAt, revoked_at AS revokedAt
     FROM gym_pair_channels WHERE pair_id = ?`,
).bind(pairId).first<PairRow>();

export const pairRateLimit = async (context: PairContext, pairId: string): Promise<Response | undefined> =>
  enforceAuthRateLimit(context, 'sync-pair-v2', pairId.slice(0, 8));

export const authorizePair = async (
  database: D1DatabaseLike,
  pairId: string,
  authKey: string | undefined,
): Promise<{ row?: PairRow; response?: Response }> => {
  const row = await pairRow(database, pairId);
  if (!row) return { response: json({ error: 'pair_not_found' }, 404) };
  if (!authKey || !isPairAuthKey(authKey)) return { response: json({ error: 'pair_forbidden' }, 403) };
  const verifier = await sha256Hex(authKey);
  if (!constantTimeHexEqual(verifier, row.authorizationVerifier)) return { response: json({ error: 'pair_forbidden' }, 403) };
  if (row.revokedAt) return { response: json({ error: 'pair_revoked' }, 410) };
  if (Date.parse(row.expiresAt) <= Date.now()) return { response: json({ error: 'pair_expired' }, 410) };
  return { row };
};

const queueCleanup = (database: D1DatabaseLike, pairId: string, objectKey: string, queuedAt: string) => database.prepare(
  'INSERT OR IGNORE INTO gym_pair_cleanup_objects (object_key, pair_id, queued_at) VALUES (?, ?, ?)',
).bind(objectKey, pairId, queuedAt);

const queueCleanupAfterSnapshotSwap = (
  database: D1DatabaseLike,
  pairId: string,
  oldObjectKey: string,
  queuedAt: string,
  revision: number,
  hash: string,
): D1PreparedStatementLike => database.prepare(
  `INSERT OR IGNORE INTO gym_pair_cleanup_objects (object_key, pair_id, queued_at)
   SELECT ?, ?, ? WHERE EXISTS (
     SELECT 1 FROM gym_pair_channels WHERE pair_id = ? AND revision = ? AND ciphertext_sha256 = ?
   )`,
).bind(oldObjectKey, pairId, queuedAt, pairId, revision, hash);

export const flushPairCleanup = async (database: D1DatabaseLike, bucket: PairR2Bucket | undefined, pairId?: string): Promise<void> => {
  if (!bucket) return;
  const rows = await database.prepare(
    `SELECT object_key AS objectKey FROM gym_pair_cleanup_objects
      ${pairId ? 'WHERE pair_id = ?' : ''} ORDER BY queued_at LIMIT 20`,
  ).bind(...(pairId ? [pairId] : [])).all<{ objectKey: string }>();
  for (const row of rows.results) {
    try {
      await bucket.delete(row.objectKey);
      await database.prepare('DELETE FROM gym_pair_cleanup_objects WHERE object_key = ?').bind(row.objectKey).run();
    } catch {
      await database.prepare('UPDATE gym_pair_cleanup_objects SET attempts = attempts + 1, last_error = ? WHERE object_key = ?')
        .bind('r2_delete_failed', row.objectKey).run();
    }
  }
};

export const writePairSnapshot = async (
  context: PairContext,
  pairId: string,
  authKey: string,
  baseRevision: number,
  ciphertextBytes: Uint8Array,
): Promise<Response> => {
  const database = context.env.DB;
  if (!database) return json({ error: 'database_unavailable' }, 503);
  if (!isPairId(pairId) || !isPairAuthKey(authKey)) return json({ error: 'invalid_pair_credentials' }, 400);
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) return json({ error: 'invalid_revision' }, 400);
  if (ciphertextBytes.byteLength < 29) return json({ error: 'invalid_ciphertext' }, 400);
  if (ciphertextBytes.byteLength > PAIR_CIPHERTEXT_LIMIT) return json({ error: 'pair_payload_too_large' }, 413);

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PAIR_IDLE_DAYS * 86400000).toISOString();
  const hash = await sha256Hex(ciphertextBytes);
  const verifier = await sha256Hex(authKey);
  const encoded = base64UrlEncode(ciphertextBytes);
  const useR2 = ciphertextBytes.byteLength > PAIR_INLINE_LIMIT;
  if (useR2 && !context.env.PAIR_OBJECTS) return json({ error: 'pair_storage_unavailable' }, 503);
  const objectKey = useR2 ? `${pairId}/${crypto.randomUUID()}` : null;
  if (objectKey && context.env.PAIR_OBJECTS) {
    await context.env.PAIR_OBJECTS.put(objectKey, ciphertextBytes, {
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { ciphertextSha256: hash },
    });
  }

  const current = await pairRow(database, pairId);
  let resultChanges = 0;
  let revision = baseRevision + 1;
  if (!current) {
    const tombstone = await database.prepare('SELECT pair_id FROM gym_pair_tombstones WHERE pair_id = ?').bind(pairId).first<{ pairId: string }>();
    if (tombstone) {
      if (objectKey) await context.env.PAIR_OBJECTS?.delete(objectKey);
      return json({ error: 'pair_revoked' }, 410);
    }
    if (baseRevision !== 0) {
      if (objectKey) await context.env.PAIR_OBJECTS?.delete(objectKey);
      return json({ error: 'pair_conflict', revision: 0 }, 409);
    }
    const inserted = await database.prepare(
      `INSERT INTO gym_pair_channels (pair_id, authorization_verifier, revision, ciphertext, r2_object_key,
        ciphertext_sha256, ciphertext_bytes, last_active_at, expires_at)
       SELECT ?, ?, 1, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM gym_pair_tombstones WHERE pair_id = ?)
       ON CONFLICT(pair_id) DO NOTHING`,
    ).bind(pairId, verifier, useR2 ? null : encoded, objectKey, hash, ciphertextBytes.byteLength, now, expiresAt, pairId).run();
    resultChanges = inserted.meta?.changes ?? 0;
    revision = 1;
  } else {
    if (current.revokedAt || Date.parse(current.expiresAt) <= Date.now()) {
      if (objectKey) await context.env.PAIR_OBJECTS?.delete(objectKey);
      return json({ error: current.revokedAt ? 'pair_revoked' : 'pair_expired' }, 410);
    }
    if (!constantTimeHexEqual(verifier, current.authorizationVerifier)) {
      if (objectKey) await context.env.PAIR_OBJECTS?.delete(objectKey);
      return json({ error: 'pair_forbidden' }, 403);
    }
    if (current.revision !== baseRevision) {
      if (objectKey) await context.env.PAIR_OBJECTS?.delete(objectKey);
      return json({ error: 'pair_conflict', revision: current.revision }, 409);
    }
    revision = current.revision + 1;
    const result = await database.batch([
      database.prepare(
        `UPDATE gym_pair_channels SET revision = revision + 1, ciphertext = ?, r2_object_key = ?,
          ciphertext_sha256 = ?, ciphertext_bytes = ?, last_active_at = ?, expires_at = ?
         WHERE pair_id = ? AND authorization_verifier = ? AND revision = ? AND revoked_at IS NULL AND expires_at > ?`,
      ).bind(useR2 ? null : encoded, objectKey, hash, ciphertextBytes.byteLength, now, expiresAt, pairId, verifier, baseRevision, now),
      ...(current.r2ObjectKey && current.r2ObjectKey !== objectKey
        ? [queueCleanupAfterSnapshotSwap(database, pairId, current.r2ObjectKey, now, revision, hash)]
        : []),
    ]);
    resultChanges = result[0]?.meta?.changes ?? 0;
  }

  if (resultChanges !== 1) {
    if (objectKey) await context.env.PAIR_OBJECTS?.delete(objectKey);
    const latest = await pairRow(database, pairId);
    return json({ error: 'pair_conflict', revision: latest?.revision ?? 0 }, 409);
  }
  await flushPairCleanup(database, context.env.PAIR_OBJECTS, pairId);
  return json({ revision, expiresAt });
};

export const readPairSnapshot = async (context: PairContext, row: PairRow): Promise<Response> => {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'ETag': `"${row.revision}"`,
    'X-Pair-SHA256': row.ciphertextSha256 ?? '',
    'X-Pair-Revision': String(row.revision),
    'Content-Type': 'application/octet-stream',
  });
  if (row.ciphertext !== null) {
    const padded = row.ciphertext.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - row.ciphertext.length % 4) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new Response(bytes, { headers });
  }
  if (!row.r2ObjectKey || !context.env.PAIR_OBJECTS) return json({ error: 'pair_snapshot_missing' }, 503);
  const object = await context.env.PAIR_OBJECTS.get(row.r2ObjectKey);
  if (!object) return json({ error: 'pair_snapshot_missing' }, 503);
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Pair-SHA256', row.ciphertextSha256 ?? '');
  headers.set('X-Pair-Revision', String(row.revision));
  return new Response(object.body, { headers });
};

export const revokePair = async (context: PairContext, pairId: string, authKey: string): Promise<Response> => {
  const database = context.env.DB;
  if (!database) return json({ error: 'database_unavailable' }, 503);
  if (!isPairId(pairId) || !isPairAuthKey(authKey)) return json({ error: 'invalid_pair_credentials' }, 400);
  const current = await pairRow(database, pairId);
  if (!current) return json({ revoked: true });
  if (!constantTimeHexEqual(await sha256Hex(authKey), current.authorizationVerifier)) return json({ error: 'pair_forbidden' }, 403);
  const now = new Date().toISOString();
  const retainUntil = new Date(Date.now() + TOMBSTONE_DAYS * 86400000).toISOString();
  const media = await database.prepare('SELECT object_key AS objectKey FROM gym_pair_media_objects WHERE pair_id = ?').bind(pairId).all<{ objectKey: string }>();
  const keys = [...new Set([current.r2ObjectKey, ...media.results.map((row) => row.objectKey)].filter((key): key is string => !!key))];
  const statements = [
    database.prepare('UPDATE gym_pair_channels SET revoked_at = ?, ciphertext = NULL, r2_object_key = NULL WHERE pair_id = ? AND authorization_verifier = ? AND revoked_at IS NULL').bind(now, pairId, current.authorizationVerifier),
    database.prepare('INSERT INTO gym_pair_tombstones (pair_id, revoked_at, retain_until) VALUES (?, ?, ?) ON CONFLICT(pair_id) DO UPDATE SET revoked_at = excluded.revoked_at, retain_until = excluded.retain_until').bind(pairId, now, retainUntil),
    ...keys.map((key) => queueCleanup(database, pairId, key, now)),
  ];
  const results = await database.batch(statements);
  if ((results[0]?.meta?.changes ?? 0) !== 1) return json({ error: 'pair_revoked' }, 410);
  await flushPairCleanup(database, context.env.PAIR_OBJECTS, pairId);
  return json({ revoked: true, retainUntil });
};

export const storePairMedia = async (context: PairContext, row: PairRow, objectId: string, bytes: Uint8Array): Promise<Response> => {
  const database = context.env.DB;
  const bucket = context.env.PAIR_OBJECTS;
  if (!database || !bucket) return json({ error: 'pair_storage_unavailable' }, 503);
  if (!/^[A-Za-z0-9_-]{16,96}$/.test(objectId)) return json({ error: 'invalid_object_id' }, 400);
  const maximumBytes = PAIR_MEDIA_CIPHERTEXT_LIMIT;
  if (bytes.byteLength < 29 || bytes.byteLength > maximumBytes) return json({ error: 'invalid_media_size' }, bytes.byteLength > maximumBytes ? 413 : 400);
  const existing = await database.prepare(
    `SELECT object_key AS objectKey, ciphertext_sha256 AS ciphertextSha256,
            ciphertext_bytes AS ciphertextBytes, created_revision AS createdRevision
       FROM gym_pair_media_objects WHERE pair_id = ? AND object_id = ?`,
  ).bind(row.pairId, objectId).first<{ objectKey: string; ciphertextSha256: string; ciphertextBytes: number; createdRevision: number }>();
  if (existing) {
    return json({ objectId, ciphertextSha256: existing.ciphertextSha256, ciphertextBytes: existing.ciphertextBytes,
      createdRevision: existing.createdRevision, revision: existing.createdRevision });
  }
  const quotaBytes = Math.floor(mediaConfig(context.env).quotaMB * MEDIA_MB);
  const usage = await database.prepare(
    'SELECT COALESCE(SUM(ciphertext_bytes), 0) AS bytes FROM gym_pair_media_objects WHERE pair_id = ?',
  ).bind(row.pairId).first<{ bytes: number }>();
  const usedBytes = Number(usage?.bytes ?? 0);
  if (quotaBytes > 0 && usedBytes + bytes.byteLength > quotaBytes) {
    const concurrent = await database.prepare(
      `SELECT object_key AS objectKey, ciphertext_sha256 AS ciphertextSha256,
              ciphertext_bytes AS ciphertextBytes, created_revision AS createdRevision
         FROM gym_pair_media_objects WHERE pair_id = ? AND object_id = ?`,
    ).bind(row.pairId, objectId).first<{ objectKey: string; ciphertextSha256: string; ciphertextBytes: number; createdRevision: number }>();
    if (concurrent) {
      return json({ objectId, ciphertextSha256: concurrent.ciphertextSha256, ciphertextBytes: concurrent.ciphertextBytes,
        createdRevision: concurrent.createdRevision, revision: concurrent.createdRevision });
    }
    return json({ error: 'pair_media_quota_exceeded', usage: { bytes: usedBytes, quotaBytes } }, 413);
  }
  const hash = await sha256Hex(bytes);
  const objectKey = `${row.pairId}/media/${crypto.randomUUID()}`;
  const createdRevision = row.revision + 1;
  await bucket.put(objectKey, bytes, { httpMetadata: { contentType: 'application/octet-stream' }, customMetadata: { ciphertextSha256: hash } });
  try {
    const quotaGuard = quotaBytes > 0
      ? 'AND (SELECT COALESCE(SUM(ciphertext_bytes), 0) FROM gym_pair_media_objects WHERE pair_id = ?) + ? <= ?'
      : '';
    const bindings: unknown[] = [row.pairId, objectId, objectKey, hash, bytes.byteLength, createdRevision,
      new Date().toISOString(), row.pairId, row.revision, new Date().toISOString()];
    if (quotaBytes > 0) bindings.push(row.pairId, bytes.byteLength, quotaBytes);
    await database.prepare(
      `INSERT INTO gym_pair_media_objects (pair_id, object_id, object_key, ciphertext_sha256, ciphertext_bytes, created_revision, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ? FROM gym_pair_channels
        WHERE pair_id = ? AND revision = ? AND revoked_at IS NULL AND expires_at > ?
        ${quotaGuard}
       ON CONFLICT(pair_id, object_id) DO NOTHING`,
    ).bind(...bindings).run();
  } catch (error) {
    await bucket.delete(objectKey);
    throw error;
  }
  const stored = await database.prepare(
    `SELECT object_key AS objectKey, ciphertext_sha256 AS ciphertextSha256,
            ciphertext_bytes AS ciphertextBytes, created_revision AS createdRevision
       FROM gym_pair_media_objects WHERE pair_id = ? AND object_id = ?`,
  ).bind(row.pairId, objectId).first<{ objectKey: string; ciphertextSha256: string; ciphertextBytes: number; createdRevision: number }>();
  if (!stored) {
    await bucket.delete(objectKey);
    const latestUsage = await database.prepare(
      'SELECT COALESCE(SUM(ciphertext_bytes), 0) AS bytes FROM gym_pair_media_objects WHERE pair_id = ?',
    ).bind(row.pairId).first<{ bytes: number }>();
    const latestUsedBytes = Number(latestUsage?.bytes ?? 0);
    if (quotaBytes > 0 && latestUsedBytes + bytes.byteLength > quotaBytes) {
      return json({ error: 'pair_media_quota_exceeded', usage: { bytes: latestUsedBytes, quotaBytes } }, 413);
    }
    return json({ error: 'pair_media_conflict' }, 409);
  }
  if (stored.objectKey !== objectKey) await bucket.delete(objectKey);
  return json({ objectId, ciphertextSha256: stored.ciphertextSha256, ciphertextBytes: stored.ciphertextBytes,
    createdRevision: stored.createdRevision, revision: stored.createdRevision });
};

export const readPairMedia = async (context: PairContext, pairId: string, objectId: string): Promise<Response> => {
  const database = context.env.DB;
  const bucket = context.env.PAIR_OBJECTS;
  if (!database || !bucket) return json({ error: 'pair_storage_unavailable' }, 503);
  const row = await database.prepare(
    `SELECT media.object_key AS objectKey, media.ciphertext_sha256 AS ciphertextSha256, media.ciphertext_bytes AS ciphertextBytes,
            media.created_revision AS createdRevision
       FROM gym_pair_media_objects media JOIN gym_pair_channels channel ON channel.pair_id = media.pair_id
      WHERE media.pair_id = ? AND media.object_id = ? AND channel.revoked_at IS NULL AND channel.expires_at > ?`,
  ).bind(pairId, objectId, new Date().toISOString()).first<{ objectKey: string; ciphertextSha256: string; ciphertextBytes: number; createdRevision: number }>();
  if (!row) return json({ error: 'pair_media_not_found' }, 404);
  const object = await bucket.get(row.objectKey);
  if (!object) return json({ error: 'pair_media_missing' }, 503);
  const headers = new Headers({ 'Cache-Control': 'private, no-store', 'Content-Type': 'application/octet-stream',
    'X-Pair-SHA256': row.ciphertextSha256, 'Content-Length': String(row.ciphertextBytes) });
  object.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Pair-SHA256', row.ciphertextSha256);
  headers.set('X-Pair-Media-Revision', String(row.createdRevision));
  return new Response(object.body, { headers });
};

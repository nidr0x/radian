import { enforceAuthRateLimit, isRecord } from '../lib/auth';
import type { SyncContext } from '../types';

const MAX_BODY_BYTES = 900_000;
const SYNC_KEY_PATTERN = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}$/;

type SyncRow = { payload: string; updatedAt: string; expiresAt?: string };

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' },
});

const keyFromRequest = (request: Request): string | undefined => {
  const key = request.headers.get('X-Radian-Sync-Key')?.trim().toUpperCase();
  return key && SYNC_KEY_PATTERN.test(key) ? key : undefined;
};

const requireDatabase = (context: SyncContext): Response | undefined => context.env.DB
  ? undefined
  : json({ error: 'sync_unavailable', message: 'La sincronización no está configurada todavía.' }, 503);

const getRow = async (context: SyncContext, key: string): Promise<SyncRow | null> => {
  const row = await context.env.DB!.prepare(
    'SELECT payload, updated_at AS updatedAt, expires_at AS expiresAt FROM sync_records WHERE sync_key = ?',
  ).bind(key).first<SyncRow>();
  if (row?.expiresAt && Date.parse(row.expiresAt) <= Date.now()) {
    await context.env.DB!.prepare('DELETE FROM sync_records WHERE sync_key = ? AND expires_at = ?').bind(key, row.expiresAt).run();
    return null;
  }
  return row;
};

const isEncryptedPayload = (value: unknown): boolean => isRecord(value)
  && value.version === 1
  && value.algorithm === 'AES-GCM'
  && typeof value.salt === 'string' && value.salt.length > 0
  && typeof value.iv === 'string' && value.iv.length > 0
  && typeof value.ciphertext === 'string' && value.ciphertext.length > 0;

const conflictResponse = (row: SyncRow | null): Response => {
  if (!row) return json({ error: 'conflict', message: 'La copia remota se ha eliminado en otro dispositivo.', data: null, updatedAt: null }, 409);
  try {
    return json({ error: 'conflict', message: 'Hay una copia más reciente en otro dispositivo.', data: JSON.parse(row.payload), updatedAt: row.updatedAt }, 409);
  } catch {
    return json({ error: 'invalid_record', message: 'La copia remota no se puede leer.' }, 500);
  }
};

export const onRequestOptions = (): Response => new Response(null, {
  status: 204,
  headers: { 'Access-Control-Allow-Headers': 'Content-Type, X-Radian-Sync-Key', 'Access-Control-Allow-Methods': 'DELETE, GET, OPTIONS, PUT' },
});

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const unavailable = requireDatabase(context);
  if (unavailable) return unavailable;
  const key = keyFromRequest(context.request);
  if (!key) return json({ error: 'invalid_key', message: 'El código de sincronización no es válido.' }, 400);
  const rateLimitResponse = await enforceAuthRateLimit(context, 'sync-get', key.slice(0, 8));
  if (rateLimitResponse) return rateLimitResponse;

  const row = await getRow(context, key);
  if (!row) return json({ data: null, updatedAt: null });
  try {
    return json({ data: JSON.parse(row.payload), updatedAt: row.updatedAt });
  } catch {
    return json({ error: 'invalid_record', message: 'La copia remota no se puede leer.' }, 500);
  }
};

export const onRequestPut = async (context: SyncContext): Promise<Response> => {
  const unavailable = requireDatabase(context);
  if (unavailable) return unavailable;
  const key = keyFromRequest(context.request);
  if (!key) return json({ error: 'invalid_key', message: 'El código de sincronización no es válido.' }, 400);
  const rateLimitResponse = await enforceAuthRateLimit(context, 'sync-put', key.slice(0, 8));
  if (rateLimitResponse) return rateLimitResponse;

  const body = await context.request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) {
    return json({ error: 'payload_too_large', message: 'La copia local es demasiado grande.' }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: 'invalid_json', message: 'El contenido enviado no es JSON válido.' }, 400);
  }
  if (!isRecord(parsed) || !('data' in parsed) || !isEncryptedPayload(parsed.data)) {
    return json({ error: 'invalid_payload', message: 'Faltan los datos de Radian.' }, 400);
  }

  const payload = JSON.stringify(parsed.data);
  const current = await getRow(context, key);
  const baseUpdatedAt = 'baseUpdatedAt' in parsed && typeof parsed.baseUpdatedAt === 'string' ? parsed.baseUpdatedAt : undefined;
  if (current && current.updatedAt !== baseUpdatedAt) return conflictResponse(current);
  if (!current && baseUpdatedAt) return conflictResponse(null);

  const updatedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 90 * 86400000).toISOString();
  const result = await context.env.DB!.prepare(
    `INSERT INTO sync_records (sync_key, payload, updated_at, expires_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(sync_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at, expires_at = excluded.expires_at
     WHERE sync_records.updated_at = ?`,
  ).bind(key, payload, updatedAt, expiresAt, baseUpdatedAt ?? '').run();
  if ((result.meta?.changes ?? 0) !== 1) {
    return conflictResponse(await getRow(context, key));
  }
  return json({ updatedAt });
};

export const onRequestDelete = async (context: SyncContext): Promise<Response> => {
  const unavailable = requireDatabase(context);
  if (unavailable) return unavailable;
  const key = keyFromRequest(context.request);
  if (!key) return json({ error: 'invalid_key', message: 'El código de sincronización no es válido.' }, 400);
  const rateLimitResponse = await enforceAuthRateLimit(context, 'sync-delete', key.slice(0, 8));
  if (rateLimitResponse) return rateLimitResponse;
  await context.env.DB!.prepare('DELETE FROM sync_records WHERE sync_key = ?').bind(key).run();
  return json({ deleted: true });
};

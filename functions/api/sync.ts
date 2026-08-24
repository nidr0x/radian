import type { SyncContext } from '../types';

const MAX_BODY_BYTES = 900_000;
const SYNC_KEY_PATTERN = /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){2}$/;

type SyncRow = { payload: string; updatedAt: string };

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
    'SELECT payload, updated_at AS updatedAt FROM sync_records WHERE sync_key = ?',
  ).bind(key).first<SyncRow>();
  return row;
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
  if (!parsed || typeof parsed !== 'object' || !('data' in parsed)) {
    return json({ error: 'invalid_payload', message: 'Faltan los datos de Radian.' }, 400);
  }

  const payload = JSON.stringify(parsed.data);
  const current = await getRow(context, key);
  const baseUpdatedAt = 'baseUpdatedAt' in parsed && typeof parsed.baseUpdatedAt === 'string' ? parsed.baseUpdatedAt : undefined;
  if (current && current.updatedAt !== baseUpdatedAt) {
    return json({ error: 'conflict', message: 'Hay una copia más reciente en otro dispositivo.', data: JSON.parse(current.payload), updatedAt: current.updatedAt }, 409);
  }

  const updatedAt = new Date().toISOString();
  await context.env.DB!.prepare(
    `INSERT INTO sync_records (sync_key, payload, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(sync_key) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  ).bind(key, payload, updatedAt).run();
  return json({ updatedAt });
};

export const onRequestDelete = async (context: SyncContext): Promise<Response> => {
  const unavailable = requireDatabase(context);
  if (unavailable) return unavailable;
  const key = keyFromRequest(context.request);
  if (!key) return json({ error: 'invalid_key', message: 'El código de sincronización no es válido.' }, 400);
  await context.env.DB!.prepare('DELETE FROM sync_records WHERE sync_key = ?').bind(key).run();
  return json({ deleted: true });
};

import { getAuthenticatedContext, isRecord, json } from '../lib/auth';
import type { SyncContext } from '../types';

const MAX_BODY_BYTES = 900_000;

const validAppData = (value: unknown): boolean => isRecord(value)
  && typeof value.schemaVersion === 'number'
  && isRecord(value.profile)
  && isRecord(value.plan)
  && Array.isArray(value.sessions);

interface UserDataRow { payload: string; updatedAt: string }

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const row = await authenticated.env.DB!.prepare('SELECT payload, updated_at AS updatedAt FROM user_data WHERE user_id = ?').bind(authenticated.user.id).first<UserDataRow>();
  if (!row) return json({ data: null, updatedAt: null });
  try { return json({ data: JSON.parse(row.payload), updatedAt: row.updatedAt }); } catch { return json({ error: 'invalid_record', message: 'Los datos guardados no se pueden leer.' }, 500); }
};

export const onRequestPut = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const bodyText = await context.request.text();
  if (new TextEncoder().encode(bodyText).byteLength > MAX_BODY_BYTES) return json({ error: 'payload_too_large', message: 'Los datos de Radian son demasiado grandes.' }, 413);
  let body: unknown;
  try { body = JSON.parse(bodyText); } catch { return json({ error: 'invalid_json', message: 'El contenido enviado no es válido.' }, 400); }
  if (!isRecord(body) || !validAppData(body.data)) return json({ error: 'invalid_payload', message: 'Faltan datos válidos de Radian.' }, 400);
  const current = await authenticated.env.DB!.prepare('SELECT payload, updated_at AS updatedAt FROM user_data WHERE user_id = ?').bind(authenticated.user.id).first<UserDataRow>();
  const baseUpdatedAt = typeof body.baseUpdatedAt === 'string' ? body.baseUpdatedAt : undefined;
  if (current && current.updatedAt !== baseUpdatedAt) return json({ error: 'conflict', message: 'Hay una copia más reciente en otro dispositivo.', data: JSON.parse(current.payload), updatedAt: current.updatedAt }, 409);
  const updatedAt = new Date().toISOString();
  await authenticated.env.DB!.prepare(
    `INSERT INTO user_data (user_id, payload, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
  ).bind(authenticated.user.id, JSON.stringify(body.data), updatedAt).run();
  return json({ updatedAt });
};

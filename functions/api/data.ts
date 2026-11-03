import { enforceAuthRateLimit, getAuthenticatedContext, isRecord, json } from '../lib/auth';
import { MAX_DOCUMENT_BYTES, readGymState, writeGymState } from '../lib/db/radian/state';
import { readSmallText } from '../lib/radian-api/request';
import type { SyncContext } from '../types';

const validBaseRevision = (value: unknown): boolean => value === undefined
  || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);

const validBaseWriteId = (value: unknown): boolean => value === undefined
  || value === null
  || (typeof value === 'string' && value.length > 0 && value.length <= 128);
const MAX_REQUEST_BYTES = MAX_DOCUMENT_BYTES + 1024;

const radianContractRequest = (request: Request): boolean => request.headers.get('Accept')
  ?.split(',').some((value) => ['application/vnd.radian+json', 'application/vnd.opengym+json'].includes(value.trim().toLowerCase())) ?? false;

interface UserDataRow { payload: string; updatedAt: string }

const validRadianData = (value: unknown): boolean => isRecord(value)
  && typeof value.schemaVersion === 'number'
  && isRecord(value.profile)
  && isRecord(value.plan)
  && Array.isArray(value.sessions);

const radianConflict = (row: UserDataRow | null): Response => {
  if (!row) return json({ error: 'conflict', message: 'La copia remota se ha eliminado en otro dispositivo.', data: null, updatedAt: null }, 409);
  try {
    return json({ error: 'conflict', message: 'Hay una copia más reciente en otro dispositivo.', data: JSON.parse(row.payload), updatedAt: row.updatedAt }, 409);
  } catch {
    return json({ error: 'invalid_record', message: 'Los datos guardados no se pueden leer.' }, 500);
  }
};

// Keep the current Radian Pages build usable until the Cloudflare PWA becomes the build output.
const radianGet = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const row = await authenticated.env.DB!.prepare('SELECT payload, updated_at AS updatedAt FROM user_data WHERE user_id = ?')
    .bind(authenticated.user.id).first<UserDataRow>();
  if (!row) return json({ data: null, updatedAt: null });
  try { return json({ data: JSON.parse(row.payload), updatedAt: row.updatedAt }); }
  catch { return json({ error: 'invalid_record', message: 'Los datos guardados no se pueden leer.' }, 500); }
};

const radianPut = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const input = await readSmallText(context.request, MAX_DOCUMENT_BYTES);
  if (!input.ok) return json(input.reason === 'too-large'
    ? { error: 'payload_too_large', message: 'Los datos de Radian son demasiado grandes.' }
    : { error: 'invalid_json', message: 'El contenido enviado no es válido.' }, input.reason === 'too-large' ? 413 : 400);
  let body: unknown;
  try { body = JSON.parse(input.value); } catch { return json({ error: 'invalid_json', message: 'El contenido enviado no es válido.' }, 400); }
  if (!isRecord(body) || !validRadianData(body.data)) return json({ error: 'invalid_payload', message: 'Faltan datos válidos de Radian.' }, 400);
  const database = authenticated.env.DB!;
  const current = await database.prepare('SELECT payload, updated_at AS updatedAt FROM user_data WHERE user_id = ?')
    .bind(authenticated.user.id).first<UserDataRow>();
  const baseUpdatedAt = typeof body.baseUpdatedAt === 'string' ? body.baseUpdatedAt : undefined;
  if (current && current.updatedAt !== baseUpdatedAt) return radianConflict(current);
  if (!current && baseUpdatedAt) return radianConflict(null);
  const updatedAt = new Date().toISOString();
  const result = await database.prepare(
    `INSERT INTO user_data (user_id, payload, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
     WHERE user_data.updated_at = ?`,
  ).bind(authenticated.user.id, JSON.stringify(body.data), updatedAt, baseUpdatedAt ?? '').run();
  if ((result.meta?.changes ?? 0) !== 1) {
    const latest = await database.prepare('SELECT payload, updated_at AS updatedAt FROM user_data WHERE user_id = ?')
      .bind(authenticated.user.id).first<UserDataRow>();
    return radianConflict(latest);
  }
  return json({ updatedAt });
};

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  if (!radianContractRequest(context.request)) return radianGet(context);
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const snapshot = await readGymState(authenticated.env.DB!, authenticated.user.id);
  return json({ state: snapshot.state, rev: snapshot.rev });
};

export const onRequestPut = async (context: SyncContext): Promise<Response> => {
  if (!radianContractRequest(context.request)) return radianPut(context);
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const rateLimit = await enforceAuthRateLimit(context, 'sync-put', authenticated.user.id);
  if (rateLimit) return rateLimit;

  const input = await readSmallText(context.request, MAX_REQUEST_BYTES);
  if (!input.ok) return json(input.reason === 'too-large'
    ? { error: 'payload_too_large', message: 'Los datos de entrenamiento superan el límite permitido.' }
    : { error: 'invalid_json', message: 'El contenido enviado no es JSON válido.' }, input.reason === 'too-large' ? 413 : 400);

  let body: unknown;
  try { body = JSON.parse(input.value); }
  catch { return json({ error: 'invalid_json', message: 'El contenido enviado no es JSON válido.' }, 400); }
  if (!isRecord(body) || !isRecord(body.state) || !validBaseRevision(body.baseRev) || !validBaseWriteId(body.baseWid)) {
    return json({ error: 'invalid_payload', message: 'El documento o su revisión base no son válidos.' }, 400);
  }

  const state = body.stamped === false ? { ...body.state, _ts: Date.now() } : body.state;
  const result = await writeGymState(authenticated.env.DB!, authenticated.user.id, {
    state,
    ...(typeof body.baseRev === 'number' ? { baseRev: body.baseRev } : {}),
    ...(typeof body.baseWid === 'string' || body.baseWid === null ? { baseWid: body.baseWid } : {}),
  });

  if (!result.ok && 'conflict' in result) {
    return json({ error: 'conflict', message: 'Hay una versión más reciente en otro dispositivo.', ...result.conflict }, 409);
  }
  if (!result.ok) {
    const status = result.error === 'payload_too_large' || result.error === 'field_too_large' ? 413 : 400;
    return json({ error: result.error, message: 'No se han podido guardar los datos enviados.' }, status);
  }
  return json({ rev: result.rev, wid: result.wid });
};

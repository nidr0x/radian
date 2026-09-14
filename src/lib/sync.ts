import type { AppData } from '../types';

export const SYNC_SETTINGS_KEY = 'radian-sync-v1';

export interface SyncState {
  key?: string;
  remoteUpdatedAt?: string;
}

export interface RemoteSyncData {
  data: AppData | null;
  updatedAt?: string;
}

export interface SyncCopySummary {
  sessionCount: number;
  progressCount: number;
  checkinCount: number;
  latestSessionDate?: string;
  latestProgressDate?: string;
}

export interface SyncCopyComparison {
  local: SyncCopySummary;
  remote: SyncCopySummary;
  changed: {
    profile: boolean;
    routine: boolean;
    sessions: boolean;
    progress: boolean;
    checkins: boolean;
  };
}

interface EncryptedSyncPayload {
  version: 1;
  algorithm: 'AES-GCM';
  salt: string;
  iv: string;
  ciphertext: string;
}

export class SyncApiError extends Error {
  status: number;
  remote?: RemoteSyncData;

  constructor(message: string, status: number, remote?: RemoteSyncData) {
    super(message);
    this.name = 'SyncApiError';
    this.status = status;
    this.remote = remote;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isAppData = (value: unknown): value is AppData => isRecord(value) && typeof value.schemaVersion === 'number' && isRecord(value.profile) && isRecord(value.plan);
const isEncryptedPayload = (value: unknown): value is EncryptedSyncPayload => isRecord(value)
  && value.version === 1 && value.algorithm === 'AES-GCM'
  && typeof value.salt === 'string' && typeof value.iv === 'string' && typeof value.ciphertext === 'string';

const latestDate = (values: string[]): string | undefined => values.sort((a, b) => a.localeCompare(b)).at(-1);

export const syncCopySummary = (data: AppData): SyncCopySummary => ({
  sessionCount: data.sessions.length,
  progressCount: data.progress.length,
  checkinCount: data.checkins.length,
  latestSessionDate: latestDate(data.sessions.map((session) => session.dateKey)),
  latestProgressDate: latestDate(data.progress.map((entry) => entry.date)),
});

export const compareSyncCopies = (local: AppData, remote: AppData): SyncCopyComparison => ({
  local: syncCopySummary(local),
  remote: syncCopySummary(remote),
  changed: {
    profile: JSON.stringify(local.profile) !== JSON.stringify(remote.profile),
    routine: JSON.stringify(local.plan) !== JSON.stringify(remote.plan),
    sessions: JSON.stringify(local.sessions) !== JSON.stringify(remote.sessions),
    progress: JSON.stringify(local.progress) !== JSON.stringify(remote.progress),
    checkins: JSON.stringify(local.checkins) !== JSON.stringify(remote.checkins),
  },
});

const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
};

const decodeBase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const asBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const deriveEncryptionKey = async (syncKey: string, salt: Uint8Array): Promise<CryptoKey> => {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(syncKey), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: asBuffer(salt), iterations: 120_000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};

const encryptData = async (data: AppData, syncKey: string): Promise<EncryptedSyncPayload> => {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveEncryptionKey(syncKey, salt);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(data)));
  return { version: 1, algorithm: 'AES-GCM', salt: encodeBase64(salt), iv: encodeBase64(iv), ciphertext: encodeBase64(new Uint8Array(ciphertext)) };
};

const decryptData = async (payload: unknown, syncKey: string): Promise<AppData> => {
  if (isAppData(payload)) return payload;
  if (!isEncryptedPayload(payload)) throw new SyncApiError('La copia remota no tiene un formato válido.', 422);
  try {
    const salt = decodeBase64(payload.salt);
    const iv = decodeBase64(payload.iv);
    const key = await deriveEncryptionKey(syncKey, salt);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: asBuffer(iv) }, key, asBuffer(decodeBase64(payload.ciphertext)));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plain));
    if (!isAppData(parsed)) throw new Error('invalid_data');
    return parsed;
  } catch {
    throw new SyncApiError('El código no permite descifrar esta copia remota.', 401);
  }
};

export const normalizeSyncKey = (value: string): string => value.trim().toUpperCase().replace(/\s+/g, '-');

export const generateSyncKey = (): string => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const values = new Uint32Array(12);
  crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join('').match(/.{4}/g)!.join('-');
};

export const loadSyncState = (): SyncState => {
  try {
    const raw = localStorage.getItem(SYNC_SETTINGS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!isRecord(parsed)) return {};
    return {
      key: typeof parsed.key === 'string' ? normalizeSyncKey(parsed.key) : undefined,
      remoteUpdatedAt: typeof parsed.remoteUpdatedAt === 'string' ? parsed.remoteUpdatedAt : undefined,
    };
  } catch {
    return {};
  }
};

export const persistSyncState = (state: SyncState): boolean => {
  try {
    localStorage.setItem(SYNC_SETTINGS_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
};

const readResponse = async (response: Response): Promise<Record<string, unknown>> => {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) throw new SyncApiError('La sincronización no está disponible en este entorno.', response.status);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new SyncApiError('La respuesta de sincronización no es válida.', response.status);
  return body;
};

export const pullSyncData = async (key: string): Promise<RemoteSyncData> => {
  const normalizedKey = normalizeSyncKey(key);
  const response = await fetch('/api/sync', { headers: { 'X-Radian-Sync-Key': normalizedKey } });
  const body = await readResponse(response);
  if (!response.ok) throw new SyncApiError(typeof body.message === 'string' ? body.message : 'No se pudo leer la copia remota.', response.status);
  if (body.data === null || body.data === undefined) return { data: null, updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : undefined };
  return {
    data: await decryptData(body.data, normalizedKey),
    updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : undefined,
  };
};

export const pushSyncData = async (data: AppData, state: SyncState): Promise<{ updatedAt: string }> => {
  if (!state.key) throw new SyncApiError('Primero genera o introduce un código de sincronización.', 400);
  const response = await fetch('/api/sync', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Radian-Sync-Key': state.key },
    body: JSON.stringify({ data: await encryptData(data, state.key), baseUpdatedAt: state.remoteUpdatedAt }),
  });
  const body = await readResponse(response);
  if (!response.ok) {
    const remote = isRecord(body.data)
      ? { data: await decryptData(body.data, state.key), updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : undefined }
      : undefined;
    throw new SyncApiError(typeof body.message === 'string' ? body.message : 'No se pudo guardar la copia remota.', response.status, remote);
  }
  if (typeof body.updatedAt !== 'string') throw new SyncApiError('La copia remota no devolvió fecha de actualización.', response.status);
  return { updatedAt: body.updatedAt };
};

export const deleteSyncData = async (key: string): Promise<void> => {
  const response = await fetch('/api/sync', { method: 'DELETE', headers: { 'X-Radian-Sync-Key': normalizeSyncKey(key) } });
  const body = await readResponse(response);
  if (!response.ok) throw new SyncApiError(typeof body.message === 'string' ? body.message : 'No se pudo revocar la copia remota.', response.status);
};

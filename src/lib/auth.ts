import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from '@simplewebauthn/browser';
import type { AppData } from '../types';

export interface AuthUser {
  id: string;
  displayName: string;
  createdAt: string;
}

export interface AuthPasskey {
  credentialId: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface CloudData {
  data: AppData | null;
  updatedAt?: string;
}

export class AuthApiError extends Error {
  status: number;
  remote?: CloudData;

  constructor(message: string, status: number, remote?: CloudData) {
    super(message);
    this.name = 'AuthApiError';
    this.status = status;
    this.remote = remote;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readResponse = async (response: Response): Promise<Record<string, unknown>> => {
  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body)) throw new AuthApiError('La respuesta de la cuenta no es válida.', response.status);
  if (!response.ok) throw new AuthApiError(typeof body.message === 'string' ? body.message : 'No se pudo completar la operación.', response.status, isRecord(body.data) ? { data: body.data as unknown as AppData, updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : undefined } : undefined);
  return body;
};

const request = async (url: string, init: RequestInit = {}): Promise<Record<string, unknown>> => readResponse(await fetch(url, { ...init, credentials: 'include', headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) } }));
const post = async (url: string, body: Record<string, unknown> = {}): Promise<Record<string, unknown>> => request(url, { method: 'POST', body: JSON.stringify(body) });

const ensureWebAuthn = (): void => {
  if (!window.PublicKeyCredential || !navigator.credentials) throw new AuthApiError('Este navegador no admite passkeys.', 0);
};

export const currentUser = async (): Promise<AuthUser | undefined> => {
  const response = await fetch('/api/auth/me', { credentials: 'include', headers: { Accept: 'application/json' } });
  if (response.status === 401 || response.status === 503) return undefined;
  const body = await readResponse(response);
  return isRecord(body.user) && typeof body.user.id === 'string' && typeof body.user.displayName === 'string' && typeof body.user.createdAt === 'string'
    ? { id: body.user.id, displayName: body.user.displayName, createdAt: body.user.createdAt }
    : undefined;
};

export const registerPasskey = async (displayName: string, passkeyLabel = 'Passkey principal'): Promise<AuthUser> => {
  ensureWebAuthn();
  const optionsResponse = await post('/api/auth/register/options', { displayName, passkeyLabel });
  const options = optionsResponse.options as PublicKeyCredentialCreationOptionsJSON;
  const credential: RegistrationResponseJSON = await startRegistration({ optionsJSON: options });
  const verified = await post('/api/auth/register/verify', { challengeId: optionsResponse.challengeId, credential });
  if (!isRecord(verified.user)) throw new AuthApiError('La cuenta se creó, pero no se pudo recuperar el perfil.', 500);
  return verified.user as unknown as AuthUser;
};

export const addPasskey = async (passkeyLabel = 'Passkey'): Promise<void> => {
  ensureWebAuthn();
  const optionsResponse = await post('/api/auth/passkeys/options', { passkeyLabel });
  const credential: RegistrationResponseJSON = await startRegistration({ optionsJSON: optionsResponse.options as PublicKeyCredentialCreationOptionsJSON });
  await post('/api/auth/register/verify', { challengeId: optionsResponse.challengeId, credential });
};

export const loginWithPasskey = async (): Promise<AuthUser> => {
  ensureWebAuthn();
  const optionsResponse = await post('/api/auth/login/options');
  const options = optionsResponse.options as PublicKeyCredentialRequestOptionsJSON;
  const credential: AuthenticationResponseJSON = await startAuthentication({ optionsJSON: options });
  const verified = await post('/api/auth/login/verify', { challengeId: optionsResponse.challengeId, credential });
  if (!isRecord(verified.user)) throw new AuthApiError('Has accedido, pero no se pudo recuperar el perfil.', 500);
  return verified.user as unknown as AuthUser;
};

export const logout = async (): Promise<void> => { await post('/api/auth/logout'); };
export const logoutEverywhere = async (): Promise<void> => { await post('/api/auth/logout/all'); };

export const listPasskeys = async (): Promise<AuthPasskey[]> => {
  const body = await request('/api/auth/passkeys', { method: 'GET', headers: { Accept: 'application/json' } });
  return Array.isArray(body.passkeys) ? body.passkeys.filter(isRecord).map((passkey) => ({
    credentialId: typeof passkey.credentialId === 'string' ? passkey.credentialId : '',
    label: typeof passkey.label === 'string' ? passkey.label : 'Passkey',
    createdAt: typeof passkey.createdAt === 'string' ? passkey.createdAt : '',
    lastUsedAt: typeof passkey.lastUsedAt === 'string' ? passkey.lastUsedAt : undefined,
  })).filter((passkey) => passkey.credentialId) : [];
};

export const renamePasskey = async (credentialId: string, label: string): Promise<void> => {
  await request('/api/auth/passkeys', { method: 'PATCH', body: JSON.stringify({ credentialId, label }) });
};

export const revokePasskey = async (credentialId: string): Promise<void> => {
  await request('/api/auth/passkeys', { method: 'DELETE', body: JSON.stringify({ credentialId }) });
};

export const pullCloudData = async (): Promise<CloudData> => {
  const response = await fetch('/api/data', { credentials: 'include', headers: { Accept: 'application/json' } });
  const body = await readResponse(response);
  return { data: body.data && isRecord(body.data) ? body.data as unknown as AppData : null, updatedAt: typeof body.updatedAt === 'string' ? body.updatedAt : undefined };
};

export const pushCloudData = async (data: AppData, baseUpdatedAt?: string): Promise<{ updatedAt: string }> => {
  const response = await fetch('/api/data', {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data, baseUpdatedAt }),
  });
  const body = await readResponse(response);
  if (typeof body.updatedAt !== 'string') throw new AuthApiError('La nube no devolvió una fecha de sincronización.', response.status);
  return { updatedAt: body.updatedAt };
};

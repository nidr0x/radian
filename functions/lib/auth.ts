import type { D1DatabaseLike, SyncContext } from '../types';

export interface AuthUser {
  id: string;
  displayName: string;
  createdAt: string;
}

export interface AuthenticatedContext extends SyncContext {
  user: AuthUser;
}

export interface ChallengeRow {
  id: string;
  kind: 'register' | 'login';
  mode: 'new_account' | 'add_passkey';
  challenge: string;
  userId?: string;
  displayName?: string;
  passkeyLabel?: string;
}

const SESSION_COOKIE = 'radian_session';
const SESSION_DAYS = 30;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
});

export const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const body: unknown = await request.json().catch(() => null);
  return isRecord(body) ? body : {};
};

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export const requireDatabase = (context: SyncContext): D1DatabaseLike | Response => context.env.DB
  ?? json({ error: 'database_unavailable', message: 'La cuenta en la nube todavía no está configurada.' }, 503);

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

export const decodeBase64Url = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

export const randomId = (bytes = 16): string => {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return encodeBase64Url(value);
};

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const signHmac = async (secret: string, payload: string): Promise<ArrayBuffer> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
};

const verifyHmac = async (secret: string, payload: string, signature: Uint8Array): Promise<boolean> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('HMAC', key, asArrayBuffer(signature), new TextEncoder().encode(payload));
};

const authConfig = (context: SyncContext): { rpId: string; origin: string; rpName: string; sessionSecret: string } => {
  const url = new URL(context.request.url);
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  return {
    rpId: context.env.WEBAUTHN_RP_ID ?? url.hostname,
    origin: context.env.WEBAUTHN_ORIGIN ?? url.origin,
    rpName: context.env.WEBAUTHN_RP_NAME ?? 'Radian',
    sessionSecret: context.env.SESSION_SECRET ?? (isLocal ? 'radian-local-development-secret' : ''),
  };
};

export const getWebAuthnConfig = (context: SyncContext): { rpId: string; origin: string; rpName: string } => {
  const config = authConfig(context);
  return { rpId: config.rpId, origin: config.origin, rpName: config.rpName };
};

const getCookie = (request: Request, name: string): string | undefined => request.headers.get('Cookie')?.split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);

const userFromSession = async (context: SyncContext, db: D1DatabaseLike): Promise<AuthUser | undefined> => {
  const token = getCookie(context.request, SESSION_COOKIE);
  const secret = authConfig(context).sessionSecret;
  if (!token || !secret) return undefined;
  const separator = token.lastIndexOf('.');
  if (separator < 0) return undefined;
  const payload = token.slice(0, separator);
  let validSignature = false;
  try { validSignature = await verifyHmac(secret, payload, decodeBase64Url(token.slice(separator + 1))); } catch { return undefined; }
  if (!validSignature) return undefined;
  const [userId, expiry, sessionVersion] = payload.split(':');
  if (!userId || !expiry || Number(expiry) < Date.now() || !sessionVersion) return undefined;
  const row = await db.prepare(
    'SELECT id, display_name AS displayName, created_at AS createdAt, session_version AS sessionVersion, disabled FROM users WHERE id = ?',
  ).bind(userId).first<{ id: string; displayName: string; createdAt: string; sessionVersion: number; disabled: number }>();
  if (!row || row.disabled === 1 || String(row.sessionVersion) !== sessionVersion) return undefined;
  return { id: row.id, displayName: row.displayName, createdAt: row.createdAt };
};

export const getAuthenticatedContext = async (context: SyncContext): Promise<AuthenticatedContext | Response> => {
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  const user = await userFromSession(context, database);
  return user ? { ...context, user } : json({ error: 'not_authenticated', message: 'Inicia sesión con tu passkey para continuar.' }, 401);
};

export const issueSessionCookie = async (context: SyncContext, userId: string, sessionVersion: number): Promise<string> => {
  const config = authConfig(context);
  if (!config.sessionSecret) throw new Error('SESSION_SECRET is required in production');
  const payload = `${userId}:${Date.now() + SESSION_DAYS * 86400000}:${sessionVersion}`;
  const signature = encodeBase64Url(new Uint8Array(await signHmac(config.sessionSecret, payload)));
  const secure = config.origin.startsWith('https://') ? ' Secure;' : '';
  return `${SESSION_COOKIE}=${payload}.${signature}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax;${secure}`;
};

export const clearSessionCookie = (context: SyncContext): string => `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax;${authConfig(context).origin.startsWith('https://') ? ' Secure;' : ''}`;

export const consumeChallenge = async (db: D1DatabaseLike, id: string, kind: ChallengeRow['kind']): Promise<ChallengeRow | undefined> => {
  const usedAt = new Date().toISOString();
  const result = await db.prepare(
    'UPDATE auth_challenges SET used_at = ? WHERE id = ? AND kind = ? AND used_at IS NULL AND expires_at > ?',
  ).bind(usedAt, id, kind, usedAt).run();
  if ((result.meta?.changes ?? 0) !== 1) return undefined;
  return (await db.prepare(
    'SELECT id, kind, mode, challenge, user_id AS userId, display_name AS displayName, passkey_label AS passkeyLabel FROM auth_challenges WHERE id = ?',
  ).bind(id).first<ChallengeRow>()) ?? undefined;
};

export const challengeExpiry = (): string => new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();

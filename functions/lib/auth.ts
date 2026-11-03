import type { D1DatabaseLike, D1ResultLike, SyncContext } from '../types';
import { readSmallJson } from './radian-api/request';

export interface AuthUser {
  id: string;
  displayName: string;
  createdAt: string;
}

export interface AccountRoles {
  admin: boolean;
  owner: boolean;
}

export interface AuthenticatedContext extends SyncContext {
  user: AuthUser;
  sessionId: string;
  sessionCredentialId?: string;
  sessionReauthenticatedAt?: string;
}

export interface ChallengeRow {
  id: string;
  kind: 'register' | 'login';
  mode: 'new_account' | 'add_passkey';
  challenge: string;
  userId?: string;
  displayName?: string;
  passkeyLabel?: string;
  inviteCodeHash?: string;
  deviceLinkCodeHash?: string;
}

export interface StepUpChallengeRow {
  id: string;
  challenge: string;
  userId: string;
}

const SESSION_COOKIE = 'radian_session';
const SECURE_SESSION_COOKIE = '__Host-radian_session';
const SESSION_DAYS = 30;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const REAUTH_TTL_MS = 10 * 60 * 1000;

export const json = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
});

export const readJson = async (request: Request): Promise<Record<string, unknown>> => {
  const body = await readSmallJson(request);
  return body.ok ? body.value : {};
};

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export const requireDatabase = (context: SyncContext): D1DatabaseLike | Response => context.env.DB
  ?? json({ error: 'database_unavailable', message: 'La cuenta en la nube todavía no está configurada.' }, 503);

const isLocalRequest = (request: Request): boolean => {
  const hostname = new URL(request.url).hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1';
};

const clientAddress = (context: SyncContext): string => context.request.headers.get('CF-Connecting-IP') ?? 'unknown';

const rateLimitMax = (route: string): number => {
  if (route.endsWith('-options')) return 30;
  if (route === 'coach-status') return 30;
  if (route === 'sync-put-ip') return 5;
  if (route.startsWith('sync-')) return 120;
  if (route === 'pair-v2-write-ip') return 55;
  if (route === 'passkeys-list') return 60;
  return 10;
};

export const enforceAuthRateLimit = async (context: SyncContext, route: string, subject?: string): Promise<Response | undefined> => {
  const key = `auth:${route}:${clientAddress(context)}${subject ? `:${subject}` : ''}`;
  const limiter = context.env.AUTH_RATE_LIMITER;
  if (limiter) {
    try {
      const result = await limiter.limit({ key });
      if (!result.success) return json({ error: 'rate_limited', message: 'Demasiados intentos. Espera un minuto y vuelve a intentarlo.' }, 429, { 'Retry-After': '60' });
      return undefined;
    } catch {
      // Fall back to D1 so authentication does not become unbounded if the edge limiter is unavailable.
    }
  }

  const database = requireDatabase(context);
  if (database instanceof Response) return json({ error: 'rate_limit_unavailable', message: 'La protección de autenticación no está disponible.' }, 503);
  const now = new Date();
  const windowStartedAt = new Date(now.getTime() - 60 * 1000).toISOString();
  try {
    await database.prepare(
      `INSERT INTO auth_rate_limits (key, window_started_at, attempts)
       VALUES (?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET
         attempts = CASE WHEN auth_rate_limits.window_started_at <= ? THEN 1 ELSE auth_rate_limits.attempts + 1 END,
         window_started_at = CASE WHEN auth_rate_limits.window_started_at <= ? THEN excluded.window_started_at ELSE auth_rate_limits.window_started_at END`,
    ).bind(key, now.toISOString(), windowStartedAt, windowStartedAt).run();
    const row = await database.prepare('SELECT attempts, window_started_at AS windowStartedAt FROM auth_rate_limits WHERE key = ?').bind(key).first<{ attempts: number; windowStartedAt: string }>();
    if (!row) return json({ error: 'rate_limit_unavailable', message: 'La protección de autenticación no está disponible.' }, 503);
    if (row.attempts > rateLimitMax(route)) return json({ error: 'rate_limited', message: 'Demasiados intentos. Espera un minuto y vuelve a intentarlo.' }, 429, { 'Retry-After': '60' });
  } catch {
    return json({ error: 'rate_limit_unavailable', message: 'La protección de autenticación no está disponible.' }, 503);
  }
  return undefined;
};

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

const challengeCookieName = (id: string, request: Request): string | undefined => {
  if (!/^[A-Za-z0-9_-]{24}$/.test(id)) return undefined;
  const prefix = isLocalRequest(request) ? 'radian_challenge_' : '__Host-radian_challenge_';
  return `${prefix}${id}`;
};

export const createChallengeBinding = async (context: SyncContext, id: string): Promise<{ hash: string; cookie: string }> => {
  const cookieName = challengeCookieName(id, context.request);
  if (!cookieName) throw new Error('INVALID_CHALLENGE_ID');
  const token = randomId(32);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const secure = isLocalRequest(context.request) ? '' : ' Secure;';
  return { hash, cookie: `${cookieName}=${token}; Path=/; Max-Age=300; HttpOnly; SameSite=Strict;${secure}` };
};

export const getChallengeBinding = (context: SyncContext, id: string): string | undefined => {
  const name = challengeCookieName(id, context.request);
  if (!name) return undefined;
  const cookie = context.request.headers.get('Cookie')?.split(';').map((value) => value.trim()).find((value) => value.startsWith(`${name}=`));
  const token = cookie?.slice(name.length + 1);
  return token && /^[A-Za-z0-9_-]{40,50}$/.test(token) ? token : undefined;
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
  const isLocal = isLocalRequest(context.request);
  return {
    rpId: context.env.WEBAUTHN_RP_ID?.trim() || url.hostname,
    origin: context.env.WEBAUTHN_ORIGIN?.trim() || url.origin,
    rpName: context.env.WEBAUTHN_RP_NAME?.trim() || 'Radian',
    sessionSecret: context.env.SESSION_SECRET?.trim() || (isLocal ? 'radian-local-development-secret' : ''),
  };
};

export const getWebAuthnConfig = (context: SyncContext): { rpId: string; origin: string; rpName: string } => {
  const config = authConfig(context);
  return { rpId: config.rpId, origin: config.origin, rpName: config.rpName };
};

export const requireAuthConfiguration = (context: SyncContext, requestOrigin = context.request.url): Response | undefined => {
  const config = authConfig(context);
  let requestUrl: URL;
  let configuredOrigin: URL;
  try {
    requestUrl = new URL(requestOrigin);
    configuredOrigin = new URL(config.origin);
  } catch {
    return json({ error: 'auth_configuration_unavailable', message: 'La configuración de autenticación no es válida.' }, 503);
  }
  const validRpId = config.rpId === requestUrl.hostname || requestUrl.hostname.endsWith(`.${config.rpId}`);
  const validOrigin = configuredOrigin.origin === requestUrl.origin;
  const secureTransport = requestUrl.protocol === 'https:' || isLocalRequest(context.request);
  if (!config.sessionSecret || !validRpId || !validOrigin || !secureTransport) {
    return json({ error: 'auth_configuration_unavailable', message: 'La autenticación no está configurada para este entorno.' }, 503);
  }
  return undefined;
};

const getCookie = (request: Request, names: string[]): string | undefined => {
  const cookies = request.headers.get('Cookie')?.split(';').map((value) => value.trim()) ?? [];
  for (const name of names) {
    const value = cookies.find((cookie) => cookie.startsWith(`${name}=`));
    if (value) return value.slice(name.length + 1);
  }
  return undefined;
};

interface SessionRow {
  sessionId: string;
  id: string;
  displayName: string;
  createdAt: string;
  sessionVersion: number;
  disabled: number;
  credentialId?: string;
  reauthenticatedAt?: string;
}

const sessionFromRequest = async (context: SyncContext, db: D1DatabaseLike): Promise<SessionRow | undefined> => {
  const config = authConfig(context);
  const token = getCookie(context.request, [SECURE_SESSION_COOKIE, SESSION_COOKIE]);
  if (!token || !config.sessionSecret) return undefined;
  const separator = token.lastIndexOf('.');
  if (separator < 0) return undefined;
  const payload = token.slice(0, separator);
  let validSignature = false;
  try { validSignature = await verifyHmac(config.sessionSecret, payload, decodeBase64Url(token.slice(separator + 1))); } catch { return undefined; }
  if (!validSignature) return undefined;
  const [sessionId, expiry, sessionVersion] = payload.split(':');
  if (!sessionId || !expiry || !sessionVersion || !/^\d+$/.test(expiry) || Number(expiry) <= Date.now()) return undefined;
  const row = await db.prepare(
    `SELECT s.id AS sessionId, u.id, u.display_name AS displayName, u.created_at AS createdAt,
            u.session_version AS sessionVersion, u.disabled, s.credential_id AS credentialId,
            s.reauthenticated_at AS reauthenticatedAt
       FROM auth_sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ?`,
  ).bind(sessionId, new Date().toISOString()).first<SessionRow>();
  if (!row || row.disabled === 1 || String(row.sessionVersion) !== sessionVersion) return undefined;
  return row;
};

const userFromSession = async (context: SyncContext, db: D1DatabaseLike): Promise<SessionRow | undefined> => sessionFromRequest(context, db);

export const getAuthenticatedContext = async (context: SyncContext): Promise<AuthenticatedContext | Response> => {
  const configurationError = requireAuthConfiguration(context);
  if (configurationError) return configurationError;
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  const session = await userFromSession(context, database);
  return session ? {
    ...context,
    user: { id: session.id, displayName: session.displayName, createdAt: session.createdAt },
    sessionId: session.sessionId,
    sessionCredentialId: session.credentialId,
    sessionReauthenticatedAt: session.reauthenticatedAt,
  } : json({ error: 'not_authenticated', message: 'Inicia sesión con tu passkey para continuar.' }, 401);
};

export const getAccountRoles = async (database: D1DatabaseLike, userId: string, env: SyncContext['env']): Promise<AccountRoles> => {
  const user = await database.prepare('SELECT is_admin AS isAdmin, is_owner AS isOwner FROM users WHERE id = ?')
    .bind(userId).first<{ isAdmin: number; isOwner: number }>();
  if (!user) return { admin: false, owner: false };
  let ownerId = (await database.prepare('SELECT id FROM users WHERE is_owner = 1 LIMIT 1').first<{ id: string }>())?.id ?? null;
  if (!ownerId) {
    for (const id of (env.ADMIN_UIDS ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
      const configured = await database.prepare('SELECT id FROM users WHERE id = ?').bind(id).first<{ id: string }>();
      if (configured) { ownerId = id; break; }
    }
  }
  if (!ownerId) {
    ownerId = (await database.prepare('SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at, id LIMIT 1').first<{ id: string }>())?.id ?? null;
  }
  const configuredAdmin = (env.ADMIN_UIDS ?? '').split(',').map((value) => value.trim()).includes(userId);
  const owner = ownerId === userId;
  return { admin: user.isAdmin === 1 || user.isOwner === 1 || configuredAdmin || owner, owner };
};

export const requireRecentReauthentication = (context: AuthenticatedContext): Response | undefined => {
  const reauthenticatedAt = context.sessionReauthenticatedAt ? Date.parse(context.sessionReauthenticatedAt) : NaN;
  if (!Number.isFinite(reauthenticatedAt) || Date.now() - reauthenticatedAt > REAUTH_TTL_MS) {
    return json({ error: 'reauthentication_required', message: 'Vuelve a verificar tu passkey para confirmar este cambio.' }, 403);
  }
  return undefined;
};

export const issueSessionCookie = async (context: SyncContext, userId: string, sessionVersion: number, credentialId?: string): Promise<string> => {
  const configurationError = requireAuthConfiguration(context);
  if (configurationError) throw new Error('AUTH_CONFIGURATION_INVALID');
  const database = requireDatabase(context);
  if (database instanceof Response) throw new Error('DATABASE_UNAVAILABLE');
  const config = authConfig(context);
  const sessionId = randomId();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
  await database.prepare(
    'INSERT INTO auth_sessions (id, user_id, credential_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  ).bind(sessionId, userId, credentialId ?? null, new Date().toISOString(), expiresAt).run();
  const payload = `${sessionId}:${Date.parse(expiresAt)}:${sessionVersion}`;
  const signature = encodeBase64Url(new Uint8Array(await signHmac(config.sessionSecret, payload)));
  const secure = isLocalRequest(context.request) ? '' : ' Secure;';
  const cookieName = isLocalRequest(context.request) ? SESSION_COOKIE : SECURE_SESSION_COOKIE;
  return `${cookieName}=${payload}.${signature}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; SameSite=Lax;${secure}`;
};

export const clearSessionCookie = (context: SyncContext): string => {
  const secure = isLocalRequest(context.request) ? '' : ' Secure;';
  const cookieName = isLocalRequest(context.request) ? SESSION_COOKIE : SECURE_SESSION_COOKIE;
  return `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax;${secure}`;
};

export const revokeCurrentSession = async (context: SyncContext): Promise<boolean> => {
  const database = requireDatabase(context);
  if (database instanceof Response) return false;
  const session = await sessionFromRequest(context, database);
  if (!session) return false;
  const result = await database.prepare('UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').bind(new Date().toISOString(), session.sessionId).run();
  return (result.meta?.changes ?? 0) === 1;
};

export const revokeCredentialSessions = async (database: D1DatabaseLike, credentialId: string): Promise<D1ResultLike> => database.prepare(
  'UPDATE auth_sessions SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL',
).bind(new Date().toISOString(), credentialId).run();

export const markSessionReauthenticated = async (context: AuthenticatedContext): Promise<void> => {
  const database = requireDatabase(context);
  if (database instanceof Response) throw new Error('DATABASE_UNAVAILABLE');
  await database.prepare('UPDATE auth_sessions SET reauthenticated_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL').bind(new Date().toISOString(), context.sessionId, context.user.id).run();
};

export const consumeChallenge = async (db: D1DatabaseLike, id: string, kind: ChallengeRow['kind'], binding: string | undefined): Promise<ChallengeRow | undefined> => {
  if (!binding || !/^[A-Za-z0-9_-]{24}$/.test(id)) return undefined;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(binding)));
  const bindingHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  const usedAt = new Date().toISOString();
  const result = await db.prepare(
    'UPDATE auth_challenges SET used_at = ? WHERE id = ? AND kind = ? AND browser_binding_hash = ? AND used_at IS NULL AND expires_at > ?',
  ).bind(usedAt, id, kind, bindingHash, usedAt).run();
  if ((result.meta?.changes ?? 0) !== 1) return undefined;
  return (await db.prepare(
    'SELECT id, kind, mode, challenge, user_id AS userId, display_name AS displayName, passkey_label AS passkeyLabel, invite_code_hash AS inviteCodeHash, device_link_code_hash AS deviceLinkCodeHash FROM auth_challenges WHERE id = ?',
  ).bind(id).first<ChallengeRow>()) ?? undefined;
};

export const consumeStepUpChallenge = async (db: D1DatabaseLike, id: string, userId: string): Promise<StepUpChallengeRow | undefined> => {
  const usedAt = new Date().toISOString();
  const result = await db.prepare(
    'UPDATE auth_step_up_challenges SET used_at = ? WHERE id = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?',
  ).bind(usedAt, id, userId, usedAt).run();
  if ((result.meta?.changes ?? 0) !== 1) return undefined;
  return (await db.prepare('SELECT id, challenge, user_id AS userId FROM auth_step_up_challenges WHERE id = ?').bind(id).first<StepUpChallengeRow>()) ?? undefined;
};

export const challengeExpiry = (): string => new Date(Date.now() + CHALLENGE_TTL_MS).toISOString();

export const pruneChallenges = async (database: D1DatabaseLike): Promise<void> => {
  const now = new Date();
  const oldUsedAt = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const oldRateLimitAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
  await database.batch([
    database.prepare('DELETE FROM auth_challenges WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)').bind(now.toISOString(), oldUsedAt),
    database.prepare('DELETE FROM auth_step_up_challenges WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)').bind(now.toISOString(), oldUsedAt),
    database.prepare('DELETE FROM auth_rate_limits WHERE window_started_at <= ?').bind(oldRateLimitAt),
    database.prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)').bind(now.toISOString(), oldUsedAt),
  ]);
};

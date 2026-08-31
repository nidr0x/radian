import { enforceAuthRateLimit, getAuthenticatedContext, isRecord, json, randomId, requireAuthConfiguration, requireDatabase } from './auth';
import type { AuthenticatedContext } from './auth';
import type { D1DatabaseLike, SyncContext } from '../types';

export { randomId } from './auth';

export const MCP_READ_SCOPE = 'radian:read';
export const MCP_OFFLINE_SCOPE = 'offline_access';
export const MCP_SCOPES = [MCP_READ_SCOPE, MCP_OFFLINE_SCOPE] as const;

const AUTHORIZATION_REQUEST_TTL_MS = 10 * 60 * 1000;
const AUTHORIZATION_CODE_TTL_MS = 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface McpClientRow {
  clientId: string;
  clientName: string;
  redirectUris: string;
}

export interface McpAuthorizationRequestRow {
  id: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state?: string;
  csrfTokenHash: string;
  expiresAt: string;
}

export interface McpAuthorizationCodeRow {
  codeHash: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: string;
}

export interface McpTokenRow {
  tokenHash: string;
  tokenType: 'access' | 'refresh';
  clientId: string;
  userId: string;
  scope: string;
  expiresAt: string;
}

export interface McpAuthenticatedRequest {
  database: D1DatabaseLike;
  userId: string;
  scope: string;
}

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

export const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const pkceChallengeFor = async (verifier: string): Promise<string> => encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));

export const mcpOrigin = (context: SyncContext): string => context.env.MCP_ORIGIN?.trim().replace(/\/$/, '') || new URL(context.request.url).origin;

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'WWW-Authenticate',
};

export const mcpJson = (body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response => json(body, status, { ...corsHeaders, ...extraHeaders });

export const mcpOptions = (): Response => new Response(null, { status: 204, headers: corsHeaders });

export const mcpUnauthorized = (context: SyncContext): Response => mcpJson(
  { error: 'unauthorized', message: 'Autoriza Radian antes de consultar tus entrenamientos.' },
  401,
  { 'WWW-Authenticate': `Bearer realm="radian", resource_metadata="${mcpOrigin(context)}/.well-known/oauth-protected-resource"` },
);

export const oauthError = (error: string, description: string, status = 400): Response => mcpJson({ error, error_description: description }, status);

export const htmlResponse = (html: string, status = 200): Response => new Response(html, {
  status,
  headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8' },
});

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[character] ?? character);

export const isAllowedRedirectUri = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (url.hash || !url.pathname) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
};

export const parseRedirectUris = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10) return undefined;
  const uris = value.filter((uri): uri is string => typeof uri === 'string' && isAllowedRedirectUri(uri));
  return uris.length === value.length ? [...new Set(uris)] : undefined;
};

export const normalizeScope = (value: string | undefined): string | undefined => {
  const requested = new Set((value ?? MCP_READ_SCOPE).split(/\s+/).filter(Boolean));
  if (![...requested].every((scope) => MCP_SCOPES.includes(scope as typeof MCP_SCOPES[number]))) return undefined;
  if (!requested.has(MCP_READ_SCOPE)) return undefined;
  return [MCP_READ_SCOPE, requested.has(MCP_OFFLINE_SCOPE) ? MCP_OFFLINE_SCOPE : undefined].filter(Boolean).join(' ');
};

export const parseForm = async (request: Request): Promise<URLSearchParams> => new URLSearchParams(await request.text());

export const requireMcpDatabase = (context: SyncContext): D1DatabaseLike | Response => {
  const configurationError = requireAuthConfiguration(context);
  if (configurationError) return configurationError;
  return requireDatabase(context);
};

export const readClient = async (database: D1DatabaseLike, clientId: string): Promise<McpClientRow | null> => database.prepare(
  'SELECT client_id AS clientId, client_name AS clientName, redirect_uris AS redirectUris FROM mcp_clients WHERE client_id = ?',
).bind(clientId).first<McpClientRow>();

export const clientAllowsRedirect = (client: McpClientRow, redirectUri: string): boolean => {
  try {
    const redirectUris: unknown = JSON.parse(client.redirectUris);
    return Array.isArray(redirectUris) && redirectUris.includes(redirectUri);
  } catch {
    return false;
  }
};

export const redirectResponse = (redirectUri: string, values: Record<string, string | undefined>): Response => {
  const url = new URL(redirectUri);
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined) url.searchParams.set(key, value);
  });
  return Response.redirect(url.toString(), 302);
};

export const currentMcpUser = async (context: SyncContext): Promise<AuthenticatedContext | Response> => getAuthenticatedContext(context);

export const storeAuthorizationRequest = async (database: D1DatabaseLike, values: {
  id: string;
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state?: string;
  csrfTokenHash: string;
}): Promise<void> => {
  const expiresAt = new Date(Date.now() + AUTHORIZATION_REQUEST_TTL_MS).toISOString();
  await database.prepare(
    `INSERT INTO mcp_authorization_requests
      (id, client_id, user_id, redirect_uri, code_challenge, scope, state, csrf_token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(values.id, values.clientId, values.userId, values.redirectUri, values.codeChallenge, values.scope, values.state ?? null, values.csrfTokenHash, expiresAt).run();
};

export const readAuthorizationRequest = async (database: D1DatabaseLike, id: string): Promise<McpAuthorizationRequestRow | null> => database.prepare(
  `SELECT id, client_id AS clientId, user_id AS userId, redirect_uri AS redirectUri,
          code_challenge AS codeChallenge, scope, state, csrf_token_hash AS csrfTokenHash, expires_at AS expiresAt
     FROM mcp_authorization_requests WHERE id = ?`,
).bind(id).first<McpAuthorizationRequestRow>();

export const createAuthorizationCode = async (database: D1DatabaseLike, request: McpAuthorizationRequestRow): Promise<string> => {
  const code = randomId(32);
  await database.batch([
    database.prepare(
      `INSERT INTO mcp_authorization_codes
        (code_hash, client_id, user_id, redirect_uri, code_challenge, scope, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(await sha256(code), request.clientId, request.userId, request.redirectUri, request.codeChallenge, request.scope, new Date().toISOString(), new Date(Date.now() + AUTHORIZATION_CODE_TTL_MS).toISOString()),
    database.prepare('DELETE FROM mcp_authorization_requests WHERE id = ?').bind(request.id),
  ]);
  return code;
};

const insertTokens = async (database: D1DatabaseLike, clientId: string, userId: string, scope: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> => {
  const accessToken = randomId(32);
  const refreshToken = randomId(32);
  const now = new Date().toISOString();
  const accessExpiresAt = new Date(Date.now() + ACCESS_TOKEN_TTL_MS).toISOString();
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_MS).toISOString();
  await database.batch([
    database.prepare(
      'INSERT INTO mcp_tokens (token_hash, token_type, client_id, user_id, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(await sha256(accessToken), 'access', clientId, userId, scope, now, accessExpiresAt),
    database.prepare(
      'INSERT INTO mcp_tokens (token_hash, token_type, client_id, user_id, scope, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(await sha256(refreshToken), 'refresh', clientId, userId, scope, now, refreshExpiresAt),
  ]);
  return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000) };
};

export const exchangeAuthorizationCode = async (database: D1DatabaseLike, values: {
  code: string;
  clientId: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string } | undefined> => {
  const row = await database.prepare(
    `SELECT code_hash AS codeHash, client_id AS clientId, user_id AS userId, redirect_uri AS redirectUri,
            code_challenge AS codeChallenge, scope, expires_at AS expiresAt
       FROM mcp_authorization_codes
      WHERE code_hash = ? AND client_id = ? AND redirect_uri = ? AND expires_at > ? AND used_at IS NULL`,
  ).bind(await sha256(values.code), values.clientId, values.redirectUri, new Date().toISOString()).first<McpAuthorizationCodeRow>();
  if (!row || row.codeChallenge !== await pkceChallengeFor(values.codeVerifier)) return undefined;
  const result = await database.prepare(
    'UPDATE mcp_authorization_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?',
  ).bind(new Date().toISOString(), row.codeHash, new Date().toISOString()).run();
  if ((result.meta?.changes ?? 0) !== 1) return undefined;
  return { ...(await insertTokens(database, row.clientId, row.userId, row.scope)), scope: row.scope };
};

export const exchangeRefreshToken = async (database: D1DatabaseLike, values: { refreshToken: string; clientId: string }): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string } | undefined> => {
  const row = await database.prepare(
    `SELECT token_hash AS tokenHash, token_type AS tokenType, client_id AS clientId, user_id AS userId,
            scope, expires_at AS expiresAt
       FROM mcp_tokens
      WHERE token_hash = ? AND token_type = 'refresh' AND client_id = ? AND expires_at > ? AND revoked_at IS NULL`,
  ).bind(await sha256(values.refreshToken), values.clientId, new Date().toISOString()).first<McpTokenRow>();
  if (!row) return undefined;
  const revokedAt = new Date().toISOString();
  const result = await database.prepare(
    `UPDATE mcp_tokens SET revoked_at = ?
      WHERE token_hash = ? AND token_type = 'refresh' AND revoked_at IS NULL AND expires_at > ?`,
  ).bind(revokedAt, row.tokenHash, revokedAt).run();
  if ((result.meta?.changes ?? 0) !== 1) return undefined;
  return { ...(await insertTokens(database, row.clientId, row.userId, row.scope)), scope: row.scope };
};

export const authenticateMcpRequest = async (context: SyncContext): Promise<McpAuthenticatedRequest | Response> => {
  const authorization = context.request.headers.get('Authorization') ?? '';
  const match = authorization.match(/^Bearer\s+([^\s]+)$/i);
  if (!match) return mcpUnauthorized(context);
  const database = requireMcpDatabase(context);
  if (database instanceof Response) return database;
  const tokenHash = await sha256(match[1]);
  const row = await database.prepare(
    `SELECT token_hash AS tokenHash, token_type AS tokenType, client_id AS clientId,
            user_id AS userId, scope, expires_at AS expiresAt
       FROM mcp_tokens
      WHERE token_hash = ? AND token_type = 'access' AND expires_at > ? AND revoked_at IS NULL`,
  ).bind(tokenHash, new Date().toISOString()).first<McpTokenRow>();
  if (!row || !row.scope.split(/\s+/).includes(MCP_READ_SCOPE)) return mcpUnauthorized(context);
  return { database, userId: row.userId, scope: row.scope };
};

export const rateLimitMcp = (context: SyncContext, route: string): Promise<Response | undefined> => enforceAuthRateLimit(context, `mcp-${route}`);

export const isRecordValue = (value: unknown): value is Record<string, unknown> => isRecord(value);

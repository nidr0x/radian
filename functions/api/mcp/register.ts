import { mcpJson, mcpOptions, normalizeScope, parseRedirectUris, randomId, rateLimitMcp, requireMcpDatabase, isRecordValue } from '../../lib/mcpAuth';
import type { SyncContext } from '../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const database = requireMcpDatabase(context);
  if (database instanceof Response) return database;
  const rateLimitResponse = await rateLimitMcp(context, 'register');
  if (rateLimitResponse) return rateLimitResponse;

  const body: unknown = await context.request.json().catch(() => undefined);
  if (!isRecordValue(body)) return mcpJson({ error: 'invalid_client_metadata', error_description: 'El registro del cliente no es válido.' }, 400);
  const clientName = typeof body.client_name === 'string' && body.client_name.trim() ? body.client_name.trim().slice(0, 120) : 'Cliente MCP';
  const redirectUris = parseRedirectUris(body.redirect_uris);
  if (!redirectUris) return mcpJson({ error: 'invalid_redirect_uri', error_description: 'Se necesita al menos una URL de retorno HTTPS válida.' }, 400);
  const clientId = randomId(18);
  await database.prepare(
    'INSERT INTO mcp_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)',
  ).bind(clientId, clientName, JSON.stringify(redirectUris), new Date().toISOString()).run();
  return mcpJson({
    client_id: clientId,
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: normalizeScope(undefined),
    client_id_issued_at: Math.floor(Date.now() / 1000),
  }, 201);
};

export const onRequestOptions = (): Response => mcpOptions();

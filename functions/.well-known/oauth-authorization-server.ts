import { mcpJson, mcpOrigin, MCP_OFFLINE_SCOPE, MCP_READ_SCOPE } from '../lib/mcpAuth';
import type { SyncContext } from '../types';

export const onRequestGet = (context: SyncContext): Response => {
  const origin = mcpOrigin(context);
  return mcpJson({
    issuer: origin,
    authorization_endpoint: `${origin}/api/mcp/authorize`,
    token_endpoint: `${origin}/api/mcp/token`,
    registration_endpoint: `${origin}/api/mcp/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: [MCP_READ_SCOPE, MCP_OFFLINE_SCOPE],
  });
};

export const onRequestOptions = (): Response => new Response(null, { status: 204 });

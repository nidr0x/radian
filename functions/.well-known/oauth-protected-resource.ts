import { mcpJson, mcpOrigin, MCP_READ_SCOPE, MCP_WRITE_SCOPE } from '../lib/mcpAuth';
import type { SyncContext } from '../types';

export const onRequestGet = (context: SyncContext): Response => {
  const origin = mcpOrigin(context);
  return mcpJson({
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: [MCP_READ_SCOPE, MCP_WRITE_SCOPE],
    bearer_methods_supported: ['header'],
  });
};

export const onRequestOptions = (): Response => new Response(null, { status: 204 });

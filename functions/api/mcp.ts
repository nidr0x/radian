import { authenticateMcpRequest, hasMcpScope, mcpJson, mcpOptions, MCP_READ_SCOPE, MCP_WRITE_SCOPE } from '../lib/mcpAuth';
import {
  handleMcpTool,
  isMcpReadTool,
  isMcpWriteTool,
  listMcpToolsForScope,
  loadMcpUserData,
  writeMcpData,
} from '../lib/mcp';
import { validateMcpWriteOperation, validateMcpWriteRequest } from '../lib/mcpWrite';
import type { SyncContext } from '../types';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2026-07-28'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isIsoTimestamp = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const rpcError = (id: unknown, code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } });
const hasRpcId = (body: Record<string, unknown>): boolean => Object.prototype.hasOwnProperty.call(body, 'id');
const rpcResponse = (body: Record<string, unknown>, result: unknown, protocolVersion?: string): Response => mcpJson({ jsonrpc: '2.0', id: body.id, result }, 200, protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {});
const toolResult = (body: Record<string, unknown>, value: unknown): Response => rpcResponse(body, {
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  structuredContent: value,
  isError: false,
});
const toolError = (body: Record<string, unknown>, message: string, structuredContent: Record<string, unknown>): Response => rpcResponse(body, {
  content: [{ type: 'text', text: message }],
  structuredContent,
  isError: true,
});
type ControlledWriteError = {
  error: 'change_unavailable' | 'conflict' | 'confirmation_required' | 'needs_version';
  message: string;
} & Record<string, unknown>;

const validateWriteCall = (
  toolName: string,
  args: Record<string, unknown>,
  authenticated: { userId: string; clientId: string },
): { baseUpdatedAt: string | undefined; operation: ReturnType<typeof validateMcpWriteOperation> } => {
  const { baseUpdatedAt, ...operationArgs } = args;
  const request = {
    userId: authenticated.userId,
    clientId: authenticated.clientId,
    baseUpdatedAt,
    operation: {
      kind: toolName,
      ...operationArgs,
    },
  };

  if (toolName === 'record_workout') {
    if (baseUpdatedAt !== undefined && (typeof baseUpdatedAt !== 'string' || !isIsoTimestamp(baseUpdatedAt))) {
      throw new Error('baseUpdatedAt debe ser una fecha ISO válida.');
    }
    const operation = validateMcpWriteOperation(request.operation);
    return { baseUpdatedAt: typeof baseUpdatedAt === 'string' ? baseUpdatedAt : undefined, operation };
  }

  const validated = validateMcpWriteRequest(request);
  return { baseUpdatedAt: validated.baseUpdatedAt, operation: validated.operation };
};

const asControlledWriteError = (value: unknown): ControlledWriteError | null => {
  if (!isRecord(value) || typeof value.error !== 'string' || typeof value.message !== 'string') return null;
  if (['change_unavailable', 'conflict', 'confirmation_required', 'needs_version'].includes(value.error)) return value as ControlledWriteError;
  return null;
};

const initializeResult = (body: Record<string, unknown>) => {
  const params = isRecord(body.params) ? body.params : {};
  const requested = typeof params.protocolVersion === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_PROTOCOL_VERSIONS[0];
  return {
    protocolVersion: requested,
    capabilities: { tools: {} },
    serverInfo: { name: 'radian-training', version: '1.0.0' },
    instructions: `Servidor de solo lectura de Radian. Alcance autorizado: ${MCP_READ_SCOPE}.`,
  };
};

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const authenticated = await authenticateMcpRequest(context);
  if (authenticated instanceof Response) return authenticated;
  const body: unknown = await context.request.json().catch(() => undefined);
  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return mcpJson(rpcError(null, -32600, 'La solicitud MCP no es válida.'), 400);
  if (!hasRpcId(body) && body.method.startsWith('notifications/')) return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  if (!hasRpcId(body)) return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });

  if (body.method === 'initialize') return rpcResponse(body, initializeResult(body), initializeResult(body).protocolVersion);
  if (body.method === 'ping') return rpcResponse(body, {});
  if (body.method === 'tools/list') return rpcResponse(body, { tools: listMcpToolsForScope(authenticated.scope) });
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  if (body.method !== 'tools/call') return mcpJson(rpcError(body.id, -32601, 'Método MCP no disponible.'), 404);

  const params = isRecord(body.params) ? body.params : {};
  if (typeof params.name !== 'string' || (!isMcpReadTool(params.name) && !isMcpWriteTool(params.name))) {
    return mcpJson(rpcError(body.id, -32602, 'La herramienta solicitada no está disponible.'), 400);
  }
  const args = isRecord(params.arguments) ? params.arguments : {};

  if (isMcpWriteTool(params.name)) {
    if (!hasMcpScope(authenticated.scope, MCP_WRITE_SCOPE)) {
      return toolError(body, `La herramienta ${params.name} requiere el scope ${MCP_WRITE_SCOPE}.`, {
        error: 'insufficient_scope',
        requiredScope: MCP_WRITE_SCOPE,
        tool: params.name,
      });
    }

    try {
      const validated = validateWriteCall(params.name, args, authenticated);
      const value = await writeMcpData(
        authenticated.database,
        authenticated.userId,
        authenticated.clientId,
        validated.baseUpdatedAt,
        validated.operation,
      );
      const controlledError = asControlledWriteError(value);
      return controlledError ? toolError(body, controlledError.message, controlledError) : toolResult(body, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'No se pudo validar la mutación.';
      return mcpJson(rpcError(body.id, -32602, message), 400);
    }
  }

  try {
    const data = await loadMcpUserData(authenticated.database, authenticated.userId);
    const value = await handleMcpTool(params.name, args, data);
    return toolResult(body, value);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'No se pudo completar la consulta.';
    return rpcResponse(body, { content: [{ type: 'text', text: message }], isError: true });
  }
};

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const authenticated = await authenticateMcpRequest(context);
  if (authenticated instanceof Response) return authenticated;
  return mcpJson({ error: 'method_not_allowed', message: 'Usa POST para enviar mensajes MCP.' }, 405, { Allow: 'POST, OPTIONS' });
};

export const onRequestOptions = (): Response => mcpOptions();

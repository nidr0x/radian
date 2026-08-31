import { authenticateMcpRequest, mcpJson, mcpOptions, MCP_READ_SCOPE } from '../lib/mcpAuth';
import { handleMcpTool, loadMcpUserData, MCP_TOOL_DEFINITIONS } from '../lib/mcp';
import type { SyncContext } from '../types';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2026-07-28'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const rpcError = (id: unknown, code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } });
const hasRpcId = (body: Record<string, unknown>): boolean => Object.prototype.hasOwnProperty.call(body, 'id');
const rpcResponse = (body: Record<string, unknown>, result: unknown, protocolVersion?: string): Response => mcpJson({ jsonrpc: '2.0', id: body.id, result }, 200, protocolVersion ? { 'MCP-Protocol-Version': protocolVersion } : {});

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
  if (body.method === 'tools/list') return rpcResponse(body, { tools: MCP_TOOL_DEFINITIONS });
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  if (body.method !== 'tools/call') return mcpJson(rpcError(body.id, -32601, 'Método MCP no disponible.'), 404);

  const params = isRecord(body.params) ? body.params : {};
  if (typeof params.name !== 'string' || !MCP_TOOL_DEFINITIONS.some((tool) => tool.name === params.name)) return mcpJson(rpcError(body.id, -32602, 'La herramienta solicitada no está disponible.'), 400);
  const args = isRecord(params.arguments) ? params.arguments : {};
  try {
    const data = await loadMcpUserData(authenticated.database, authenticated.userId);
    const value = await handleMcpTool(params.name, args, data);
    return rpcResponse(body, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value, isError: false });
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

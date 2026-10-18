import { authenticateMcpRequest, hasMcpScope, mcpJson, mcpOptions, MCP_WRITE_SCOPE } from '../lib/mcpAuth';
import {
  handleMcpTool,
  MCP_WRITE_TOOL_DEFINITIONS,
  isMcpReadTool,
  isMcpWriteTool,
  listMcpToolsForScope,
  MCP_AUDIT_TOOL_DEFINITION,
  loadMcpUserData,
  writeMcpData,
} from '../lib/mcp';
import { validateMcpWriteOperation } from '../lib/mcpWrite';
import { listMcpAudit } from '../lib/mcpReceipts';
import type { SyncContext } from '../types';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2026-07-28'];
const MCP_RUNTIME_ERROR_CODE = -32000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isIsoTimestamp = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const rpcError = (id: unknown, code: number, message: string, data?: Record<string, unknown>): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id,
  error: data ? { code, message, data } : { code, message },
});
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

interface McpInputSchema {
  type: 'array' | 'boolean' | 'integer' | 'object' | 'string';
  properties?: Record<string, McpInputSchema>;
  required?: string[];
  additionalProperties?: boolean;
  pattern?: string;
  minLength?: number;
  minimum?: number;
  maximum?: number;
  enum?: readonly string[];
}

const assertWriteSchema = (value: unknown, schema: McpInputSchema, label: string): void => {
  if (schema.type === 'object') {
    if (!isRecord(value)) throw new Error(`${label} no es válido.`);
    const record = value;
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in record)) throw new Error(`${label} requiere ${key}.`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      const extras = Object.keys(record).filter((key) => !(key in schema.properties!));
      if (extras.length > 0) throw new Error(`${label} contiene propiedades desconocidas: ${extras.join(', ')}.`);
    }
    if (schema.properties) {
      for (const [key, propertySchema] of Object.entries(schema.properties)) {
        if (key in record) assertWriteSchema(record[key], propertySchema, `${label}.${key}`);
      }
    }
    return;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new Error(`${label} debe ser texto.`);
    if (schema.minLength !== undefined && value.length < schema.minLength) throw new Error(`${label} no puede estar vacío.`);
    if (schema.pattern && !(new RegExp(schema.pattern).test(value) && (!label.endsWith('baseUpdatedAt') || isIsoTimestamp(value)))) {
      throw new Error(`${label} no es válido.`);
    }
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`${label} no es válido.`);
    return;
  }

  if (schema.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${label} debe ser booleano.`);
    return;
  }

  if (schema.type === 'integer') {
    if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${label} debe ser un entero.`);
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`${label} no es válido.`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`${label} no es válido.`);
    return;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${label} debe ser una lista.`);
    return;
  }
};

const validatedWriteOperation = (toolName: string, args: Record<string, unknown>) => {
  const definition = MCP_WRITE_TOOL_DEFINITIONS.find((tool) => tool.name === toolName);
  if (!definition) throw new Error('La herramienta solicitada no está disponible.');
  assertWriteSchema(args, definition.inputSchema as McpInputSchema, 'arguments');
  const { baseUpdatedAt: _baseUpdatedAt, idempotencyKey: _idempotencyKey, ...operationArgs } = args;
  return validateMcpWriteOperation({ kind: toolName, ...operationArgs });
};

const validateWriteCall = (
  toolName: string,
  args: Record<string, unknown>,
): { baseUpdatedAt: string | undefined; operation: ReturnType<typeof validateMcpWriteOperation> } => {
  const operation = validatedWriteOperation(toolName, args);
  return { baseUpdatedAt: typeof args.baseUpdatedAt === 'string' ? args.baseUpdatedAt : undefined, operation };
};

const asControlledWriteError = (value: unknown): ControlledWriteError | null => {
  if (!isRecord(value) || typeof value.error !== 'string' || typeof value.message !== 'string') return null;
  if (['change_unavailable', 'conflict', 'confirmation_required', 'needs_version'].includes(value.error)) return value as ControlledWriteError;
  return null;
};

const hasBearerSyntax = (request: Request): boolean => /^Bearer\s+[^\s]+$/i.test(request.headers.get('Authorization') ?? '');
const MAX_MCP_BODY_BYTES = 1_000_000;

const readBoundedJson = async (request: Request): Promise<unknown> => {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MCP_BODY_BYTES) throw new Error('BODY_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_MCP_BODY_BYTES) {
      await reader.cancel();
      throw new Error('BODY_TOO_LARGE');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
};

const validateWriteSchema = (toolName: string, args: Record<string, unknown>): void => {
  const definition = MCP_WRITE_TOOL_DEFINITIONS.find((tool) => tool.name === toolName);
  if (!definition) throw new Error('La herramienta solicitada no está disponible.');
  assertWriteSchema(args, definition.inputSchema as McpInputSchema, 'arguments');
};

const initializeResult = (body: Record<string, unknown>, scope: string) => {
  const params = isRecord(body.params) ? body.params : {};
  const requested = typeof params.protocolVersion === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED_PROTOCOL_VERSIONS[0];
  const writeEnabled = hasMcpScope(scope, MCP_WRITE_SCOPE);
  const scopeSummary = writeEnabled ? 'lectura y escritura' : 'solo lectura';
  return {
    protocolVersion: requested,
    capabilities: { tools: {} },
    serverInfo: { name: 'radian-training', version: '1.0.0' },
    instructions: `Servidor de ${scopeSummary} de Radian. Alcance autorizado en esta sesión: ${scope}.`,
  };
};

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  let body: unknown;
  try {
    body = await readBoundedJson(context.request);
  } catch (error) {
    const tooLarge = error instanceof Error && error.message === 'BODY_TOO_LARGE';
    return mcpJson(rpcError(null, tooLarge ? -32600 : -32700, tooLarge ? 'La solicitud MCP supera el tamaño permitido.' : 'La solicitud MCP no contiene JSON válido.'), tooLarge ? 413 : 400);
  }
  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return mcpJson(rpcError(null, -32600, 'La solicitud MCP no es válida.'), 400);
  if (!hasRpcId(body) && body.method.startsWith('notifications/')) return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  if (!hasRpcId(body)) return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });

  const params = isRecord(body.params) ? body.params : {};
  if (body.method === 'tools/call' && typeof params.name === 'string' && isMcpWriteTool(params.name)) {
    if (!hasBearerSyntax(context.request)) {
      const authenticated = await authenticateMcpRequest(context);
      return authenticated instanceof Response
        ? authenticated
        : mcpJson(rpcError(body.id, -32600, 'La solicitud MCP no es válida.'), 400);
    }

    const args = isRecord(params.arguments) ? params.arguments : {};
    try {
      validateWriteSchema(params.name, args);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'La mutación no es válida.';
      return mcpJson(rpcError(body.id, -32602, message), 400);
    }
  }

  const authenticated = await authenticateMcpRequest(context);
  if (authenticated instanceof Response) return authenticated;

  if (body.method === 'initialize') {
    const result = initializeResult(body, authenticated.scope);
    return rpcResponse(body, result, result.protocolVersion);
  }
  if (body.method === 'ping') return rpcResponse(body, {});
  if (body.method === 'tools/list') return rpcResponse(body, { tools: listMcpToolsForScope(authenticated.scope) });
  if (body.method === 'notifications/initialized') return new Response(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });
  if (body.method !== 'tools/call') return mcpJson(rpcError(body.id, -32601, 'Método MCP no disponible.'), 404);

  const args = isRecord(params.arguments) ? params.arguments : {};
  if (params.name === MCP_AUDIT_TOOL_DEFINITION.name) {
    if (Object.keys(args).length) return mcpJson(rpcError(body.id, -32602, 'Esta consulta no admite parámetros.'), 400);
    try {
      return toolResult(body, await listMcpAudit(authenticated.database, authenticated.userId));
    } catch {
      return mcpJson(rpcError(body.id, MCP_RUNTIME_ERROR_CODE, 'No se pudo consultar el historial de cambios.'));
    }
  }
  if (typeof params.name !== 'string' || (!isMcpReadTool(params.name) && !isMcpWriteTool(params.name))) {
    return mcpJson(rpcError(body.id, -32602, 'La herramienta solicitada no está disponible.'), 400);
  }
  if (isMcpWriteTool(params.name)) {
    if (!hasMcpScope(authenticated.scope, MCP_WRITE_SCOPE)) {
      return toolError(body, `La herramienta ${params.name} requiere el scope ${MCP_WRITE_SCOPE}.`, {
        error: 'insufficient_scope',
        requiredScope: MCP_WRITE_SCOPE,
        tool: params.name,
      });
    }

    const validated = validateWriteCall(params.name, args);

    try {
      const value = await writeMcpData(
        authenticated.database,
        authenticated.userId,
        authenticated.clientId,
        validated.baseUpdatedAt,
        validated.operation,
        typeof args.idempotencyKey === 'string' ? args.idempotencyKey : undefined,
      );
      const controlledError = asControlledWriteError(value);
      return controlledError
        ? mcpJson(rpcError(body.id, MCP_RUNTIME_ERROR_CODE, controlledError.message, controlledError))
        : toolResult(body, value);
    } catch {
      return mcpJson(rpcError(body.id, MCP_RUNTIME_ERROR_CODE, 'No se pudo ejecutar la mutación solicitada.', {
        error: 'tool_execution_failed',
        tool: params.name,
      }));
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

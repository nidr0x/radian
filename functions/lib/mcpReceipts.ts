import type { D1DatabaseLike, McpMutationResult } from '../types';
import { sha256 } from './mcpAuth';

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
export const requestFingerprint = (value: unknown): Promise<string> => sha256(JSON.stringify(canonical(value)));

export const readReceipt = async (db: D1DatabaseLike, userId: string, clientId: string, key: string, fingerprint: string): Promise<McpMutationResult | undefined> => {
  const receipt = await db.prepare('SELECT fingerprint, result FROM mcp_write_receipts WHERE user_id = ? AND client_id = ? AND request_key = ?').bind(userId, clientId, key).first<{ fingerprint: string; result: string }>();
  if (!receipt) return undefined;
  if (receipt.fingerprint !== fingerprint) throw new Error('La clave de idempotencia ya se utilizó para otra solicitud.');
  return JSON.parse(receipt.result) as McpMutationResult;
};

// Must immediately follow the conditional mutation in the same D1 batch.
export const receiptStatement = (db: D1DatabaseLike, userId: string, clientId: string, key: string, fingerprint: string, tool: string, result: McpMutationResult) => db.prepare(`
  INSERT INTO mcp_write_receipts (user_id, client_id, request_key, fingerprint, tool, result, created_at)
  SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1
`).bind(userId, clientId, key, fingerprint, tool, JSON.stringify(result), result.updatedAt);

export const listMcpAudit = async (db: D1DatabaseLike, userId: string) => {
  const now = new Date().toISOString();
  await db.prepare("DELETE FROM mcp_write_receipts WHERE user_id = ? AND datetime(created_at) <= datetime(?, '-90 days')").bind(userId, now).run();
  const rows = await db.prepare(`SELECT tool, client_id AS clientId, created_at AS createdAt, result
    FROM mcp_write_receipts WHERE user_id = ? ORDER BY created_at DESC, request_key DESC LIMIT 100`).bind(userId).all<{ tool: string; clientId: string; createdAt: string; result: string }>();
  return { entries: rows.results.map(({ result, ...entry }) => ({ ...entry, revisionId: (JSON.parse(result) as McpMutationResult).revisionId })), limit: 100 };
};

import type { D1DatabaseLike, D1PreparedStatementLike } from '../../types';

export const RETENTION = {
  syncReplayDays: 30,
  mcpReplayDays: 90,
  auditDays: 365,
  terminalJobDays: 90,
  accountTombstoneDays: 365,
  rateLimitDays: 1,
} as const;

const LIMIT = 100;
const cutoff = (now: string, days: number): string => new Date(Date.parse(now) - days * 24 * 60 * 60 * 1000).toISOString();
const expired = (table: string, column: string): string =>
  `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column} <= ? ORDER BY ${column} LIMIT ?)`;
const expiredWith = (table: string, condition: string, order: string): string =>
  `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${condition} ORDER BY ${order} LIMIT ?)`;

export const cleanupExpiredOperationalRecords = async (
  database: D1DatabaseLike,
  at = new Date().toISOString(),
  requestedLimit = LIMIT,
): Promise<{ deleted: number; byTable: Record<string, number> }> => {
  const limit = Number.isSafeInteger(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 500)) : LIMIT;
  const statements: Array<{ name: string; statement: D1PreparedStatementLike }> = [
    { name: 'gym_pair_tombstones', statement: database.prepare(expired('gym_pair_tombstones', 'retain_until')).bind(at, limit) },
    { name: 'gym_mcp_pending_changes', statement: database.prepare(expired('gym_mcp_pending_changes', 'expires_at')).bind(at, limit) },
    { name: 'mcp_pending_changes', statement: database.prepare(expired('mcp_pending_changes', 'expires_at')).bind(at, limit) },
    { name: 'gym_sync_receipts', statement: database.prepare(expired('gym_sync_receipts', 'created_at')).bind(cutoff(at, RETENTION.syncReplayDays), limit) },
    { name: 'gym_sync_changes', statement: database.prepare(expired('gym_sync_changes', 'created_at')).bind(cutoff(at, RETENTION.syncReplayDays), limit) },
    { name: 'gym_sync_tombstones', statement: database.prepare(expired('gym_sync_tombstones', 'deleted_at')).bind(cutoff(at, RETENTION.accountTombstoneDays), limit) },
    { name: 'gym_mcp_operations', statement: database.prepare(expired('gym_mcp_operations', 'created_at')).bind(cutoff(at, RETENTION.mcpReplayDays), limit) },
    { name: 'gym_mcp_audit', statement: database.prepare(expired('gym_mcp_audit', 'created_at')).bind(cutoff(at, RETENTION.auditDays), limit) },
    { name: 'gym_admin_audit', statement: database.prepare(expired('gym_admin_audit', 'created_at')).bind(cutoff(at, RETENTION.auditDays), limit) },
    { name: 'gym_durable_jobs', statement: database.prepare(expiredWith('gym_durable_jobs', "status IN ('succeeded', 'failed', 'cancelled') AND updated_at <= ?", 'updated_at')).bind(cutoff(at, RETENTION.terminalJobDays), limit) },
    { name: 'gym_mcp_revisions', statement: database.prepare(expired('gym_mcp_revisions', 'expires_at')).bind(at, limit) },
    { name: 'gym_device_link_codes', statement: database.prepare(expiredWith('gym_device_link_codes', 'expires_at <= ? OR used_at <= ?', 'expires_at')).bind(at, cutoff(at, RETENTION.mcpReplayDays), limit) },
    { name: 'user_data_revisions', statement: database.prepare(expired('user_data_revisions', 'expires_at')).bind(at, limit) },
    { name: 'mcp_write_receipts', statement: database.prepare(expired('mcp_write_receipts', 'created_at')).bind(cutoff(at, RETENTION.mcpReplayDays), limit) },
    { name: 'sync_records', statement: database.prepare(expired('sync_records', 'expires_at')).bind(at, limit) },
    { name: 'auth_challenges', statement: database.prepare(expired('auth_challenges', 'expires_at')).bind(at, limit) },
    { name: 'auth_step_up_challenges', statement: database.prepare(expired('auth_step_up_challenges', 'expires_at')).bind(at, limit) },
    { name: 'auth_sessions', statement: database.prepare(expiredWith('auth_sessions', 'expires_at <= ? OR revoked_at <= ?', 'expires_at')).bind(at, cutoff(at, RETENTION.syncReplayDays), limit) },
    { name: 'auth_rate_limits', statement: database.prepare(expired('auth_rate_limits', 'window_started_at')).bind(cutoff(at, RETENTION.rateLimitDays), limit) },
  ];
  const results = await database.batch(statements.map(({ statement }) => statement));
  const byTable = Object.fromEntries(statements.map(({ name }, index) => [name, Number(results[index]?.meta?.changes ?? 0)]));
  return { deleted: Object.values(byTable).reduce((sum, count) => sum + count, 0), byTable };
};

import { json } from '../../lib/auth';
import { auditRetention, requireAdmin } from '../../lib/radian-api/admin';
import type { SyncContext } from '../../types';

interface AuditRow {
  id: number;
  createdAt: string;
  event: string;
  ok: number;
  actorId: string | null;
  actorName: string;
  targetId: string | null;
  targetName: string | null;
  action: string | null;
  message: string | null;
  ip: string | null;
}

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const admin = await requireAdmin(context);
  if (admin instanceof Response) return admin;
  const query = new URL(context.request.url).searchParams;
  const parsedLimit = Number(query.get('limit'));
  const limit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 100;
  const parsedBefore = Number(query.get('before'));
  const before = Number.isSafeInteger(parsedBefore) && parsedBefore > 0 ? parsedBefore : null;
  const category = query.get('cat');
  const retention = auditRetention(context);
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (retention.days > 0) {
    clauses.push('created_at >= ?');
    values.push(new Date(Date.now() - retention.days * 86400000).toISOString());
  }
  if (retention.max > 0) {
    clauses.push('id IN (SELECT id FROM gym_admin_audit ORDER BY id DESC LIMIT ?)');
    values.push(retention.max);
  }
  if (category === 'fail') clauses.push('ok = 0');
  else if (category === 'auth' || category === 'admin') {
    clauses.push('event LIKE ?');
    values.push(`${category}.%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const database = admin.env.DB!;
  const total = await database.prepare(`SELECT COUNT(*) AS total FROM gym_admin_audit ${where}`).bind(...values).first<{ total: number }>();
  const pageClauses = [...clauses];
  const pageValues = [...values];
  if (before !== null) { pageClauses.push('id < ?'); pageValues.push(before); }
  const pageWhere = pageClauses.length ? `WHERE ${pageClauses.join(' AND ')}` : '';
  const page = await database.prepare(
    `SELECT id, created_at AS createdAt, event, ok, actor_account_id AS actorId, actor_name AS actorName,
            target_account_id AS targetId, target_name AS targetName, action, message, ip
       FROM gym_admin_audit ${pageWhere} ORDER BY id DESC LIMIT ?`,
  ).bind(...pageValues, limit + 1).all<AuditRow>();
  const hasMore = page.results.length > limit;
  const rows = hasMore ? page.results.slice(0, limit) : page.results;
  const events = rows.map((row) => ({
    id: row.id,
    ts: Date.parse(row.createdAt),
    ev: row.event,
    ok: row.ok === 1,
    ...(row.actorId ? { uid: row.actorId } : {}),
    ...(row.actorName ? { name: row.actorName } : {}),
    ...(row.targetId ? { tgt: row.targetId } : {}),
    ...(row.targetName ? { tname: row.targetName } : {}),
    ...(row.action ? { act: row.action } : {}),
    ...(row.message ? { msg: row.message } : {}),
    ...(row.ip ? { ip: row.ip } : {}),
  }));
  return json({
    events,
    total: total?.total ?? 0,
    nextBefore: hasMore ? rows.at(-1)?.id ?? null : null,
    enabled: context.env.AUDIT_LOG !== '0',
    ip_mode: retention.ipMode,
    retention: { max: retention.max, days: retention.days },
    now: Date.now(),
  });
};

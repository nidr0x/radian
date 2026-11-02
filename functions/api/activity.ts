import { enforceAuthRateLimit, getAuthenticatedContext, json } from '../lib/auth';
import { readSmallJson } from '../lib/radian-api/request';
import type { SyncContext } from '../types';

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);
const reasons = new Set(['navigated', 'closed', 'hidden']);

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'activity', authenticated.user.id);
  if (limited) return limited;
  const read = await readSmallJson(context.request, 4096);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const body = read.value;
  if (typeof body.active !== 'boolean') return error(400, 'invalid-request', '`active` must be a boolean.');
  if (body.reason !== undefined && (typeof body.reason !== 'string' || !reasons.has(body.reason))) {
    return error(400, 'invalid-request', '`reason` is not supported.');
  }

  const now = Date.now();
  const database = authenticated.env.DB!;
  const prune = database.prepare(
    `DELETE FROM gym_activity_presence
      WHERE account_id IN (
        SELECT account_id FROM gym_activity_presence
         WHERE updated_at <= ? OR (hidden_at IS NOT NULL AND hidden_at <= ?)
         ORDER BY updated_at LIMIT 100
      )`,
  ).bind(now - 70_000, now - 45_000);

  if (!body.active) {
    const mutation = body.reason === 'hidden'
      ? database.prepare('UPDATE gym_activity_presence SET hidden_at = COALESCE(hidden_at, ?) WHERE account_id = ?')
        .bind(now, authenticated.user.id)
      : database.prepare('DELETE FROM gym_activity_presence WHERE account_id = ?').bind(authenticated.user.id);
    try { await database.batch([prune, mutation]); }
    catch { return error(503, 'busy', 'Presence could not be updated.'); }
    return json({ ok: true });
  }

  const text = body.name;
  if (text !== undefined && (typeof text !== 'string' || text.length > 60)) return error(400, 'invalid-request', '`name` must be at most 60 characters.');
  const integer = (value: unknown, fallback: number, maximum: number): number | null => {
    if (value === undefined) return fallback;
    return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum ? value as number : null;
  };
  const exIdx = integer(body.exIdx, 0, 200);
  const exTotal = integer(body.exTotal, 0, 200);
  const setsDone = integer(body.setsDone, 0, 10_000);
  const setsTotal = integer(body.setsTotal, 0, 10_000);
  const startedAt = integer(body.startedAt, now, now + 5 * 60_000);
  if (exIdx === null || exTotal === null || setsDone === null || setsTotal === null || startedAt === null) {
    return error(400, 'invalid-request', 'Workout progress fields are not valid.');
  }

  try {
    await database.batch([
      prune,
      database.prepare(
        `INSERT INTO gym_activity_presence
         (account_id, name, ex_idx, ex_total, sets_done, sets_total, started_at, updated_at, hidden_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(account_id) DO UPDATE SET
           name = excluded.name, ex_idx = excluded.ex_idx, ex_total = excluded.ex_total,
           sets_done = excluded.sets_done, sets_total = excluded.sets_total,
           started_at = excluded.started_at, updated_at = excluded.updated_at, hidden_at = NULL`,
      ).bind(authenticated.user.id, typeof text === 'string' ? text : '', exIdx, exTotal, setsDone, setsTotal, startedAt, now),
    ]);
  } catch {
    return error(503, 'busy', 'Presence could not be updated.');
  }
  return json({ ok: true });
};

import { enforceAuthRateLimit, getAuthenticatedContext, isRecord, json } from '../../lib/auth';
import { MAX_SYNC_BATCH_BYTES, MAX_SYNC_BATCH_CHANGES, readGymRevision, writeGymChanges } from '../../lib/db/radian/state';
import { readSmallText } from '../../lib/radian-api/request';
import type { GymSyncChange } from '../../lib/db/radian/state';
import type { SyncContext } from '../../types';

const MAX_REQUEST_BYTES = MAX_SYNC_BATCH_BYTES + 1024;
interface ChangeRow { revision: number; writeId: string | null; fieldPath: string; valueJson: string | null; deleted: number }

const snapshotRequired = (rev: number, wid: string | null): Response => json({ version: 2, snapshotRequired: true, rev, wid });

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'sync-get', authenticated.user.id);
  if (limited) return limited;
  const url = new URL(context.request.url);
  const after = Number(url.searchParams.get('after'));
  const suppliedWid = url.searchParams.get('wid');
  if (url.searchParams.get('v') !== '2' || !Number.isSafeInteger(after) || after < 0
    || (suppliedWid !== null && suppliedWid.length > 128)) return json({ error: 'invalid_cursor' }, 400);
  const database = authenticated.env.DB!;
  const current = await readGymRevision(database, authenticated.user.id);
  if (after > current.rev || (after === current.rev && suppliedWid !== null && suppliedWid !== (current.wid ?? ''))) {
    return snapshotRequired(current.rev, current.wid);
  }
  if (after === current.rev) return json({ version: 2, rev: current.rev, wid: current.wid, changes: [], more: false });
  if (after > 0) {
    const base = await database.prepare(
      'SELECT write_id AS writeId FROM gym_sync_changes WHERE account_id = ? AND revision = ? ORDER BY ordinal LIMIT 1',
    ).bind(authenticated.user.id, after).first<{ writeId: string | null }>();
    if (!base?.writeId || (suppliedWid !== null && suppliedWid !== base.writeId)) return snapshotRequired(current.rev, current.wid);
  }
  const next = await database.prepare(
    'SELECT MIN(revision) AS revision FROM gym_sync_changes WHERE account_id = ? AND revision > ?',
  ).bind(authenticated.user.id, after).first<{ revision: number | null }>();
  if (next?.revision === null || next?.revision === undefined) return snapshotRequired(current.rev, current.wid);
  if (next.revision !== after + 1) return snapshotRequired(current.rev, current.wid);
  const rows = await database.prepare(
    `SELECT revision, write_id AS writeId, field_path AS fieldPath, value_json AS valueJson, deleted
       FROM gym_sync_changes WHERE account_id = ? AND revision = ? ORDER BY ordinal LIMIT ?`,
  ).bind(authenticated.user.id, next.revision, MAX_SYNC_BATCH_CHANGES + 1).all<ChangeRow>();
  if (!rows.results.length || rows.results.length > MAX_SYNC_BATCH_CHANGES || rows.results.some((row) => !row.writeId || row.fieldPath === '$document')) {
    return snapshotRequired(current.rev, current.wid);
  }
  const changes: GymSyncChange[] = [];
  let bytes = 0;
  try {
    for (const row of rows.results) {
      const value = JSON.parse(row.valueJson ?? row.fieldPath) as GymSyncChange;
      bytes += new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (bytes > MAX_SYNC_BATCH_BYTES) return snapshotRequired(current.rev, current.wid);
      changes.push(value);
    }
  } catch {
    return snapshotRequired(current.rev, current.wid);
  }
  return json({ version: 2, rev: next.revision, wid: rows.results[0].writeId, changes, more: next.revision < current.rev });
};

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'sync-put', authenticated.user.id);
  if (limited) return limited;
  const input = await readSmallText(context.request, MAX_REQUEST_BYTES);
  if (!input.ok) return json({ error: input.reason === 'too-large' ? 'payload_too_large' : 'invalid_json' }, input.reason === 'too-large' ? 413 : 400);
  let body: unknown;
  try { body = JSON.parse(input.value); } catch { return json({ error: 'invalid_json' }, 400); }
  if (!isRecord(body) || body.version !== 2 || !Number.isSafeInteger(body.baseRev)
    || typeof body.operationId !== 'string' || typeof body.baseWid !== 'string' && body.baseWid !== null
    || !Array.isArray(body.changes)) return json({ error: 'invalid_payload' }, 400);
  const result = await writeGymChanges(authenticated.env.DB!, authenticated.user.id, {
    baseRev: body.baseRev as number,
    baseWid: body.baseWid as string | null,
    operationId: body.operationId,
    changes: body.changes as GymSyncChange[],
  });
  if (!result.ok && 'conflict' in result) return json({ error: 'conflict', version: 2, ...result.conflict }, 409);
  if (!result.ok) return json({ error: result.error }, result.error === 'invalid_changes' || result.error === 'invalid_base_revision'
    || result.error === 'invalid_base_write_id' || result.error === 'invalid_operation_id' ? 400
    : result.error === 'media_cleanup_in_progress' ? 409 : 413);
  return json({ version: 2, rev: result.rev, wid: result.wid, replayed: result.replayed });
};

import { enforceAuthRateLimit, getAuthenticatedContext, json } from '../../lib/auth';
import { gymStateToChanges, MAX_SYNC_BATCH_BYTES, MAX_SYNC_BATCH_CHANGES, readGymState, type GymSyncChange } from '../../lib/db/radian/state';
import type { SyncContext } from '../../types';

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'sync-get', authenticated.user.id);
  if (limited) return limited;
  const url = new URL(context.request.url);
  const requestedRev = url.searchParams.get('rev');
  const requestedOffset = url.searchParams.get('offset');
  const requestedWid = url.searchParams.get('wid');
  const offset = requestedOffset === null ? 0 : Number(requestedOffset);
  if ((requestedRev !== null && (!Number.isSafeInteger(Number(requestedRev)) || Number(requestedRev) < 0))
    || !Number.isSafeInteger(offset) || offset < 0
    || (requestedWid !== null && requestedWid.length > 128)) return json({ error: 'invalid_cursor' }, 400);

  const snapshot = await readGymState(authenticated.env.DB!, authenticated.user.id);
  if (requestedRev !== null && (Number(requestedRev) !== snapshot.rev
    || (requestedWid !== null && requestedWid !== (snapshot.wid ?? '')))) {
    return json({ error: 'snapshot_changed', rev: snapshot.rev, wid: snapshot.wid }, 409);
  }
  const changes = snapshot.state ? gymStateToChanges(snapshot.state) : [];
  if (typeof changes === 'string') return json({ error: changes }, 413);
  if (offset > changes.length) return json({ error: 'invalid_cursor' }, 400);
  const page: GymSyncChange[] = [];
  let bytes = 0;
  for (const change of changes.slice(offset, offset + MAX_SYNC_BATCH_CHANGES)) {
    const size = new TextEncoder().encode(JSON.stringify(change)).byteLength;
    if (page.length && bytes + size > MAX_SYNC_BATCH_BYTES) break;
    if (size > MAX_SYNC_BATCH_BYTES) return json({ error: 'sync_change_too_large' }, 413);
    page.push(change);
    bytes += size;
  }
  const nextOffset = offset + page.length;
  return json({
    version: 2,
    rev: snapshot.rev,
    wid: snapshot.wid,
    offset,
    nextOffset: nextOffset < changes.length ? nextOffset : null,
    changes: page,
  });
};

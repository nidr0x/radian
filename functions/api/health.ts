import { json, requireDatabase } from '../lib/auth';
import type { SyncContext } from '../types';

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  try {
    await database.prepare('SELECT revision FROM gym_sync_state LIMIT 1').first<{ revision: number }>();
    return json({ ok: true, service: 'radian' });
  } catch {
    return json({ ok: false, service: 'radian', error: 'database_unavailable' }, 503);
  }
};

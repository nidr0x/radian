import { json, requireDatabase } from '../lib/auth';
import type { SyncContext } from '../types';

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  try {
    await database.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return json({ ok: true, service: 'radian', database: 'ok' });
  } catch {
    return json({ ok: false, service: 'radian', database: 'unavailable' }, 503);
  }
};

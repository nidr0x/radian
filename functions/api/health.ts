import { json, requireAuthConfiguration, requireDatabase } from '../lib/auth';
import type { SyncContext } from '../types';

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const configurationError = requireAuthConfiguration(context);
  if (configurationError) return json({ ok: false, service: 'radian', database: 'unknown', auth: 'unavailable' }, 503);
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  try {
    await database.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return json({ ok: true, service: 'radian', database: 'ok', auth: 'ok' });
  } catch {
    return json({ ok: false, service: 'radian', database: 'unavailable', auth: 'ok' }, 503);
  }
};

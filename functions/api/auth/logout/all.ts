import { clearSessionCookie, getAuthenticatedContext, json } from '../../../lib/auth';
import type { SyncContext } from '../../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const database = authenticated.env.DB;
  if (!database) return json({ error: 'database_unavailable', message: 'La cuenta en la nube todavía no está configurada.' }, 503);
  await database.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').bind(authenticated.user.id).run();
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(context) });
};

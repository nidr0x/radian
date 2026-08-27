import { clearSessionCookie, json, revokeCurrentSession } from '../../lib/auth';
import type { SyncContext } from '../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  let remoteRevoked = false;
  try { remoteRevoked = await revokeCurrentSession(context); } catch { /* Always clear the browser cookie even if the remote session is unavailable. */ }
  return json({ ok: true, remoteRevoked }, 200, { 'Set-Cookie': clearSessionCookie(context) });
};

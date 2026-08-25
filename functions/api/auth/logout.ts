import { clearSessionCookie, json } from '../../lib/auth';
import type { SyncContext } from '../../types';

export const onRequestPost = (context: SyncContext): Response => json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(context) });

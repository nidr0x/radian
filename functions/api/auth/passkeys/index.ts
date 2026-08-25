import { getAuthenticatedContext, json, readJson } from '../../../lib/auth';
import type { SyncContext } from '../../../types';

interface PasskeyRow {
  credentialId: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string;
}

const getCredentialId = (body: Record<string, unknown>): string => typeof body.credentialId === 'string' ? body.credentialId.trim() : '';

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const rows = await authenticated.env.DB!.prepare(
    'SELECT credential_id AS credentialId, label, created_at AS createdAt, last_used_at AS lastUsedAt FROM passkeys WHERE user_id = ? ORDER BY created_at ASC',
  ).bind(authenticated.user.id).all<PasskeyRow>();
  return json({ passkeys: rows.results });
};

export const onRequestPatch = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const body = await readJson(context.request);
  const credentialId = getCredentialId(body);
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 60) : '';
  if (!credentialId || !label) return json({ error: 'invalid_request', message: 'Indica un nombre para la passkey.' }, 400);
  const result = await authenticated.env.DB!.prepare('UPDATE passkeys SET label = ? WHERE credential_id = ? AND user_id = ?').bind(label, credentialId, authenticated.user.id).run();
  if ((result.meta?.changes ?? 0) !== 1) return json({ error: 'not_found', message: 'No encontramos esa passkey.' }, 404);
  return json({ ok: true });
};

export const onRequestDelete = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const body = await readJson(context.request);
  const credentialId = getCredentialId(body);
  if (!credentialId) return json({ error: 'invalid_request', message: 'La passkey indicada no es válida.' }, 400);
  const count = await authenticated.env.DB!.prepare('SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?').bind(authenticated.user.id).first<{ count: number }>();
  if ((count?.count ?? 0) <= 1) return json({ error: 'last_passkey', message: 'Mantén al menos una passkey para no perder el acceso.' }, 409);
  const result = await authenticated.env.DB!.prepare('DELETE FROM passkeys WHERE credential_id = ? AND user_id = ?').bind(credentialId, authenticated.user.id).run();
  if ((result.meta?.changes ?? 0) !== 1) return json({ error: 'not_found', message: 'No encontramos esa passkey.' }, 404);
  return json({ ok: true });
};

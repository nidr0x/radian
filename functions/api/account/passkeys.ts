import { onRequestDelete as revokePasskey, onRequestGet as listPasskeys } from '../auth/passkeys/index';
import { getAuthenticatedContext, json } from '../../lib/auth';
import { rewriteJsonRequest } from '../../lib/radian-api/compat';
import { getAccountSecurity, getPasskeyCount, passwordLoginEnabled } from '../../lib/radian-api/account-security';
import type { SyncContext } from '../../types';

export const onRequestGet = async (context: SyncContext): Promise<Response> => {
  const response = await listPasskeys(context);
  if (!response.ok) return response;
  const body: unknown = await response.json().catch(() => null);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return json({ error: 'invalid_response' }, 500);
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const current = body as Record<string, unknown>;
  if (!Array.isArray(current.passkeys)) return json(current);
  const passkeys = current.passkeys.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
    const passkey = item as Record<string, unknown>;
    return { ...passkey, id: passkey.credentialId, name: passkey.label };
  });
  const security = passwordLoginEnabled(context) ? await getAccountSecurity(authenticated.env.DB!, authenticated.user.id).catch(() => null) : null;
  const password = passwordLoginEnabled(context) && !!security?.passwordHash;
  const passkeyCount = await getPasskeyCount(authenticated.env.DB!, authenticated.user.id);
  return json({ ...current, passkeys, password, lastWayIn: passkeyCount === 1 && !password ? 'passkey' : null });
};

export const onRequestDelete = async (context: SyncContext): Promise<Response> => {
  const id = new URL(context.request.url).searchParams.get('id');
  const mapped = await rewriteJsonRequest(context, (body) => ({
    ...body,
    credentialId: id ?? body.id ?? body.credentialId,
  }));
  return revokePasskey(mapped);
};

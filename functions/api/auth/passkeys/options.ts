import { generateRegistrationOptions } from '@simplewebauthn/server';
import { challengeExpiry, getAuthenticatedContext, getWebAuthnConfig, json, randomId, readJson } from '../../../lib/auth';
import type { SyncContext } from '../../../types';

interface ExistingCredential { credentialId: string; transports: string }

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const database = authenticated.env.DB!;
  const body = await readJson(context.request);
  const passkeyLabel = typeof body.passkeyLabel === 'string' ? body.passkeyLabel.trim().slice(0, 60) : '';
  const existing = await database.prepare('SELECT credential_id AS credentialId, transports FROM passkeys WHERE user_id = ?').bind(authenticated.user.id).all<ExistingCredential>();
  const { rpId, rpName } = getWebAuthnConfig(context);
  const options = await generateRegistrationOptions({
    rpName,
    rpID: rpId,
    userID: new TextEncoder().encode(authenticated.user.id),
    userName: authenticated.user.displayName,
    userDisplayName: authenticated.user.displayName,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existing.results.map((credential) => ({ id: credential.credentialId, transports: JSON.parse(credential.transports || '[]') })),
  });
  const challengeId = randomId(18);
  await database.prepare(
    'INSERT INTO auth_challenges (id, kind, mode, challenge, user_id, display_name, passkey_label, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(challengeId, 'register', 'add_passkey', options.challenge, authenticated.user.id, authenticated.user.displayName, passkeyLabel || 'Passkey', challengeExpiry()).run();
  return json({ challengeId, options });
};

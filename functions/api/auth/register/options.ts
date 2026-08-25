import { generateRegistrationOptions } from '@simplewebauthn/server';
import { challengeExpiry, getWebAuthnConfig, json, randomId, readJson, requireDatabase } from '../../../lib/auth';
import type { SyncContext } from '../../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  const body = await readJson(context.request);
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 60) : '';
  const passkeyLabel = typeof body.passkeyLabel === 'string' ? body.passkeyLabel.trim().slice(0, 60) : '';
  if (!displayName) return json({ error: 'invalid_name', message: 'Indica un nombre para tu perfil.' }, 400);
  const { rpId, rpName } = getWebAuthnConfig(context);
  const userId = randomId(16);
  const options = await generateRegistrationOptions({
    rpName,
    rpID: rpId,
    userID: new TextEncoder().encode(userId),
    userName: displayName,
    userDisplayName: displayName,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  const challengeId = randomId(18);
  await database.prepare(
    'INSERT INTO auth_challenges (id, kind, mode, challenge, user_id, display_name, passkey_label, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(challengeId, 'register', 'new_account', options.challenge, userId, displayName, passkeyLabel || 'Passkey principal', challengeExpiry()).run();
  return json({ challengeId, options });
};

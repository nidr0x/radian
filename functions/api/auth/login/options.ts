import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { challengeExpiry, getWebAuthnConfig, json, randomId, requireDatabase } from '../../../lib/auth';
import type { SyncContext } from '../../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  const { rpId } = getWebAuthnConfig(context);
  const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: 'required' });
  const challengeId = randomId(18);
  await database.prepare(
    'INSERT INTO auth_challenges (id, kind, challenge, expires_at) VALUES (?, ?, ?, ?)',
  ).bind(challengeId, 'login', options.challenge, challengeExpiry()).run();
  return json({ challengeId, options });
};

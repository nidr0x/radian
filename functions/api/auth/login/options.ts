import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { challengeExpiry, createChallengeBinding, enforceAuthRateLimit, getWebAuthnConfig, json, pruneChallenges, randomId, requireAuthConfiguration, requireDatabase } from '../../../lib/auth';
import type { SyncContext } from '../../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const configurationError = requireAuthConfiguration(context);
  if (configurationError) return configurationError;
  const rateLimitResponse = await enforceAuthRateLimit(context, 'login-options');
  if (rateLimitResponse) return rateLimitResponse;
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  await pruneChallenges(database);
  const { rpId } = getWebAuthnConfig(context);
  const options = await generateAuthenticationOptions({ rpID: rpId, userVerification: 'required' });
  const challengeId = randomId(18);
  const binding = await createChallengeBinding(context, challengeId);
  await database.prepare(
    'INSERT INTO auth_challenges (id, kind, challenge, expires_at, browser_binding_hash) VALUES (?, ?, ?, ?, ?)',
  ).bind(challengeId, 'login', options.challenge, challengeExpiry(), binding.hash).run();
  return json({ challengeId, options }, 200, { 'Set-Cookie': binding.cookie });
};

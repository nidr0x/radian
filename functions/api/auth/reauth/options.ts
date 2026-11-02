import { generateAuthenticationOptions } from '@simplewebauthn/server';
import { challengeExpiry, enforceAuthRateLimit, getAuthenticatedContext, getWebAuthnConfig, json, pruneChallenges, randomId } from '../../../lib/auth';
import type { SyncContext } from '../../../types';

interface ExistingCredential { credentialId: string; transports: string }

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const rateLimitResponse = await enforceAuthRateLimit(context, 'reauth-options');
  if (rateLimitResponse) return rateLimitResponse;
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const database = authenticated.env.DB!;
  await pruneChallenges(database);
  const existing = await database.prepare('SELECT credential_id AS credentialId, transports FROM passkeys WHERE user_id = ?').bind(authenticated.user.id).all<ExistingCredential>();
  if (existing.results.length === 0) return json({ error: 'no_passkeys', message: 'No hay passkeys disponibles para verificar la cuenta.' }, 409);
  const { rpId } = getWebAuthnConfig(context);
  const options = await generateAuthenticationOptions({
    rpID: rpId,
    userVerification: 'required',
    allowCredentials: existing.results.map((credential) => ({
      id: credential.credentialId,
      transports: JSON.parse(credential.transports || '[]'),
    })),
  });
  const challengeId = randomId(18);
  await database.prepare(
    'INSERT INTO auth_step_up_challenges (id, user_id, challenge, expires_at) VALUES (?, ?, ?, ?)',
  ).bind(challengeId, authenticated.user.id, options.challenge, challengeExpiry()).run();
  return json({ challengeId, options });
};

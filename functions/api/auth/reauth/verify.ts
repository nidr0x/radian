import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { consumeStepUpChallenge, enforceAuthRateLimit, getAuthenticatedContext, getWebAuthnConfig, isRecord, json, markSessionReauthenticated, readJson } from '../../../lib/auth';
import type { SyncContext } from '../../../types';

interface PasskeyRow {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string;
}

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const rateLimitResponse = await enforceAuthRateLimit(context, 'reauth-verify');
  if (rateLimitResponse) return rateLimitResponse;
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const body = await readJson(context.request);
  const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
  const credential = body.credential;
  const credentialId = isRecord(credential) && typeof credential.id === 'string' ? credential.id : '';
  if (!challengeId || !isRecord(credential) || !credentialId) return json({ error: 'invalid_request', message: 'La solicitud de verificación no es válida.' }, 400);
  const challenge = await consumeStepUpChallenge(authenticated.env.DB!, challengeId, authenticated.user.id);
  if (!challenge) return json({ error: 'challenge_expired', message: 'La solicitud ha caducado. Inténtalo de nuevo.' }, 400);
  const passkey = await authenticated.env.DB!.prepare(
    'SELECT credential_id AS credentialId, public_key AS publicKey, counter, transports FROM passkeys WHERE credential_id = ? AND user_id = ?',
  ).bind(credentialId, authenticated.user.id).first<PasskeyRow>();
  if (!passkey) return json({ error: 'unknown_passkey', message: 'No encontramos esta passkey.' }, 404);
  const { rpId, origin } = getWebAuthnConfig(context);
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential as never,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
      credential: {
        id: passkey.credentialId,
        publicKey: new Uint8Array(JSON.parse(passkey.publicKey) as number[]),
        counter: passkey.counter,
        transports: JSON.parse(passkey.transports || '[]'),
      },
    });
  } catch {
    return json({ error: 'verification_failed', message: 'No se ha podido verificar esta passkey.' }, 400);
  }
  if (!verification.verified) return json({ error: 'verification_failed', message: 'No se ha podido verificar esta passkey.' }, 400);
  const counterUpdate = await authenticated.env.DB!.prepare(
    'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ? AND user_id = ? AND counter = ?',
  ).bind(verification.authenticationInfo.newCounter, new Date().toISOString(), passkey.credentialId, authenticated.user.id, passkey.counter).run();
  if ((counterUpdate.meta?.changes ?? 0) !== 1) return json({ error: 'credential_changed', message: 'La passkey ha cambiado mientras se verificaba. Inténtalo de nuevo.' }, 409);
  try {
    await markSessionReauthenticated(authenticated);
  } catch {
    return json({ error: 'auth_unavailable', message: 'No se ha podido actualizar la sesión.' }, 503);
  }
  return json({ ok: true });
};

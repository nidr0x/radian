import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { consumeChallenge, enforceAuthRateLimit, getWebAuthnConfig, issueSessionCookie, isRecord, json, readJson, requireDatabase } from '../../../lib/auth';
import type { SyncContext } from '../../../types';

interface PasskeyRow {
  credentialId: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports: string;
}

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const rateLimitResponse = await enforceAuthRateLimit(context, 'login-verify');
  if (rateLimitResponse) return rateLimitResponse;
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  const body = await readJson(context.request);
  const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
  const credential = body.credential;
  const credentialId = isRecord(credential) && typeof credential.id === 'string' ? credential.id : '';
  if (!challengeId || !isRecord(credential) || !credentialId) return json({ error: 'invalid_request', message: 'La solicitud de acceso no es válida.' }, 400);
  const challenge = await consumeChallenge(database, challengeId, 'login');
  if (!challenge) return json({ error: 'challenge_expired', message: 'La solicitud ha caducado. Inténtalo de nuevo.' }, 400);
  const passkey = await database.prepare(
    'SELECT credential_id AS credentialId, user_id AS userId, public_key AS publicKey, counter, transports FROM passkeys WHERE credential_id = ?',
  ).bind(credentialId).first<PasskeyRow>();
  if (!passkey) return json({ error: 'unknown_passkey', message: 'No encontramos esta passkey. Registra una nueva para crear tu perfil.' }, 404);
  const user = await database.prepare('SELECT id, display_name AS displayName, created_at AS createdAt, session_version AS sessionVersion, disabled FROM users WHERE id = ?').bind(passkey.userId).first<{ id: string; displayName: string; createdAt: string; sessionVersion: number; disabled: number }>();
  if (!user || user.disabled === 1) return json({ error: 'account_disabled', message: 'Esta cuenta no está disponible.' }, 403);
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
  await database.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?').bind(verification.authenticationInfo.newCounter, new Date().toISOString(), passkey.credentialId).run();
  const cookie = await issueSessionCookie(context, user.id, user.sessionVersion);
  return json({ user: { id: user.id, displayName: user.displayName, createdAt: user.createdAt } }, 200, { 'Set-Cookie': cookie });
};

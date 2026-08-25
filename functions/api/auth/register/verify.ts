import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { consumeChallenge, getAuthenticatedContext, getWebAuthnConfig, issueSessionCookie, isRecord, json, readJson, requireDatabase } from '../../../lib/auth';
import type { SyncContext } from '../../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  const body = await readJson(context.request);
  const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
  const credential = body.credential;
  if (!challengeId || !isRecord(credential)) return json({ error: 'invalid_request', message: 'La solicitud de registro no es válida.' }, 400);
  const challenge = await consumeChallenge(database, challengeId, 'register');
  if (!challenge?.userId || !challenge.displayName) return json({ error: 'challenge_expired', message: 'La solicitud ha caducado. Inténtalo de nuevo.' }, 400);
  if (challenge.mode === 'add_passkey') {
    const authenticated = await getAuthenticatedContext(context);
    if (authenticated instanceof Response || authenticated.user.id !== challenge.userId) return json({ error: 'not_authenticated', message: 'Vuelve a iniciar sesión para añadir una passkey.' }, 401);
  }
  const { rpId, origin } = getWebAuthnConfig(context);
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: credential as never,
      expectedChallenge: challenge.challenge,
      expectedOrigin: origin,
      expectedRPID: rpId,
      requireUserVerification: true,
    });
  } catch {
    return json({ error: 'verification_failed', message: 'No se ha podido verificar esta passkey.' }, 400);
  }
  if (!verification.verified) return json({ error: 'verification_failed', message: 'No se ha podido verificar esta passkey.' }, 400);
  const registered = verification.registrationInfo.credential;
  const createdAt = new Date().toISOString();
  try {
    const passkeyInsert = database.prepare('INSERT INTO passkeys (credential_id, user_id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
      registered.id,
      challenge.userId,
      JSON.stringify(Array.from(registered.publicKey)),
      registered.counter,
      JSON.stringify(isRecord(credential.response) && Array.isArray(credential.response.transports) ? credential.response.transports : []),
      challenge.passkeyLabel ?? 'Passkey',
      createdAt,
    );
    if (challenge.mode === 'add_passkey') await passkeyInsert.run();
    else await database.batch([database.prepare('INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)').bind(challenge.userId, challenge.displayName, createdAt), passkeyInsert]);
  } catch {
    return json({ error: 'credential_exists', message: 'Esta passkey ya está registrada.' }, 409);
  }
  const sessionVersion = challenge.mode === 'add_passkey' ? (await database.prepare('SELECT session_version AS sessionVersion FROM users WHERE id = ?').bind(challenge.userId).first<{ sessionVersion: number }>())?.sessionVersion ?? 0 : 0;
  const cookie = await issueSessionCookie(context, challenge.userId, sessionVersion);
  return json({ user: { id: challenge.userId, displayName: challenge.displayName, createdAt } }, 201, { 'Set-Cookie': cookie });
};

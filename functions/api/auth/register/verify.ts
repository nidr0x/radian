import { verifyRegistrationResponse } from '@simplewebauthn/server';
import { consumeChallenge, enforceAuthRateLimit, getAccountRoles, getAuthenticatedContext, getChallengeBinding, getWebAuthnConfig, issueSessionCookie, isRecord, json, readJson, requireAuthConfiguration, requireDatabase, requireRecentReauthentication } from '../../../lib/auth';
import { auditStatement } from '../../../lib/radian-api/admin';
import { hashCode, normalizeOneTimeCode, validOneTimeCode } from '../../../lib/radian-api/one-time-code';
import type { SyncContext } from '../../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const configurationError = requireAuthConfiguration(context);
  if (configurationError) return configurationError;
  const rateLimitResponse = await enforceAuthRateLimit(context, 'register-verify');
  if (rateLimitResponse) return rateLimitResponse;
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  const body = await readJson(context.request);
  const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
  const credential = body.credential;
  if (!challengeId || !isRecord(credential)) return json({ error: 'invalid_request', message: 'La solicitud de registro no es válida.' }, 400);
  const challenge = await consumeChallenge(database, challengeId, 'register', getChallengeBinding(context, challengeId));
  if (!challenge?.userId || !challenge.displayName) return json({ error: 'challenge_expired', message: 'La solicitud ha caducado. Inténtalo de nuevo.' }, 400);
  if (challenge.mode === 'add_passkey') {
    const authenticated = await getAuthenticatedContext(context);
    if (authenticated instanceof Response || authenticated.user.id !== challenge.userId) return json({ error: 'not_authenticated', message: 'Vuelve a iniciar sesión para añadir una passkey.' }, 401);
    const reauthenticationError = requireRecentReauthentication(authenticated);
    if (reauthenticationError) return reauthenticationError;
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
  let accountCreatedAt = createdAt;
  try {
    const passkeyValues = [
      registered.id,
      challenge.userId,
      JSON.stringify(Array.from(registered.publicKey)),
      registered.counter,
      JSON.stringify(isRecord(credential.response) && Array.isArray(credential.response.transports) ? credential.response.transports : []),
      typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : challenge.passkeyLabel ?? 'Passkey',
      createdAt,
    ];
    const passkeyInsert = database.prepare('INSERT INTO passkeys (credential_id, user_id, public_key, counter, transports, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(...passkeyValues);
    if (challenge.mode === 'add_passkey') {
      const count = await database.prepare('SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?').bind(challenge.userId).first<{ count: number }>();
      if ((count?.count ?? 0) >= 20) return json({ error: 'passkey-limit', code: 'passkey-limit', message: 'A profile can have at most 20 passkeys.' }, 409);
      await passkeyInsert.run();
      const audit = auditStatement(database, context, { id: challenge.userId, displayName: challenge.displayName }, 'auth.passkey.add', true, { action: passkeyValues[5] as string });
      if (audit) await audit.run().catch(() => {});
    } else if (challenge.deviceLinkCodeHash) {
      const code = typeof body.code === 'string' ? normalizeOneTimeCode(body.code) : '';
      if (!validOneTimeCode(code) || await hashCode(code) !== challenge.deviceLinkCodeHash) {
        return json({ error: 'link-invalid', code: 'link-invalid', message: 'That device code is wrong, used or expired.' }, 400);
      }
      const profile = await database.prepare('SELECT created_at AS createdAt, disabled FROM users WHERE id = ?')
        .bind(challenge.userId).first<{ createdAt: string; disabled: number }>();
      if (!profile || profile.disabled === 1) return json({ error: 'link-invalid', code: 'link-invalid', message: 'That device code is wrong, used or expired.' }, 400);
      const count = await database.prepare('SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?').bind(challenge.userId).first<{ count: number }>();
      if ((count?.count ?? 0) >= 20) return json({ error: 'passkey-limit', code: 'passkey-limit', message: 'A profile can have at most 20 passkeys.' }, 409);
      accountCreatedAt = profile.createdAt;
      const guardedPasskeyInsert = database.prepare(
        'INSERT INTO passkeys (credential_id, user_id, public_key, counter, transports, label, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1',
      ).bind(...passkeyValues);
      const audit = auditStatement(database, context, { id: challenge.userId, displayName: challenge.displayName }, 'auth.link.ok', true, { action: typeof body.name === 'string' ? body.name.trim().slice(0, 60) : undefined });
      const results = await database.batch([
        database.prepare(
          `UPDATE gym_device_link_codes SET used_at = ?
            WHERE account_id = ? AND code_hash = ? AND used_at IS NULL AND expires_at > ?
              AND EXISTS (SELECT 1 FROM users WHERE id = ? AND disabled = 0)`,
        ).bind(createdAt, challenge.userId, challenge.deviceLinkCodeHash, createdAt, challenge.userId),
        guardedPasskeyInsert,
        ...(audit ? [audit] : []),
      ]);
      if ((results[0]?.meta?.changes ?? 0) !== 1 || (results[1]?.meta?.changes ?? 0) !== 1) {
        return json({ error: 'link-invalid', code: 'link-invalid', message: 'That device code is wrong, used or expired.' }, 400);
      }
    } else {
      const invite = challenge.inviteCodeHash
        ? await database.prepare('SELECT code FROM gym_invites WHERE code_hash = ? AND used_at IS NULL').bind(challenge.inviteCodeHash).first<{ code: string }>()
        : null;
      if ((context.env.INVITE_ONLY === '1' && !challenge.inviteCodeHash) || (challenge.inviteCodeHash && !invite)) {
        return json({ error: 'invite', code: 'invite', message: 'A valid invite code is required.' }, 403);
      }
      const registrationAudit = auditStatement(database, context, { id: challenge.userId, displayName: challenge.displayName }, 'auth.register.ok');
      const statements = [
        ...(challenge.inviteCodeHash ? [database.prepare(
          'UPDATE gym_invites SET used_by_account_id = ?, used_at = ? WHERE code_hash = ? AND used_at IS NULL',
        ).bind(challenge.userId, createdAt, challenge.inviteCodeHash)] : []),
        challenge.inviteCodeHash
          ? database.prepare(
            `INSERT INTO users (id, display_name, created_at, invited_by_code)
             SELECT ?, ?, ?, ? WHERE EXISTS (
               SELECT 1 FROM gym_invites WHERE code_hash = ? AND used_by_account_id = ? AND used_at = ?
             )`,
          ).bind(challenge.userId, challenge.displayName, createdAt, invite?.code ?? null, challenge.inviteCodeHash, challenge.userId, createdAt)
          : database.prepare('INSERT INTO users (id, display_name, created_at, invited_by_code) VALUES (?, ?, ?, ?)')
            .bind(challenge.userId, challenge.displayName, createdAt, null),
        passkeyInsert,
        database.prepare(
          "UPDATE users SET is_admin = 1, is_owner = 1 WHERE id = ? AND ? = '1' AND (SELECT COUNT(*) FROM users) = 1 AND NOT EXISTS (SELECT 1 FROM users WHERE is_owner = 1)",
        ).bind(challenge.userId, context.env.FIRST_USER_ADMIN ?? '0'),
        ...(registrationAudit ? [registrationAudit] : []),
      ];
      await database.batch(statements);
    }
  } catch {
    if (challenge.inviteCodeHash) {
      const invite = await database.prepare('SELECT code FROM gym_invites WHERE code_hash = ? AND used_at IS NULL').bind(challenge.inviteCodeHash).first<{ code: string }>().catch(() => null);
      if (!invite) return json({ error: 'invite', code: 'invite', message: 'A valid invite code is required.' }, 403);
    }
    return json({ error: 'credential_exists', message: 'Esta passkey ya está registrada.' }, 409);
  }
  const sessionVersion = challenge.mode === 'add_passkey' || challenge.deviceLinkCodeHash
    ? (await database.prepare('SELECT session_version AS sessionVersion FROM users WHERE id = ?').bind(challenge.userId).first<{ sessionVersion: number }>())?.sessionVersion ?? 0
    : 0;
  try {
    const credentialId = registered.id;
    const cookie = await issueSessionCookie(context, challenge.userId, sessionVersion, credentialId);
    const roles = await getAccountRoles(database, challenge.userId, context.env);
    return json({ user: { id: challenge.userId, displayName: challenge.displayName, createdAt: accountCreatedAt, ...roles } }, 201, { 'Set-Cookie': cookie });
  } catch {
    return json({ error: 'auth_unavailable', message: 'No se ha podido crear la sesión.' }, 503);
  }
};

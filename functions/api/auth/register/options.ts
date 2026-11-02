import { generateRegistrationOptions } from '@simplewebauthn/server';
import { challengeExpiry, createChallengeBinding, enforceAuthRateLimit, getWebAuthnConfig, json, pruneChallenges, randomId, readJson, requireAuthConfiguration, requireDatabase } from '../../../lib/auth';
import { findActiveInvite } from '../../../lib/radian-api/one-time-code';
import type { SyncContext } from '../../../types';

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const configurationError = requireAuthConfiguration(context);
  if (configurationError) return configurationError;
  const rateLimitResponse = await enforceAuthRateLimit(context, 'register-options');
  if (rateLimitResponse) return rateLimitResponse;
  const database = requireDatabase(context);
  if (database instanceof Response) return database;
  await pruneChallenges(database);
  const body = await readJson(context.request);
  const displayName = typeof body.displayName === 'string' ? body.displayName.normalize('NFKC').trim() : '';
  const passkeyLabel = typeof body.passkeyLabel === 'string' ? body.passkeyLabel.trim().slice(0, 60) : '';
  if (!displayName || [...displayName].length > 40) return json({ error: 'invalid_name', code: 'missing', message: 'Indica un nombre de hasta 40 caracteres.' }, 400);
  const typedCode = typeof body.code === 'string' ? body.code : '';
  const invite = typedCode.trim() ? await findActiveInvite(database, typedCode) : null;
  if ((context.env.INVITE_ONLY === '1' && !invite) || (typedCode.trim() && !invite)) {
    return json({ error: 'invite', code: 'invite', message: 'A valid invite code is required.' }, 403);
  }
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
  const binding = await createChallengeBinding(context, challengeId);
  await database.prepare(
    'INSERT INTO auth_challenges (id, kind, mode, challenge, user_id, display_name, passkey_label, expires_at, browser_binding_hash, invite_code_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(challengeId, 'register', 'new_account', options.challenge, userId, displayName, passkeyLabel || 'Passkey principal', challengeExpiry(), binding.hash, invite?.codeHash ?? null).run();
  return json({ challengeId, options }, 200, { 'Set-Cookie': binding.cookie });
};

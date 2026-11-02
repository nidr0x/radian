import { generateRegistrationOptions } from '@simplewebauthn/server';
import { challengeExpiry, createChallengeBinding, enforceAuthRateLimit, getWebAuthnConfig, json, pruneChallenges, randomId } from '../../lib/auth';
import { hashCode, normalizeOneTimeCode, validOneTimeCode } from '../../lib/radian-api/one-time-code';
import { readSmallJson } from '../../lib/radian-api/request';
import type { SyncContext } from '../../types';

interface LinkRow { id: string; name: string; createdAt: string; codeHash: string }
interface ExistingCredential { credentialId: string; transports: string }

const error = (status: number, code: string, message: string): Response => json({ error: message, code, message }, status);

export const onRequestPost = async (context: SyncContext): Promise<Response> => {
  const database = context.env.DB;
  if (!database) return error(503, 'busy', 'The server is busy. Try again in a moment.');
  const limited = await enforceAuthRateLimit(context, 'device-link-redeem-ip');
  if (limited) return limited;
  const read = await readSmallJson(context.request);
  if (!read.ok) return error(read.reason === 'too-large' ? 413 : 400, 'invalid-request', 'The request is not valid.');
  const raw = typeof read.value.code === 'string' ? normalizeOneTimeCode(read.value.code) : '';
  if (!validOneTimeCode(raw)) return error(400, 'link-invalid', 'That device code is wrong, used or expired.');

  const codeHash = await hashCode(raw);
  const now = new Date().toISOString();
  const link = await database.prepare(
    `SELECT c.account_id AS id, u.display_name AS name, u.created_at AS createdAt, c.code_hash AS codeHash
       FROM gym_device_link_codes c JOIN users u ON u.id = c.account_id
      WHERE c.code_hash = ? AND c.used_at IS NULL AND c.expires_at > ? AND u.disabled = 0`,
  ).bind(codeHash, now).first<LinkRow>();
  if (!link) return error(400, 'link-invalid', 'That device code is wrong, used or expired.');

  const [count, existing] = await Promise.all([
    database.prepare('SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?').bind(link.id).first<{ count: number }>(),
    database.prepare('SELECT credential_id AS credentialId, transports FROM passkeys WHERE user_id = ?').bind(link.id).all<ExistingCredential>(),
  ]);
  if ((count?.count ?? 0) >= 20) return error(409, 'passkey-limit', 'A profile can have at most 20 passkeys.');

  await pruneChallenges(database);
  const { rpId, rpName } = getWebAuthnConfig(context);
  const options = await generateRegistrationOptions({
    rpName,
    rpID: rpId,
    userID: new TextEncoder().encode(link.id),
    userName: link.name,
    userDisplayName: link.name,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existing.results.map((credential) => ({ id: credential.credentialId, transports: JSON.parse(credential.transports || '[]') })),
  });
  const challengeId = randomId(18);
  const binding = await createChallengeBinding(context, challengeId);
  await database.prepare(
    `INSERT INTO auth_challenges
      (id, kind, mode, challenge, user_id, display_name, passkey_label, expires_at, browser_binding_hash, device_link_code_hash)
     VALUES (?, 'register', 'new_account', ?, ?, ?, 'Passkey', ?, ?, ?)`,
  ).bind(challengeId, options.challenge, link.id, link.name, challengeExpiry(), binding.hash, link.codeHash).run();
  return json({ cid: challengeId, options, id: link.id, name: link.name }, 200, { 'Set-Cookie': binding.cookie });
};

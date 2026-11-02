import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import {
  consumeChallenge,
  getChallengeBinding,
  getWebAuthnConfig,
  isRecord,
} from '../auth';
import type { AuthenticatedContext } from '../auth';
import type { D1DatabaseLike, SyncContext } from '../../types';
import { verifyPassword } from './password-core';

export interface AccountSecurityRow {
  passwordHash: string | null;
  passwordSetAt: string | null;
  email: string | null;
}

interface PasskeyRow {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string;
}

export type OwnerProofResult = 'ok' | 'current-required' | 'current-wrong' | 'passkey-required' | 'passkey';

export const passwordLoginEnabled = (context: SyncContext): boolean => context.env.PASSWORD_LOGIN === '1';

export const getAccountSecurity = (database: D1DatabaseLike, accountId: string): Promise<AccountSecurityRow | null> => database.prepare(
  'SELECT password_hash AS passwordHash, password_set_at AS passwordSetAt, email FROM gym_account_security WHERE account_id = ?',
).bind(accountId).first<AccountSecurityRow>();

export const getPasskeyCount = async (database: D1DatabaseLike, accountId: string): Promise<number> => {
  const row = await database.prepare('SELECT COUNT(*) AS count FROM passkeys WHERE user_id = ?').bind(accountId).first<{ count: number }>();
  return row?.count ?? 0;
};

const verifyPasskeyProof = async (context: AuthenticatedContext, body: Record<string, unknown>): Promise<boolean> => {
  const challengeId = typeof body.cid === 'string' ? body.cid : '';
  const credential = body.credential;
  const credentialId = isRecord(credential) && typeof credential.id === 'string' ? credential.id : '';
  if (!challengeId || !isRecord(credential) || !credentialId) return false;

  const database = context.env.DB!;
  const challenge = await consumeChallenge(database, challengeId, 'login', getChallengeBinding(context, challengeId));
  if (!challenge) return false;
  const passkey = await database.prepare(
    'SELECT credential_id AS credentialId, public_key AS publicKey, counter, transports FROM passkeys WHERE credential_id = ? AND user_id = ?',
  ).bind(credentialId, context.user.id).first<PasskeyRow>();
  if (!passkey) return false;

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
    return false;
  }
  if (!verification.verified) return false;
  const updated = await database.prepare(
    'UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ? AND user_id = ? AND counter = ?',
  ).bind(verification.authenticationInfo.newCounter, new Date().toISOString(), passkey.credentialId, context.user.id, passkey.counter).run();
  return (updated.meta?.changes ?? 0) === 1;
};

export const verifyOwnerProof = async (
  context: AuthenticatedContext,
  security: AccountSecurityRow | null,
  passkeyCount: number,
  body: Record<string, unknown>,
): Promise<OwnerProofResult> => {
  const passwordSet = passwordLoginEnabled(context) && !!security?.passwordHash;
  if (passwordSet && typeof body.current === 'string' && body.current.length > 0) {
    return await verifyPassword(body.current, security.passwordHash) ? 'ok' : 'current-wrong';
  }
  if (typeof body.cid === 'string' || isRecord(body.credential)) {
    return await verifyPasskeyProof(context, body) ? 'ok' : 'passkey';
  }
  if (passwordSet) return 'current-required';
  return passkeyCount > 0 ? 'passkey' : 'passkey-required';
};

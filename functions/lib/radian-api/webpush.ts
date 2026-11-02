import { decodeBase64Url } from '../auth';

export interface WebPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const encoder = new TextEncoder();
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'];

export const isSafePushEndpoint = (value: string): boolean => {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    const hostAllowed = PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
    return url.protocol === 'https:' && (url.port === '' || url.port === '443') && !url.username && !url.password
      && !url.hash && hostAllowed;
  } catch { return false; }
};

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((length, part) => length + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
};

const copyBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};

const encodeBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
};

const hmac = async (keyBytes: Uint8Array, data: Uint8Array): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey('raw', copyBuffer(keyBytes), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, copyBuffer(data)));
};

const hkdfExpand = async (prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> => {
  const blocks: Uint8Array[] = [];
  let previous: Uint8Array = new Uint8Array();
  let size = 0;
  for (let counter = 1; size < length; counter++) {
    previous = await hmac(prk, concat(previous, info, Uint8Array.of(counter)));
    blocks.push(previous);
    size += previous.byteLength;
  }
  return concat(...blocks).slice(0, length);
};

const vapidToken = async (endpoint: URL, config: VapidConfig): Promise<string> => {
  let publicBytes: Uint8Array;
  let privateBytes: Uint8Array;
  try {
    publicBytes = decodeBase64Url(config.publicKey);
    privateBytes = decodeBase64Url(config.privateKey);
  } catch { throw new Error('invalid_vapid_key'); }
  if (publicBytes.length !== 65 || publicBytes[0] !== 4 || privateBytes.length !== 32) throw new Error('invalid_vapid_key');
  if (!/^(?:mailto:.+|https:\/\/.+)$/.test(config.subject)) throw new Error('invalid_vapid_subject');
  const x = encodeBase64Url(publicBytes.slice(1, 33));
  const y = encodeBase64Url(publicBytes.slice(33, 65));
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', x, y, d: encodeBase64Url(privateBytes), ext: true, key_ops: ['sign'],
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const header = encodeBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = encodeBase64Url(encoder.encode(JSON.stringify({ aud: endpoint.origin, exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60, sub: config.subject })));
  const signingInput = `${header}.${claims}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(signingInput)));
  return `${signingInput}.${encodeBase64Url(signature)}`;
};

export const sendWebPush = async (
  subscription: WebPushSubscription,
  payload: unknown,
  config: VapidConfig,
  fetcher: typeof fetch = fetch,
): Promise<Response> => {
  if (!isSafePushEndpoint(subscription.endpoint)) throw new Error('unsafe_push_endpoint');
  const endpoint = new URL(subscription.endpoint);
  let userPublic: Uint8Array;
  let authSecret: Uint8Array;
  try {
    userPublic = decodeBase64Url(subscription.p256dh);
    authSecret = decodeBase64Url(subscription.auth);
  } catch { throw new Error('invalid_push_keys'); }
  if (userPublic.length !== 65 || userPublic[0] !== 4 || authSecret.length !== 16) throw new Error('invalid_push_keys');

  const peer = await crypto.subtle.importKey('raw', copyBuffer(userPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: peer }, ephemeral.privateKey, 256));
  const authPrk = await hmac(authSecret, shared);
  const keyInfo = concat(encoder.encode('WebPush: info\0'), userPublic, serverPublic);
  const ikm = await hkdfExpand(authPrk, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = await hkdfExpand(prk, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdfExpand(prk, encoder.encode('Content-Encoding: nonce\0'), 12);
  const plain = concat(encoder.encode(JSON.stringify(payload)), Uint8Array.of(2));
  const aesKey = await crypto.subtle.importKey('raw', copyBuffer(cek), 'AES-GCM', false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: copyBuffer(nonce), tagLength: 128 }, aesKey, copyBuffer(plain)));
  const recordSize = Uint8Array.of(0, 0, 16, 0);
  const body = concat(salt, recordSize, Uint8Array.of(serverPublic.byteLength), serverPublic, cipher);
  if (body.byteLength > 4096) throw new Error('push_payload_too_large');
  const token = await vapidToken(endpoint, config);
  return fetcher(subscription.endpoint, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      Authorization: `vapid t=${token}, k=${config.publicKey}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '60',
    },
    body: copyBuffer(body),
  });
};

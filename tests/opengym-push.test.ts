import { describe, expect, it, vi } from 'vitest';
import { isSafePushEndpoint, sendWebPush } from '../functions/lib/radian-api/webpush';
import { parsePushSubscription, pushVapidConfig } from '../functions/lib/radian-api/push';

type PushBytes = Uint8Array<ArrayBuffer>;
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
};
const encode = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const decode = (value: string): PushBytes => {
  const raw = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(raw, character => character.charCodeAt(0));
};
const concat = (...values: Uint8Array[]): PushBytes => {
  const out: PushBytes = new Uint8Array(values.reduce((size, value) => size + value.length, 0));
  let offset = 0;
  for (const value of values) { out.set(value, offset); offset += value.length; }
  return out;
};

const hmac = async (key: Uint8Array, value: Uint8Array): Promise<PushBytes> => {
  const imported = await crypto.subtle.importKey('raw', toArrayBuffer(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, toArrayBuffer(value)));
};
const expand = async (prk: Uint8Array, info: Uint8Array, size: number): Promise<PushBytes> => {
  let previous: PushBytes = new Uint8Array();
  const parts: PushBytes[] = [];
  for (let counter = 1; parts.reduce((n, part) => n + part.length, 0) < size; counter++) {
    previous = await hmac(prk, concat(previous, info, Uint8Array.of(counter)));
    parts.push(previous);
  }
  return concat(...parts).slice(0, size);
};

describe('Web Push adapter', () => {
  it('solo acepta endpoints HTTPS de servicios push conocidos', () => {
    expect(isSafePushEndpoint('https://fcm.googleapis.com/fcm/send/token')).toBe(true);
    expect(isSafePushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/token')).toBe(true);
    expect(isSafePushEndpoint('https://web.push.apple.com/token')).toBe(true);
    expect(isSafePushEndpoint('http://fcm.googleapis.com/token')).toBe(false);
    expect(isSafePushEndpoint('https://127.0.0.1/token')).toBe(false);
    expect(isSafePushEndpoint('https://example.com/token')).toBe(false);
    expect(isSafePushEndpoint('https://fcm.googleapis.com:8443/token')).toBe(false);
  });

  it('encrypts a payload with the subscription keys and signs a VAPID JWT', async () => {
    const client = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const clientPublic = new Uint8Array(await crypto.subtle.exportKey('raw', client.publicKey));
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const vapid = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const vapidPrivate = await crypto.subtle.exportKey('jwk', vapid.privateKey);
    const vapidPublic = await crypto.subtle.exportKey('jwk', vapid.publicKey);
    const publicKey = encode(concat(Uint8Array.of(4), decode(vapidPublic.x!), decode(vapidPublic.y!)));
    const privateKey = vapidPrivate.d!;
    const sent: { url: string; headers: Headers; body: PushBytes } = { url: '', headers: new Headers(), body: new Uint8Array() };
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      sent.url = String(url);
      sent.headers = new Headers(init?.headers);
      sent.body = new Uint8Array(init?.body as ArrayBuffer);
      return new Response(null, { status: 201 });
    });

    const payload = { title: 'Rest over', tag: 'rest-timer' };
    const response = await sendWebPush(
      { endpoint: 'https://fcm.googleapis.com/fcm/send/token', p256dh: encode(clientPublic), auth: encode(authSecret) },
      payload,
      { publicKey, privateKey, subject: 'mailto:push@example.test' },
      fetcher,
    );

    expect(response.status).toBe(201);
    expect(sent.url).toBe('https://fcm.googleapis.com/fcm/send/token');
    expect(sent.headers.get('content-encoding')).toBe('aes128gcm');
    expect(sent.headers.get('authorization')).toMatch(/^vapid t=/);
    const body = sent.body;
    const salt = body.slice(0, 16);
    const idLength = body[20];
    const serverPublic = body.slice(21, 21 + idLength);
    const encrypted = body.slice(21 + idLength);
    const serverKey = await crypto.subtle.importKey('raw', toArrayBuffer(serverPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: serverKey }, client.privateKey, 256));
    const authPrk = await hmac(authSecret, shared);
    const keyInfo = concat(new TextEncoder().encode('WebPush: info\0'), clientPublic, serverPublic);
    const ikm = await expand(authPrk, keyInfo, 32);
    const prk = await hmac(salt, ikm);
    const cek = await expand(prk, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
    const nonce = await expand(prk, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
    const aesKey = await crypto.subtle.importKey('raw', toArrayBuffer(cek), 'AES-GCM', false, ['decrypt']);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, aesKey, toArrayBuffer(encrypted)));

    expect(plaintext.at(-1)).toBe(2);
    expect(JSON.parse(new TextDecoder().decode(plaintext.slice(0, -1)))).toEqual(payload);
  });

  it('rechaza un endpoint fuera del allowlist antes de llamar a fetch', async () => {
    const fetcher = vi.fn();
    await expect(sendWebPush({ endpoint: 'https://example.com/x', p256dh: '', auth: '' }, {}, { publicKey: '', privateKey: '', subject: '' }, fetcher)).rejects.toThrow('unsafe_push_endpoint');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('valida las claves de suscripción y no conserva un deviceId con forma incorrecta', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
    const parsed = parsePushSubscription({
      endpoint: 'https://fcm.googleapis.com/fcm/send/token',
      keys: { p256dh: encode(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))), auth: encode(crypto.getRandomValues(new Uint8Array(16))) },
      deviceId: 'bad/id',
    });
    expect(parsed).toMatchObject({ endpoint: 'https://fcm.googleapis.com/fcm/send/token' });
    expect(parsed).not.toHaveProperty('deviceId');
    expect(parsePushSubscription({ endpoint: 'https://example.com/x', keys: { p256dh: 'bad', auth: 'bad' } })).toBeNull();
  });

  it('activa VAPID solo con una pareja de claves y subject válidos', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
    const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const priv = await crypto.subtle.exportKey('jwk', pair.privateKey);
    const config = pushVapidConfig({
      VAPID_PUBLIC_KEY: encode(concat(Uint8Array.of(4), decode(pub.x!), decode(pub.y!))),
      VAPID_PRIVATE_KEY: priv.d,
      VAPID_SUBJECT: 'mailto:push@example.test',
    });
    expect(config).toMatchObject({ subject: 'mailto:push@example.test' });
    expect(pushVapidConfig({})).toBeNull();
  });
});

const DOMAIN = 'opengym/pairing/v2'
// Media travels as independently encrypted chunks so every Worker-buffered object stays small.
export const PAIR_MEDIA_MAX_CIPHERTEXT_BYTES = 8 * 1024 * 1024
export const PAIR_MEDIA_CHUNK_BYTES = 4 * 1024 * 1024
const encoder = new TextEncoder()
const decoder = new TextDecoder()

function encode(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decode(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

async function derive(master, label) {
  const key = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: encoder.encode(`${DOMAIN}/salt`),
    info: encoder.encode(`${DOMAIN}/${label}`),
  }, key, 256)
  return new Uint8Array(bits)
}

export async function createPairingV2() {
  const master = crypto.getRandomValues(new Uint8Array(32))
  const [locator, authorization, encryption, objectIds] = await Promise.all([
    derive(master, 'locator'),
    derive(master, 'authorization'),
    derive(master, 'encryption'),
    derive(master, 'object-id'),
  ])
  const pairId = encode(locator)
  const authKey = encode(authorization)
  const encryptionKey = await crypto.subtle.importKey('raw', encryption, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
  const objectIdKey = await crypto.subtle.importKey('raw', objectIds, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return { pairId, authKey, encryptionKey, objectIdKey, fragment: `#pair-v2=${encode(master)}` }
}

export async function openPairingV2(code) {
  const master = decode(String(code || ''))
  if (master.byteLength !== 32) throw new Error('invalid_pairing_code')
  const [locator, authorization, encryption, objectIds] = await Promise.all([
    derive(master, 'locator'),
    derive(master, 'authorization'),
    derive(master, 'encryption'),
    derive(master, 'object-id'),
  ])
  return {
    pairId: encode(locator),
    authKey: encode(authorization),
    encryptionKey: await crypto.subtle.importKey('raw', encryption, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']),
    objectIdKey: await crypto.subtle.importKey('raw', objectIds, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    fragment: `#pair-v2=${encode(master)}`,
  }
}

export function takePairingFragment(location = window.location, history = window.history) {
  const match = /^#pair-v2=([A-Za-z0-9_-]{43})$/.exec(location.hash)
  if (!match) return null
  const code = match[1]
  history.replaceState(history.state, '', `${location.pathname}${location.search}`)
  return code
}

export function pairingLink(baseUrl, pairing) {
  const url = new URL(baseUrl)
  url.hash = `pair-v2=${encode(decode(pairing.fragment.slice('#pair-v2='.length)))}`
  return url.toString()
}

const aadFor = (pairId, revision, objectId = '') => encoder.encode(JSON.stringify({ protocol: DOMAIN, pairId, revision, objectId }))

export async function pairObjectId(pairing, value) {
  if (!pairing?.objectIdKey) throw new Error('pair_object_id_key_unavailable')
  const plain = value instanceof Uint8Array ? value : new Uint8Array(value)
  const digest = await crypto.subtle.sign('HMAC', pairing.objectIdKey, plain)
  return encode(new Uint8Array(digest))
}

export async function pairMediaChunkObjectId(pairing, hash, index) {
  if (!pairing?.objectIdKey) throw new Error('pair_object_id_key_unavailable')
  if (!/^[0-9a-f]{64}$/.test(hash) || !Number.isSafeInteger(index) || index < 0) {
    throw new Error('invalid_pair_media_chunk_id')
  }
  const input = encoder.encode(`${DOMAIN}/media-chunk/v2\0${hash}\0${index}`)
  const digest = await crypto.subtle.sign('HMAC', pairing.objectIdKey, input)
  return encode(new Uint8Array(digest))
}

export async function encryptPairBytes(value, pairing, { revision, objectId = '' }) {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('invalid_pair_revision')
  const plain = value instanceof Uint8Array ? value : new Uint8Array(value)
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv: nonce,
    additionalData: aadFor(pairing.pairId, revision, objectId),
    tagLength: 128,
  }, pairing.encryptionKey, plain))
  const result = new Uint8Array(nonce.byteLength + ciphertext.byteLength)
  result.set(nonce)
  result.set(ciphertext, nonce.byteLength)
  return result
}

export async function decryptPairBytes(value, pairing, { revision, objectId = '' }) {
  const encrypted = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (encrypted.byteLength < 29) throw new Error('invalid_pair_ciphertext')
  const plain = await crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: encrypted.subarray(0, 12),
    additionalData: aadFor(pairing.pairId, revision, objectId),
    tagLength: 128,
  }, pairing.encryptionKey, encrypted.subarray(12))
  return new Uint8Array(plain)
}

export async function encryptPairState(state, pairing, revision) {
  return encryptPairBytes(encoder.encode(JSON.stringify(state)), pairing, { revision })
}

export async function decryptPairState(ciphertext, pairing, revision) {
  const clear = await decryptPairBytes(ciphertext, pairing, { revision })
  return JSON.parse(decoder.decode(clear))
}

const pairHeaders = pairing => ({ Authorization: `Pair ${pairing.authKey}` })

export async function putPairSnapshot(pairing, baseRevision, ciphertext, fetchImpl = fetch) {
  const response = await fetchImpl('/api/pair/v2', {
    method: 'PUT',
    credentials: 'omit',
    cache: 'no-store',
    headers: {
      ...pairHeaders(pairing),
      'X-Pair-Id': pairing.pairId,
      'Content-Type': 'application/octet-stream',
      'If-Match': `"${baseRevision}"`,
    },
    body: ciphertext,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status, data: body })
  return body
}

export async function getPairSnapshot(pairing, { ifRevision, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`/api/pair/v2?id=${encodeURIComponent(pairing.pairId)}`, {
    method: 'GET', credentials: 'omit', cache: 'no-store', headers: {
      ...pairHeaders(pairing), ...(Number.isSafeInteger(ifRevision) ? { 'If-None-Match': `"${ifRevision}"` } : {}),
    },
  })
  if (response.status === 304) return { unchanged: true, revision: ifRevision }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status, data: body })
  }
  const revision = Number(response.headers.get('X-Pair-Revision'))
  const ciphertextSha256 = response.headers.get('X-Pair-SHA256') || ''
  const ciphertext = new Uint8Array(await response.arrayBuffer())
  return { revision, ciphertextSha256, ciphertext }
}

export async function putPairMedia(pairing, objectId, ciphertext, fetchImpl = fetch) {
  const bytes = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext)
  if (bytes.byteLength < 29 || bytes.byteLength > PAIR_MEDIA_MAX_CIPHERTEXT_BYTES) throw new Error('invalid_pair_media_size')
  const response = await fetchImpl(`/api/pair/v2/media?id=${encodeURIComponent(pairing.pairId)}&objectId=${encodeURIComponent(objectId)}`, {
    method: 'PUT', credentials: 'omit', cache: 'no-store',
    headers: { ...pairHeaders(pairing), 'Content-Type': 'application/octet-stream' },
    body: bytes,
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status, data: body })
  const revision = Number(body.createdRevision ?? body.revision)
  if (body.objectId !== objectId || !/^[0-9a-f]{64}$/.test(body.ciphertextSha256 || '')
    || Number(body.ciphertextBytes) !== bytes.byteLength
    || !Number.isSafeInteger(revision) || revision < 1) throw new Error('invalid_pair_media_metadata')
  return { ...body, revision }
}

export async function getPairMedia(pairing, objectId, fetchImpl = fetch) {
  const response = await fetchImpl(`/api/pair/v2/media?id=${encodeURIComponent(pairing.pairId)}&objectId=${encodeURIComponent(objectId)}`, {
    method: 'GET', credentials: 'omit', cache: 'no-store', headers: pairHeaders(pairing),
  })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status, data: body })
  }
  const revision = Number(response.headers.get('X-Pair-Media-Revision'))
  const ciphertextSha256 = response.headers.get('X-Pair-SHA256') || ''
  const ciphertextBytes = Number(response.headers.get('Content-Length'))
  if (!Number.isSafeInteger(revision) || revision < 1
    || !/^[0-9a-f]{64}$/.test(ciphertextSha256)
    || !Number.isSafeInteger(ciphertextBytes) || ciphertextBytes < 29 || ciphertextBytes > PAIR_MEDIA_MAX_CIPHERTEXT_BYTES) {
    throw new Error('invalid_pair_media_metadata')
  }
  const ciphertext = new Uint8Array(await response.arrayBuffer())
  if (ciphertext.byteLength !== ciphertextBytes) throw new Error('invalid_pair_media_size')
  return { revision, ciphertextSha256, ciphertextBytes, ciphertext }
}

export async function revokePairing(pairing, fetchImpl = fetch) {
  const response = await fetchImpl(`/api/pair/v2?id=${encodeURIComponent(pairing.pairId)}`, {
    method: 'DELETE', credentials: 'omit', cache: 'no-store', headers: { ...pairHeaders(pairing), 'Content-Type': 'application/json' },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status, data: body })
  return body
}

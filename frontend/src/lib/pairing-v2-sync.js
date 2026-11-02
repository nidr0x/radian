import { normalizeSyncKey, pullSyncData } from '../../../src/lib/sync.ts'
import { convertRadianBackupState } from '../../../src/lib/radian-conversion.js'
import { getMediaStore } from './media-store.js'
import { normalizeMediaRef, stateMediaRefs } from './media-refs.js'
import { limitsFrom, MB } from './media-limits.js'
import {
  createPairingV2,
  decryptPairBytes,
  decryptPairState,
  encryptPairBytes,
  encryptPairState,
  getPairMedia,
  getPairSnapshot,
  openPairingV2,
  pairObjectId,
  pairMediaChunkObjectId,
  PAIR_MEDIA_CHUNK_BYTES,
  PAIR_MEDIA_MAX_CIPHERTEXT_BYTES,
  pairingLink,
  putPairMedia,
  putPairSnapshot,
  revokePairing,
  takePairingFragment,
} from './pairing-v2.js'

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const same = (a, b) => JSON.stringify({ ...a, _ts: 0 }) === JSON.stringify({ ...b, _ts: 0 })
const exact = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const PAIR_SESSION_KEY = 'radian-pair-v2'
const PAIR_OWNER_SESSION_KEY = 'radian-pair-v2-owner'
const LEGACY_PAIR_SESSION_KEY = 'opengym-pair-v2'
const LEGACY_PAIR_OWNER_SESSION_KEY = 'opengym-pair-v2-owner'
const PAIR_MEDIA_MANIFEST = '__pairV2MediaManifest'
const PAIR_MANIFEST_CIPHERTEXT_LIMIT = 8 * MB
const PAIR_MEDIA_FILE_LIMIT = 4096
const mediaEncoder = new TextEncoder()
const mediaDecoder = new TextDecoder()

function appStateWithoutManifest(value) {
  const { [PAIR_MEDIA_MANIFEST]: _manifest, ...state } = value
  return state
}

function pairMediaFiles(state) {
  const files = new Map()
  const add = (ref, poster = false) => {
    if (!ref || typeof ref.hash !== 'string') return
    const previous = files.get(ref.hash)
    if (previous && (previous.mime !== ref.mime || previous.size !== ref.size)) throw new Error('pair_media_ref_conflict')
    files.set(ref.hash, {
      hash: ref.hash,
      mime: ref.mime,
      size: ref.size,
      poster: poster || !!previous?.poster,
    })
  }
  for (const raw of stateMediaRefs(state)) {
    const ref = normalizeMediaRef(raw)
    if (!ref) continue
    if (ref.poster) add(ref.poster, true)
    add(ref)
  }
  const out = [...files.values()].sort((a, b) => a.hash.localeCompare(b.hash))
  if (out.length > PAIR_MEDIA_FILE_LIMIT) throw new Error('pair_media_limit')
  return out
}

function mediaPlaintextLimit(file, limits) {
  const maxMB = file.mime === 'image/gif'
    ? limits.gifMB
    : file.mime.startsWith('video/') ? limits.videoMB : limits.imageMB
  return Math.floor(maxMB * MB)
}

function hex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function digestHex(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
}

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false
  return true
}

async function blobMatches(blob, file) {
  if (!blob || blob.size !== file.size) return false
  return await digestHex(new Uint8Array(await blob.arrayBuffer())) === file.hash
}

async function validateManifestFiles(manifest, expectedFiles, pairing) {
  if (!isRecord(manifest) || ![1, 2].includes(manifest.version) || !Array.isArray(manifest.files)
    || manifest.files.length !== expectedFiles.length || manifest.files.length > PAIR_MEDIA_FILE_LIMIT) {
    throw new Error('invalid_pair_media_manifest')
  }
  if (manifest.version === 2 && manifest.chunkSize !== PAIR_MEDIA_CHUNK_BYTES) throw new Error('invalid_pair_media_manifest')
  const expected = new Map(expectedFiles.map(file => [file.hash, file]))
  const seen = new Set()
  const seenObjectIds = new Set()
  for (const file of manifest.files) {
    const wanted = expected.get(file?.hash)
    if (!isRecord(file) || !wanted || seen.has(file.hash) || file.mime !== wanted.mime || file.size !== wanted.size
      || file.poster !== wanted.poster) {
      throw new Error('invalid_pair_media_manifest')
    }
    if (manifest.version === 1) {
      if (!/^[A-Za-z0-9_-]{16,96}$/.test(file.objectId || '')
        || !Number.isSafeInteger(file.revision) || file.revision < 1) throw new Error('invalid_pair_media_manifest')
      seenObjectIds.add(file.objectId)
    } else {
      const chunks = file.chunks
      const count = Math.ceil(file.size / manifest.chunkSize)
      if (!Number.isSafeInteger(file.size) || file.size < 1 || !Array.isArray(chunks) || chunks.length !== count) {
        throw new Error('invalid_pair_media_manifest')
      }
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index]
        const size = Math.min(manifest.chunkSize, file.size - index * manifest.chunkSize)
        const expectedObjectId = await pairMediaChunkObjectId(pairing, file.hash, index)
        if (!isRecord(chunk) || chunk.objectId !== expectedObjectId || seenObjectIds.has(chunk.objectId)
          || !Number.isSafeInteger(chunk.revision) || chunk.revision < 1 || chunk.size !== size
          || chunk.size + 28 > PAIR_MEDIA_MAX_CIPHERTEXT_BYTES) throw new Error('invalid_pair_media_manifest')
        seenObjectIds.add(chunk.objectId)
      }
    }
    seen.add(file.hash)
  }
  return { version: manifest.version, chunkSize: manifest.version === 2 ? manifest.chunkSize : null, files: manifest.files }
}

function requireState(value) {
  if (!isRecord(value)
    || (value.workouts !== undefined && !Array.isArray(value.workouts))
    || (value.routines !== undefined && !Array.isArray(value.routines))
    || (value.bodyweight !== undefined && !Array.isArray(value.bodyweight))
    || (value.measurements !== undefined && !Array.isArray(value.measurements))) {
    throw new Error('invalid_pair_state')
  }
  return value
}

async function readVerifiedPairObject(pairing, objectId, fetchImpl, expectedBytes, assertCurrent) {
  const remote = await getPairMedia(pairing, objectId, fetchImpl)
  assertCurrent()
  if (expectedBytes && remote.ciphertextBytes !== expectedBytes.byteLength + 28) throw new Error('pair_media_object_size_mismatch')
  if (await digestHex(remote.ciphertext) !== remote.ciphertextSha256) throw new Error('pair_media_ciphertext_hash_mismatch')
  const plain = await decryptPairBytes(remote.ciphertext, pairing, { revision: remote.revision, objectId })
  assertCurrent()
  if (expectedBytes && !bytesEqual(plain, expectedBytes)) throw new Error('pair_media_object_mismatch')
  return { ...remote, plain }
}

async function ensurePairObject(pairing, objectId, plain, revision, fetchImpl, assertCurrent,
  maxCiphertextBytes = PAIR_MEDIA_MAX_CIPHERTEXT_BYTES, contentAddressed = true) {
  if (contentAddressed && await pairObjectId(pairing, plain) !== objectId) throw new Error('pair_media_object_id_mismatch')
  assertCurrent()
  if (plain.byteLength + 28 > maxCiphertextBytes) throw new Error('pair_media_too_large')
  const ciphertext = await encryptPairBytes(plain, pairing, { revision, objectId })
  const ciphertextSha256 = await digestHex(ciphertext)
  assertCurrent()
  let uploaded
  try {
    uploaded = await putPairMedia(pairing, objectId, ciphertext, fetchImpl)
  } catch (uploadError) {
    // A lost response or a concurrent retry may have stored the immutable object already.
    try { return await readVerifiedPairObject(pairing, objectId, fetchImpl, plain, assertCurrent) }
    catch (readError) {
      if (readError?.status === 404) throw uploadError
      throw readError
    }
  }
  assertCurrent()
  const responseMatchesUpload = uploaded.ciphertextBytes === ciphertext.byteLength
    && uploaded.ciphertextSha256 === ciphertextSha256
  const verified = await readVerifiedPairObject(pairing, objectId, fetchImpl, plain, assertCurrent)
  if (responseMatchesUpload && verified.revision !== uploaded.revision) throw new Error('pair_media_revision_mismatch')
  return verified
}

async function preparePairState(state, pairing, revision, owner, mediaStore, fetchImpl, assertCurrent, loadMediaLimits, knownLimits = null) {
  const cleanState = appStateWithoutManifest(requireState(state))
  const files = pairMediaFiles(cleanState)
  if (!files.length) return cleanState
  const limits = knownLimits || await loadMediaLimits(assertCurrent)
  assertCurrent()
  if (!mediaStore || mediaStore.owner !== owner) throw new Error('pair_media_owner_mismatch')
  await mediaStore.ready(owner)
  assertCurrent()

  const manifestFiles = []
  for (const file of files) {
    assertCurrent()
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > mediaPlaintextLimit(file, limits)) {
      throw new Error('pair_media_too_large')
    }
    const local = await mediaStore.get(file.hash, owner)
    assertCurrent()
    if (!local?.blob || local.mime !== file.mime || local.size !== file.size || local.blob.size !== file.size) {
      throw new Error('pair_media_local_missing')
    }
    const plain = new Uint8Array(await local.blob.arrayBuffer())
    assertCurrent()
    if (await digestHex(plain) !== file.hash) throw new Error('pair_media_local_hash_mismatch')
    const chunks = []
    for (let index = 0, offset = 0; offset < plain.byteLength; index += 1, offset += PAIR_MEDIA_CHUNK_BYTES) {
      assertCurrent()
      const bytes = plain.subarray(offset, Math.min(offset + PAIR_MEDIA_CHUNK_BYTES, plain.byteLength))
      const objectId = await pairMediaChunkObjectId(pairing, file.hash, index)
      assertCurrent()
      const stored = await ensurePairObject(pairing, objectId, bytes, revision, fetchImpl, assertCurrent,
        PAIR_MEDIA_MAX_CIPHERTEXT_BYTES, false)
      chunks.push({ objectId, revision: stored.revision, size: bytes.byteLength })
    }
    manifestFiles.push({ ...file, chunks })
  }

  const manifestBytes = mediaEncoder.encode(JSON.stringify({ version: 2, chunkSize: PAIR_MEDIA_CHUNK_BYTES, files: manifestFiles }))
  if (manifestBytes.byteLength + 28 > PAIR_MANIFEST_CIPHERTEXT_LIMIT) throw new Error('pair_media_manifest_too_large')
  const objectId = await pairObjectId(pairing, manifestBytes)
  assertCurrent()
  const stored = await ensurePairObject(pairing, objectId, manifestBytes, revision, fetchImpl, assertCurrent, PAIR_MANIFEST_CIPHERTEXT_LIMIT)
  return { ...cleanState, [PAIR_MEDIA_MANIFEST]: { objectId, revision: stored.revision } }
}

async function recoverPairState(value, pairing, owner, mediaStore, fetchImpl, assertCurrent) {
  const storedState = requireState(value)
  const state = appStateWithoutManifest(storedState)
  const expectedFiles = pairMediaFiles(state)
  const pointer = storedState[PAIR_MEDIA_MANIFEST]
  if (!pointer) {
    if (expectedFiles.length) throw new Error('pair_media_manifest_missing')
    return state
  }
  if (!isRecord(pointer) || !/^[A-Za-z0-9_-]{16,96}$/.test(pointer.objectId || '')
    || !Number.isSafeInteger(pointer.revision) || pointer.revision < 1) {
    throw new Error('invalid_pair_media_manifest_pointer')
  }
  if (!expectedFiles.length) return state

  const encryptedManifest = await getPairMedia(pairing, pointer.objectId, fetchImpl)
  assertCurrent()
  if (encryptedManifest.revision !== pointer.revision
    || encryptedManifest.ciphertextBytes > PAIR_MANIFEST_CIPHERTEXT_LIMIT
    || await digestHex(encryptedManifest.ciphertext) !== encryptedManifest.ciphertextSha256) {
    throw new Error('pair_media_manifest_metadata_mismatch')
  }
  const manifestBytes = await decryptPairBytes(encryptedManifest.ciphertext, pairing, {
    revision: encryptedManifest.revision,
    objectId: pointer.objectId,
  })
  assertCurrent()
  if (await pairObjectId(pairing, manifestBytes) !== pointer.objectId) throw new Error('pair_media_manifest_id_mismatch')
  let manifest
  try { manifest = JSON.parse(mediaDecoder.decode(manifestBytes)) }
  catch { throw new Error('invalid_pair_media_manifest') }
  const validatedManifest = await validateManifestFiles(manifest, expectedFiles, pairing)

  // Fetch and verify every object before changing the owner-scoped local store.
  const staged = []
  for (const file of validatedManifest.files) {
    assertCurrent()
    let plain
    if (validatedManifest.version === 1) {
      const encrypted = await getPairMedia(pairing, file.objectId, fetchImpl)
      assertCurrent()
      if (encrypted.ciphertextBytes !== file.size + 28
        || encrypted.ciphertextBytes > PAIR_MEDIA_MAX_CIPHERTEXT_BYTES
        || encrypted.revision !== file.revision
        || await digestHex(encrypted.ciphertext) !== encrypted.ciphertextSha256) {
        throw new Error('pair_media_metadata_mismatch')
      }
      plain = await decryptPairBytes(encrypted.ciphertext, pairing, { revision: file.revision, objectId: file.objectId })
      assertCurrent()
    } else {
      plain = new Uint8Array(file.size)
      let offset = 0
      for (const chunk of file.chunks) {
        assertCurrent()
        const encrypted = await getPairMedia(pairing, chunk.objectId, fetchImpl)
        assertCurrent()
        if (encrypted.ciphertextBytes !== chunk.size + 28
          || encrypted.ciphertextBytes > PAIR_MEDIA_MAX_CIPHERTEXT_BYTES
          || encrypted.revision !== chunk.revision
          || await digestHex(encrypted.ciphertext) !== encrypted.ciphertextSha256) {
          throw new Error('pair_media_chunk_metadata_mismatch')
        }
        const bytes = await decryptPairBytes(encrypted.ciphertext, pairing, { revision: chunk.revision, objectId: chunk.objectId })
        assertCurrent()
        if (bytes.byteLength !== chunk.size || offset + bytes.byteLength > plain.byteLength) {
          throw new Error('pair_media_chunk_size_mismatch')
        }
        plain.set(bytes, offset)
        offset += bytes.byteLength
      }
      if (offset !== plain.byteLength) throw new Error('pair_media_chunk_size_mismatch')
    }
    if (plain.byteLength !== file.size || await digestHex(plain) !== file.hash) throw new Error('pair_media_hash_mismatch')
    staged.push({ file, plain })
  }

  if (!mediaStore || mediaStore.owner !== owner) throw new Error('pair_media_owner_mismatch')
  await mediaStore.ready(owner)
  assertCurrent()
  for (const { file, plain } of staged) {
    assertCurrent()
    const current = await mediaStore.get(file.hash, owner)
    assertCurrent()
    const valid = current?.mime === file.mime && current.size === file.size && await blobMatches(current.blob, file)
    assertCurrent()
    if (!valid) {
      if (current) {
        await mediaStore.remove(file.hash, owner)
        assertCurrent()
      }
      // Pair R2 does not satisfy the separate authenticated-account media upload.
      await mediaStore.put(file.hash, new Blob([plain], { type: file.mime }), { mime: file.mime, pending: true, owner })
      assertCurrent()
    }
  }
  for (const { file } of staged) {
    assertCurrent()
    const readback = await mediaStore.get(file.hash, owner)
    assertCurrent()
    if (readback?.mime !== file.mime || readback.size !== file.size || !await blobMatches(readback.blob, file)) {
      throw new Error('pair_media_local_readback_mismatch')
    }
  }
  return state
}

export function createPairingV2Client({ store, fetchImpl = fetch, autoSync = true, baseUrl, sessionStorageImpl, mediaStoreImpl } = {}) {
  const mediaStore = mediaStoreImpl || getMediaStore()
  let pairing = null
  let pairOwner = null
  let pairingGeneration = 0
  let sessionGeneration = 0
  let revision = 0
  let remoteState = null
  let syncPromise = null
  let syncPromiseGeneration = null
  let pollTimer = null
  let changeTimer = null
  let unsubscribeStore = null
  let status = { active: false, revision: 0, error: null, link: null, restorable: false }
  const listeners = new Set()
  let sessionStorage = sessionStorageImpl
  if (sessionStorage === undefined) {
    try { sessionStorage = globalThis.sessionStorage } catch { sessionStorage = null }
  }

  const publish = patch => {
    status = { ...status, ...patch }
    for (const listener of listeners) listener(status)
  }
  const linkFor = current => {
    const url = new URL(baseUrl || globalThis.location?.href || 'https://localhost/')
    url.search = ''
    url.hash = ''
    return pairingLink(url.toString(), current)
  }
  const readState = () => requireState(store?.getState?.()?.S)
  const currentOwner = () => {
    const id = store?.getState?.()?.user?.id
    return typeof id === 'string' && id ? id : 'guest'
  }
  const assertOwner = owner => {
    if (currentOwner() !== owner) throw new Error('pair_owner_changed_requires_reopen')
  }
  const assertOpening = (owner, generation) => {
    if (sessionGeneration !== generation) throw new Error('pair_session_replaced')
    assertOwner(owner)
  }
  const loadMediaLimits = async assertCurrent => {
    const current = store?.getState?.()
    let config = current?.config
    if (!config && typeof current?.loadConfig === 'function') {
      config = await current.loadConfig()
      assertCurrent?.()
    }
    return limitsFrom(config)
  }
  const assertSession = (current, owner, generation) => {
    if (pairing !== current || pairingGeneration !== generation || sessionGeneration !== generation) throw new Error('pair_session_replaced')
    if (pairOwner !== owner || currentOwner() !== owner) {
      stopAutoSync()
      throw new Error('pair_owner_changed_requires_reopen')
    }
  }
  const storeCode = (current, owner) => {
    try {
      if (!sessionStorage) return false
      sessionStorage.setItem(PAIR_SESSION_KEY, current.fragment.slice('#pair-v2='.length))
      sessionStorage.setItem(PAIR_OWNER_SESSION_KEY, JSON.stringify({ pairId: current.pairId, owner }))
      sessionStorage.removeItem(LEGACY_PAIR_SESSION_KEY)
      sessionStorage.removeItem(LEGACY_PAIR_OWNER_SESSION_KEY)
      return true
    }
    catch { return false }
  }
  const savedValue = (key, legacyKey) => {
    try {
      const current = sessionStorage?.getItem(key)
      if (current) return current
      const legacy = sessionStorage?.getItem(legacyKey)
      if (!legacy) return null
      sessionStorage?.setItem(key, legacy)
      sessionStorage?.removeItem(legacyKey)
      return legacy
    } catch { return null }
  }
  const savedCode = () => savedValue(PAIR_SESSION_KEY, LEGACY_PAIR_SESSION_KEY)
  const savedPairOwner = pairId => {
    try {
      const saved = JSON.parse(savedValue(PAIR_OWNER_SESSION_KEY, LEGACY_PAIR_OWNER_SESSION_KEY) || 'null')
      return saved?.pairId === pairId && typeof saved.owner === 'string' ? saved.owner : null
    } catch { return null }
  }
  const clearStoredCode = () => {
    try {
      sessionStorage?.removeItem(PAIR_SESSION_KEY)
      sessionStorage?.removeItem(PAIR_OWNER_SESSION_KEY)
      sessionStorage?.removeItem(LEGACY_PAIR_SESSION_KEY)
      sessionStorage?.removeItem(LEGACY_PAIR_OWNER_SESSION_KEY)
    }
    catch { /* private mode */ }
  }
  const mergeRemote = (state, assertCurrent) => {
    assertCurrent?.()
    const merge = store?.getState?.()?.mergePairedState
    if (typeof merge !== 'function') throw new Error('pair_state_merge_unavailable')
    merge(requireState(state))
    assertCurrent?.()
  }

  const stopAutoSync = () => {
    clearInterval(pollTimer); pollTimer = null
    clearTimeout(changeTimer); changeTimer = null
    unsubscribeStore?.(); unsubscribeStore = null
    globalThis.removeEventListener?.('online', sync)
    globalThis.document?.removeEventListener?.('visibilitychange', onVisibility)
  }
  const schedule = () => {
    if (!autoSync || !pairing || changeTimer) return
    changeTimer = setTimeout(() => { changeTimer = null; void sync() }, 500)
  }
  const onVisibility = () => { if (globalThis.document?.visibilityState !== 'hidden') void sync() }
  const startAutoSync = () => {
    if (!autoSync || !pairing) return
    if (!unsubscribeStore && typeof store?.subscribe === 'function') {
      unsubscribeStore = store.subscribe((next, previous) => { if (next?.S !== previous?.S) schedule() })
    }
    if (!pollTimer) pollTimer = setInterval(() => { void sync() }, 15000)
    globalThis.addEventListener?.('online', sync)
    globalThis.document?.addEventListener?.('visibilitychange', onVisibility)
  }

  async function sync() {
    if (!pairing) throw new Error('pair_not_connected')
    const currentPairing = pairing
    const owner = pairOwner
    const generation = sessionGeneration
    const assertCurrent = () => assertSession(currentPairing, owner, generation)
    assertCurrent()
    if (syncPromise && syncPromiseGeneration === generation) return syncPromise
    let run
    run = (async () => {
      publish({ error: null, syncing: true })
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          assertCurrent()
          const snapshot = await getPairSnapshot(currentPairing, { ifRevision: revision, fetchImpl })
          assertCurrent()
          if (!snapshot.unchanged) {
            const decoded = requireState(await decryptPairState(snapshot.ciphertext, currentPairing, snapshot.revision))
            assertCurrent()
            const recovered = await recoverPairState(decoded, currentPairing, owner, mediaStore, fetchImpl, assertCurrent)
            assertCurrent()
            mergeRemote(recovered, assertCurrent)
            assertCurrent()
            remoteState = recovered
            revision = snapshot.revision
          }
          assertCurrent()
          const local = readState()
          if (same(local, remoteState)) {
            assertCurrent()
            publish({ active: true, revision, syncing: false, error: null })
            return { revision, changed: false }
          }
          const nextRevision = revision + 1
          try {
            const prepared = await preparePairState(local, currentPairing, nextRevision, owner, mediaStore, fetchImpl, assertCurrent, loadMediaLimits)
            assertCurrent()
            const encrypted = await encryptPairState(prepared, currentPairing, nextRevision)
            assertCurrent()
            const result = await putPairSnapshot(currentPairing, revision, encrypted, fetchImpl)
            assertCurrent()
            if (result.revision !== nextRevision) throw new Error('pair_snapshot_revision_mismatch')
            revision = result.revision
            remoteState = JSON.parse(JSON.stringify(local))
            publish({ active: true, revision, syncing: false, error: null })
            return { revision, changed: true }
          } catch (error) {
            if (error?.status !== 409 || attempt === 2) throw error
          }
        }
        throw Object.assign(new Error('pair_conflict'), { status: 409 })
      } catch (error) {
        let revoked = false
        if (pairing === currentPairing && sessionGeneration === generation && error?.status === 410) {
          clearStoredCode()
          pairing = null
          pairOwner = null
          pairingGeneration = 0
          remoteState = null
          revision = 0
          stopAutoSync()
          revoked = true
        }
        if (revoked) {
          publish({ active: false, revision: 0, syncing: false, error: error?.message || 'pair_revoked' })
        } else if (pairing === currentPairing && sessionGeneration === generation) {
          if (currentOwner() !== owner) stopAutoSync()
          publish({ active: !!pairing, revision, syncing: false, error: error?.message || 'pair_sync_failed' })
        }
        throw error
      } finally {
        if (syncPromise === run) {
          syncPromise = null
          syncPromiseGeneration = null
        }
      }
    })()
    syncPromise = run
    syncPromiseGeneration = generation
    return run
  }

  async function createFromState(state, owner, generation) {
    const nextPairing = await createPairingV2()
    const assertCurrent = () => assertOpening(owner, generation)
    try {
      assertCurrent()
      const cleanState = appStateWithoutManifest(requireState(state))
      const files = pairMediaFiles(cleanState)
      const mediaLimits = files.length ? await loadMediaLimits(assertCurrent) : null
      assertCurrent()
      if (mediaLimits) {
        for (const file of files) {
          if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > mediaPlaintextLimit(file, mediaLimits)) {
            throw new Error('pair_media_too_large')
          }
        }
      }
      const hasMedia = files.length > 0
      let baseRevision = 0
      let nextRevision = 1
      if (hasMedia) {
        // Media routes authorize an existing channel. Stage an encrypted empty snapshot,
        // then publish references only after every media object and the manifest are verified.
        const stagingState = { routines: [], workouts: [], bodyweight: [], measurements: [], customEx: [] }
        const stagingCiphertext = await encryptPairState(stagingState, nextPairing, 1)
        assertCurrent()
        const stagingResult = await putPairSnapshot(nextPairing, 0, stagingCiphertext, fetchImpl)
        assertCurrent()
        if (stagingResult.revision !== 1) throw new Error('pair_staging_revision_mismatch')
        const stagingReadback = await getPairSnapshot(nextPairing, { fetchImpl })
        assertCurrent()
        const verifiedStaging = requireState(await decryptPairState(stagingReadback.ciphertext, nextPairing, stagingReadback.revision))
        assertCurrent()
        if (stagingReadback.revision !== 1 || !exact(verifiedStaging, stagingState)) throw new Error('pair_staging_readback_mismatch')
        baseRevision = 1
        nextRevision = 2
      }
      const prepared = await preparePairState(cleanState, nextPairing, nextRevision, owner, mediaStore, fetchImpl, assertCurrent, loadMediaLimits, mediaLimits)
      assertCurrent()
      const ciphertext = await encryptPairState(prepared, nextPairing, nextRevision)
      assertCurrent()
      const result = await putPairSnapshot(nextPairing, baseRevision, ciphertext, fetchImpl)
      assertCurrent()
      if (result.revision !== nextRevision) throw new Error('pair_snapshot_revision_mismatch')
      const readback = await getPairSnapshot(nextPairing, { fetchImpl })
      assertCurrent()
      const decoded = requireState(await decryptPairState(readback.ciphertext, nextPairing, readback.revision))
      assertCurrent()
      if (readback.revision !== result.revision || !exact(decoded, prepared)) throw new Error('pair_readback_mismatch')
      const verified = cleanState
      stopAutoSync()
      pairing = nextPairing
      pairOwner = owner
      pairingGeneration = generation
      revision = readback.revision
      remoteState = verified
      const restorable = storeCode(pairing, owner)
      const link = linkFor(pairing)
      publish({ active: true, revision, error: null, link, pairId: pairing.pairId, restorable, syncing: false })
      startAutoSync()
      return { link, pairing, state: verified, verified: true }
    } catch (error) {
      await revokePairing(nextPairing, fetchImpl).catch(() => {})
      throw error
    }
  }

  async function create() {
    if (pairing) throw new Error('pair_already_active')
    const owner = currentOwner()
    const generation = ++sessionGeneration
    const state = readState()
    assertOpening(owner, generation)
    return createFromState(state, owner, generation)
  }

  async function openCode(code, { resume = false } = {}) {
    const raw = String(code || '').replace(/^#?pair-v2=/, '')
    stopAutoSync()
    const owner = currentOwner()
    const generation = ++sessionGeneration
    const assertCurrent = () => assertOpening(owner, generation)
    try {
      const nextPairing = await openPairingV2(raw)
      assertCurrent()
      if (resume && savedPairOwner(nextPairing.pairId) !== owner) throw new Error('pair_owner_changed_requires_reopen')
      const snapshot = await getPairSnapshot(nextPairing, { fetchImpl })
      assertCurrent()
      if (snapshot.unchanged) throw new Error('pair_snapshot_missing')
      const decoded = requireState(await decryptPairState(snapshot.ciphertext, nextPairing, snapshot.revision))
      assertCurrent()
      const state = await recoverPairState(decoded, nextPairing, owner, mediaStore, fetchImpl, assertCurrent)
      assertCurrent()
      pairing = nextPairing
      pairOwner = owner
      pairingGeneration = generation
      revision = snapshot.revision
      remoteState = state
      const restorable = storeCode(pairing, owner)
      const link = linkFor(pairing)
      const assertSessionCurrent = () => assertSession(nextPairing, owner, generation)
      mergeRemote(state, assertSessionCurrent)
      publish({ active: true, revision, error: null, link, pairId: pairing.pairId, restorable, syncing: false })
      startAutoSync()
      await sync()
      return { link, pairing, state: remoteState, verified: true }
    } catch (error) {
      if (sessionGeneration === generation) {
        if (pairing && pairOwner === currentOwner()) {
          pairingGeneration = generation
          startAutoSync()
        }
        publish({ active: !!pairing, error: error?.message || 'pair_open_failed', syncing: false })
      }
      throw error
    }
  }

  async function open(code) {
    return openCode(code)
  }

  async function migrateLegacy(key) {
    if (pairing) throw new Error('pair_already_active')
    const owner = currentOwner()
    const generation = ++sessionGeneration
    const assertCurrent = () => assertOpening(owner, generation)
    const normalized = normalizeSyncKey(String(key || ''))
    const remote = await pullSyncData(normalized, fetchImpl)
    assertCurrent()
    if (!remote.data) throw new Error('legacy_pair_not_found')
    const converted = convertRadianBackupState(remote.data)
    mergeRemote(converted, assertCurrent)
    const state = readState()
    assertCurrent()
    return createFromState(state, owner, generation)
  }

  async function openFromLocation() {
    const linkedCode = takePairingFragment()
    const code = linkedCode || savedCode()
    if (!code) return null
    if (store?.getState?.()?.ready === false) {
      await new Promise(resolve => {
        const unsubscribe = store.subscribe(state => {
          if (!state?.ready) return
          unsubscribe()
          resolve()
        })
      })
    }
    try { return await openCode(code, { resume: !linkedCode }) }
    catch (error) {
      if (error?.status === 410) clearStoredCode()
      publish({ active: !!pairing, error: error?.message || 'pair_open_failed' })
      return null
    }
  }

  async function resume() {
    const code = savedCode()
    return code ? openCode(code, { resume: true }) : null
  }

  async function revoke() {
    if (!pairing) return false
    const currentPairing = pairing
    const owner = pairOwner
    const generation = sessionGeneration
    const assertCurrent = () => assertSession(currentPairing, owner, generation)
    assertCurrent()
    await revokePairing(currentPairing, fetchImpl)
    assertCurrent()
    disconnect()
    return true
  }

  function disconnect() {
    stopAutoSync()
    sessionGeneration += 1
    clearStoredCode()
    pairing = null
    pairOwner = null
    pairingGeneration = 0
    revision = 0
    remoteState = null
    publish({ active: false, revision: 0, error: null, link: null, pairId: null, restorable: false, syncing: false })
  }

  return {
    create,
    open,
    openFromLocation,
    resume,
    migrateLegacy,
    sync,
    revoke,
    disconnect,
    getStatus: () => ({ ...status }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    close: stopAutoSync,
  }
}

let appClient = null
export function startPairingV2(store) {
  if (!appClient) appClient = createPairingV2Client({ store })
  void appClient.openFromLocation()
  return appClient
}

export function getPairingV2Client() {
  return appClient
}

/* Owner-scoped local storage for user photos, GIFs and videos. MediaRefs keep their existing
 * content hashes; the owner is storage context only and never changes an exported file ID. */
import { MEDIA_MIMES } from './media-refs.js'
import { MOBILE } from './mobile.js'
import { idbBackend } from './media-store-idb.js'
import { fsBackend } from './media-store-fs.js'

const HOUR = 3600000
const recordKey = (owner, hash) => JSON.stringify([owner, hash])
const ownerName = owner => typeof owner === 'string' && owner ? owner : 'guest'
const savedOwner = () => { try { return ownerName(localStorage.getItem('gym_owner')) } catch { return 'guest' } }

/** A backend that forgets everything with the page — the fallback used when IndexedDB is blocked. */
export function memoryBackend() {
  const recs = new Map()
  const blobs = new Map()
  return {
    name: 'memory', persistent: false,
    async open() { return true },
    async all(owner) { return [...recs.values()].filter(r => r.owner === owner).map(r => ({ ...r })) },
    async getBlob(hash, owner) { return blobs.get(recordKey(owner, hash)) || null },
    async put(rec, blob, owner) { const k = recordKey(owner, rec.hash); recs.set(k, { ...rec, owner }); if (blob) blobs.set(k, blob) },
    async patch(hash, fields, owner) { const k = recordKey(owner, hash); const r = recs.get(k); if (r) recs.set(k, { ...r, ...fields }) },
    async remove(hash, owner) { const k = recordKey(owner, hash); recs.delete(k); blobs.delete(k) },
    async clear(owner) { for (const r of [...recs.values()]) if (r.owner === owner) { const k = recordKey(owner, r.hash); recs.delete(k); blobs.delete(k) } }
  }
}

export function playType(mime, canPlayType = defaultCanPlay) {
  if (mime !== 'video/quicktime') return mime
  return canPlayType('video/quicktime') ? mime : 'video/mp4'
}
function defaultCanPlay(type) {
  try { return typeof document !== 'undefined' ? document.createElement('video').canPlayType(type) : '' } catch { return '' }
}

export function createMediaStore(backend, {
  fallback = memoryBackend,
  now = () => Date.now(),
  objectURL = globalThis.URL,
  revokeDelayMs = 30000,
  canPlayType = defaultCanPlay,
  owner: initialOwner = savedOwner()
} = {}) {
  let be = backend
  let opening = null
  let persistent = !!backend.persistent
  let activeOwner = ownerName(initialOwner)
  let ownerEpoch = 0
  const index = new Map()
  const loadedOwners = new Set()
  const loadingOwners = new Map()
  const ownerReady = new Map()
  const listeners = new Set()
  // owner+hash → { owner, url, refs, timer, file }
  const urls = new Map()
  const making = new Map()
  const held = new Map()
  const emit = () => { for (const fn of listeners) { try { fn() } catch { /* a listener's own problem */ } } }
  const open = () => {
    if (!opening) opening = (async () => {
      let ok = false
      try { ok = await be.open() } catch { ok = false }
      if (!ok) { be = fallback(); persistent = false; await be.open() }
      else persistent = !!be.persistent
    })()
    return opening
  }
  const ensureOwner = owner => {
    owner = ownerName(owner)
    if (loadedOwners.has(owner)) return Promise.resolve()
    if (loadingOwners.has(owner)) return loadingOwners.get(owner)
    const loading = (async () => {
      await open()
      try { for (const r of await be.all(owner)) index.set(recordKey(owner, r.hash), { ...r, owner }) }
      catch { /* an empty index then */ }
      loadedOwners.add(owner)
      loadingOwners.delete(owner)
      emit()
    })()
    loadingOwners.set(owner, loading)
    return loading
  }
  const ready = (owner = activeOwner) => {
    owner = ownerName(owner)
    return Promise.resolve(ownerReady.get(owner)).catch(() => {}).then(() => ensureOwner(owner))
  }
  const revokeNow = key => {
    const u = urls.get(key)
    if (!u) return
    clearTimeout(u.timer)
    urls.delete(key)
    if (!u.file) { try { objectURL.revokeObjectURL(u.url) } catch { /* already gone */ } }
  }
  const listFor = owner => [...index.values()].filter(r => r.owner === owner)

  const store = {
    ready,
    setOwner(owner, { copyFrom = null, hashes = [] } = {}) {
      owner = ownerName(owner)
      const previous = activeOwner
      if (owner !== activeOwner) {
        activeOwner = owner
        ownerEpoch++
        for (const [key, entry] of urls) if (entry.owner === previous) revokeNow(key)
      }
      const activate = (async () => {
        await ensureOwner(owner)
        const from = copyFrom && ownerName(copyFrom)
        if (from && from !== owner) {
          await ensureOwner(from)
          for (const hash of new Set(hashes)) {
            if (!hash) continue
            const sourceKey = recordKey(from, hash)
            const targetKey = recordKey(owner, hash)
            if (index.has(targetKey)) continue
            const record = index.get(sourceKey)
            if (!record) continue
            const blob = await be.getBlob(hash, from).catch(() => null)
            if (!blob) continue
            const copied = { ...record, owner }
            await be.put(copied, blob, owner)
            index.set(targetKey, copied)
            emit()
          }
        }
      })()
      ownerReady.set(owner, activate)
      void activate.catch(() => {})
      emit()
      return activate
    },
    get owner() { return activeOwner },
    /** Keep an editor's draft out of GC until it closes. */
    hold(hashes, owner = activeOwner) {
      owner = ownerName(owner)
      const hs = [...new Set(hashes)].filter(Boolean).map(hash => recordKey(owner, hash))
      for (const key of hs) held.set(key, (held.get(key) || 0) + 1)
      let done = false
      return () => {
        if (done) return
        done = true
        for (const key of hs) { const n = (held.get(key) || 0) - 1; if (n > 0) held.set(key, n); else held.delete(key) }
      }
    },
    isHeld(hash, owner = activeOwner) { return held.has(recordKey(ownerName(owner), hash)) },
    get persistent() { return persistent },
    get backendName() { return be.name },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    async migrateLegacy(ownerRefs) {
      await open()
      if (typeof be.migrateLegacy !== 'function') return 0
      const moved = await be.migrateLegacy(ownerRefs)
      if (moved) for (const [owner] of ownerRefs) loadedOwners.delete(ownerName(owner))
      if (moved) await Promise.all([...ownerRefs.keys()].map(ensureOwner))
      emit()
      return moved
    },
    async has(hash, owner = activeOwner) {
      owner = ownerName(owner); await ready(owner)
      return index.has(recordKey(owner, hash))
    },
    async get(hash, owner = activeOwner) {
      owner = ownerName(owner); await ready(owner)
      const r = index.get(recordKey(owner, hash))
      if (!r) return null
      const blob = await be.getBlob(hash, owner).catch(() => null)
      if (!blob) return null
      return { blob, mime: r.mime, size: r.size, pending: !!r.pending, rejected: !!r.rejected }
    },
    async put(hash, blob, { mime, pending = true, owner = activeOwner } = {}) {
      owner = ownerName(owner)
      if (!MEDIA_MIMES[mime]) throw new Error('media-store: not a media type: ' + mime)
      await ready(owner)
      const key = recordKey(owner, hash)
      const t = now(), cur = index.get(key)
      if (cur) {
        const fields = { pending: !!pending, rejected: pending ? !!cur.rejected : false, putAt: t }
        index.set(key, { ...cur, ...fields })
        await be.patch(hash, fields, owner)
      } else {
        const rec = { owner, hash, mime, size: blob.size, putAt: t, shownAt: 0, pending: !!pending, rejected: false }
        await be.put(rec, blob, owner)
        index.set(key, rec)
      }
      emit()
    },
    async url(hash, owner = activeOwner) {
      owner = ownerName(owner)
      const key = recordKey(owner, hash)
      const epoch = owner === activeOwner ? ownerEpoch : null
      await ready(owner)
      if (epoch !== null && epoch !== ownerEpoch) return null
      const have = urls.get(key)
      if (have) { have.refs++; clearTimeout(have.timer); have.timer = null; return have.url }
      if (making.has(key)) {
        const u = await making.get(key)
        if (u) { const e = urls.get(key); if (e) { e.refs++; clearTimeout(e.timer); e.timer = null } }
        return u
      }
      const r = index.get(key)
      if (!r) return null
      const job = (async () => {
        let url = null, file = false
        if (typeof be.fileUrl === 'function') { url = await be.fileUrl(hash, r, owner).catch(() => null); file = !!url }
        if (!url) {
          const blob = await be.getBlob(hash, owner).catch(() => null)
          if (!blob || (epoch !== null && epoch !== ownerEpoch)) return null
          url = objectURL.createObjectURL(new Blob([blob], { type: playType(r.mime, canPlayType) }))
        }
        if (epoch !== null && epoch !== ownerEpoch) {
          if (!file) { try { objectURL.revokeObjectURL(url) } catch { /* already gone */ } }
          return null
        }
        urls.set(key, { owner, url, refs: 0, timer: null, file })
        return url
      })()
      making.set(key, job)
      let url
      try { url = await job } finally { making.delete(key) }
      const entry = url && urls.get(key)
      if (!entry) return null
      entry.refs++
      if (!t0(r.shownAt) || t0(r.shownAt) + HOUR <= now()) {
        r.shownAt = now()
        be.patch(hash, { shownAt: r.shownAt }, owner).catch(() => {})
      }
      return url
    },
    release(hash, owner = activeOwner) {
      const key = recordKey(ownerName(owner), hash), u = urls.get(key)
      if (!u) return
      u.refs = Math.max(0, u.refs - 1)
      if (u.refs || u.timer) return
      u.timer = setTimeout(() => { const cur = urls.get(key); if (cur && !cur.refs) revokeNow(key) }, revokeDelayMs)
    },
    async markSynced(hash, owner = activeOwner) {
      owner = ownerName(owner); await ready(owner)
      const r = index.get(recordKey(owner, hash))
      if (!r || (!r.pending && !r.rejected)) return
      Object.assign(r, { pending: false, rejected: false })
      await be.patch(hash, { pending: false, rejected: false }, owner)
      emit()
    },
    async markRejected(hash, owner = activeOwner) {
      owner = ownerName(owner); await ready(owner)
      const r = index.get(recordKey(owner, hash))
      if (!r || r.rejected) return
      r.rejected = true
      await be.patch(hash, { rejected: true }, owner)
      emit()
    },
    async remove(hash, owner = activeOwner) {
      owner = ownerName(owner); await ready(owner)
      const key = recordKey(owner, hash)
      if (!index.has(key)) return
      revokeNow(key)
      index.delete(key)
      await be.remove(hash, owner).catch(() => {})
      emit()
    },
    async retainOnly(keep, { keepPutAfter = now(), owner = activeOwner } = {}) {
      owner = ownerName(owner); await ready(owner)
      let removed = 0
      for (const r of listFor(owner)) {
        const key = recordKey(owner, r.hash)
        if (keep.has(r.hash) || (r.putAt || 0) >= keepPutAfter) continue
        revokeNow(key)
        index.delete(key)
        await be.remove(r.hash, owner).catch(() => {})
        removed++
      }
      if (removed) emit()
      return removed
    },
    async clearAll(owner = activeOwner) {
      owner = ownerName(owner); await ready(owner)
      for (const [key, u] of urls) if (u.owner === owner) revokeNow(key)
      for (const r of listFor(owner)) index.delete(recordKey(owner, r.hash))
      await be.clear(owner).catch(() => {})
      emit()
    },
    async list(owner = activeOwner) { owner = ownerName(owner); await ready(owner); return listFor(owner).map(r => ({ ...r })) },
    async usage(owner = activeOwner) {
      owner = ownerName(owner); await ready(owner)
      const records = listFor(owner)
      return { bytes: records.reduce((n, r) => n + (r.size || 0), 0), count: records.length }
    },
    async pendingHashes(owner = activeOwner) { await ready(owner); return store.pendingNow(owner) },
    pendingNow(owner = activeOwner) { owner = ownerName(owner); return new Set(listFor(owner).filter(r => r.pending).map(r => r.hash)) },
    rejectedNow(owner = activeOwner) { owner = ownerName(owner); return new Set(listFor(owner).filter(r => r.rejected).map(r => r.hash)) }
  }
  return store
}
const t0 = v => (typeof v === 'number' ? v : 0)

let shared = null
export function getMediaStore() {
  if (!shared) shared = createMediaStore(MOBILE ? fsBackend() : idbBackend())
  return shared
}
export const mediaStoreInUse = () => shared !== null
export function _setMediaStore(s) { shared = s }
export const mediaStore = new Proxy({}, {
  get(_, key) {
    const s = getMediaStore()
    const v = s[key]
    return typeof v === 'function' ? v.bind(s) : v
  }
})

/* Owner-scoped browser media records. The old hash-only database stays available for the
 * conservative migration below; files without a saved owner reference remain there as recovery. */

const DB = 'opengym-media-v2'
const STORE = 'blobs'
const LEGACY_DB = 'opengym-media'
const LEGACY_STORE = 'blobs'

const req = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
const done = tx => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve()
  tx.onerror = () => reject(tx.error)
  tx.onabort = () => reject(tx.error || new Error('aborted'))
})
const meta = r => {
  const { blob, data, ...rest } = r
  return rest
}
const key = (owner, hash) => [owner, hash]
const payloadSize = record => {
  if (record?.data instanceof ArrayBuffer) return record.data.byteLength
  if (ArrayBuffer.isView(record?.data)) return record.data.byteLength
  if (typeof record?.blob?.size === 'number') return record.blob.size
  return 0
}

export function idbBackend({ idb = globalThis.indexedDB } = {}) {
  let db = null
  let legacy = null
  const tx = mode => db.transaction(STORE, mode)
  const openLegacy = async () => {
    if (!idb) return null
    try {
      if (typeof idb.databases === 'function' && !(await idb.databases()).some(item => item.name === LEGACY_DB)) return null
    } catch { /* try the existing database without relying on databases(), which Safari may omit */ }
    try {
      legacy = await new Promise((resolve, reject) => {
        let created = false
        const open = idb.open(LEGACY_DB, 1)
        open.onupgradeneeded = event => {
          if (event.oldVersion === 0) { created = true; open.transaction.abort() }
        }
        open.onsuccess = () => {
          if (created) { open.result.close(); resolve(null) }
          else resolve(open.result)
        }
        open.onerror = () => created ? resolve(null) : reject(open.error)
        open.onblocked = () => reject(new Error('blocked'))
      })
      if (legacy) legacy.onversionchange = () => { try { legacy.close() } catch { /* already closed */ }; legacy = null }
      return legacy
    } catch { return null }
  }
  const putIfMissing = async (owner, record) => {
    const t = tx('readwrite')
    const store = t.objectStore(STORE)
    const get = store.get(key(owner, record.hash))
    get.onsuccess = () => { if (!get.result) store.put({ ...record, owner }) }
    await done(t)
    const saved = await req(tx('readonly').objectStore(STORE).get(key(owner, record.hash)))
    const savedSize = payloadSize(saved)
    const expectedSize = Number.isFinite(record.size) ? record.size : payloadSize(record)
    return !!(saved && saved.owner === owner && saved.hash === record.hash && saved.mime === record.mime
      && savedSize > 0 && expectedSize > 0 && savedSize === expectedSize)
  }
  return {
    name: 'idb',
    persistent: true,
    async open() {
      if (!idb) return false
      try {
        db = await new Promise((resolve, reject) => {
          const open = idb.open(DB, 1)
          open.onupgradeneeded = () => { if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: ['owner', 'hash'] }) }
          open.onsuccess = () => resolve(open.result)
          open.onerror = () => reject(open.error)
          open.onblocked = () => reject(new Error('blocked'))
        })
        db.onversionchange = () => { try { db.close() } catch { /* already closed */ }; db = null }
        const t = tx('readwrite')
        t.objectStore(STORE).put({ owner: '.probe', hash: '.probe', data: new Uint8Array([120]).buffer, mime: '', size: 1 })
        t.objectStore(STORE).delete(key('.probe', '.probe'))
        await done(t)
        return true
      } catch {
        try { db?.close() } catch { /* nothing to close */ }
        db = null
        return false
      }
    },
    async all(owner) {
      const out = []
      await new Promise((resolve, reject) => {
        const r = tx('readonly').objectStore(STORE).openCursor()
        r.onsuccess = () => {
          const c = r.result
          if (!c) return resolve()
          if (c.value?.owner === owner && typeof c.value.hash === 'string') out.push(meta(c.value))
          c.continue()
        }
        r.onerror = () => reject(r.error)
      })
      return out
    },
    async getBlob(hash, owner) {
      const store = tx('readonly').objectStore(STORE)
      const r = await req(store.get(key(owner, hash)))
      if (!r) return null
      if (r.data) return new Blob([r.data], { type: r.mime || '' })
      if (!r.blob) return null
      let buf
      try { buf = await r.blob.arrayBuffer() } catch { return null }
      if (typeof r.size === 'number' && buf.byteLength !== r.size) return null
      try {
        const t = tx('readwrite')
        const { blob: _old, ...rest } = r
        t.objectStore(STORE).put({ ...rest, data: buf })
        await done(t)
      } catch { /* still readable this time; the next read tries again */ }
      return new Blob([buf], { type: r.mime || '' })
    },
    async put(rec, blob, owner) {
      const data = blob ? await blob.arrayBuffer() : undefined
      const t = tx('readwrite')
      t.objectStore(STORE).put({ ...rec, owner, ...(data ? { data } : {}) })
      await done(t)
    },
    async patch(hash, fields, owner) {
      const t = tx('readwrite')
      const store = t.objectStore(STORE)
      const r = store.get(key(owner, hash))
      r.onsuccess = () => { if (r.result) store.put({ ...r.result, ...fields }) }
      await done(t)
    },
    async remove(hash, owner) {
      const t = tx('readwrite')
      t.objectStore(STORE).delete(key(owner, hash))
      await done(t)
    },
    async clear(owner) {
      const t = tx('readwrite')
      const store = t.objectStore(STORE)
      const r = store.openCursor()
      r.onsuccess = () => {
        const c = r.result
        if (!c) return
        if (c.value?.owner === owner) c.delete()
        c.continue()
      }
      await done(t)
    },
    async migrateLegacy(ownerRefs) {
      if (!db || !(await openLegacy())) return 0
      const ownersByHash = new Map()
      for (const [owner, hashes] of ownerRefs) for (const hash of hashes) {
        if (!ownersByHash.has(hash)) ownersByHash.set(hash, [])
        if (!ownersByHash.get(hash).includes(owner)) ownersByHash.get(hash).push(owner)
      }
      const legacyStore = () => legacy.transaction(LEGACY_STORE, 'readonly').objectStore(LEGACY_STORE)
      let keys = []
      try { keys = await req(legacyStore().getAllKeys()) } catch { return 0 }
      let moved = 0
      for (const hash of keys) {
        if (typeof hash !== 'string' || hash.startsWith('.')) continue
        const owners = ownersByHash.get(hash)
        // A hash referenced by more than one saved profile is ambiguous in the old global store.
        // Leave it recoverable there instead of assigning a legacy row to multiple owners.
        if (owners?.length !== 1) continue
        let record
        try { record = await req(legacyStore().get(hash)) } catch { continue }
        if (!record || !record.mime) continue
        try {
          const [owner] = owners
          if (!await putIfMissing(owner, record)) continue
          const remove = legacy.transaction(LEGACY_STORE, 'readwrite')
          remove.objectStore(LEGACY_STORE).delete(hash)
          await done(remove)
          moved++
        } catch { /* keep the legacy copy if any owner-scoped copy could not be saved */ }
      }
      return moved
    }
  }
}

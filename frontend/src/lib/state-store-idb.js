import { convertRadianBackupState } from '../../../src/lib/radian-conversion.js'
import { mergeStates } from './sync-merge.js'

const DB = 'opengym-state'
const STORE = 'profiles'
const RADIAN_KEY = 'radian-data-v1'
const RADIAN_MIGRATED_KEY = 'gym_radian_migrated_v1'

const request = value => new Promise((resolve, reject) => {
  value.onsuccess = () => resolve(value.result)
  value.onerror = () => reject(value.error)
})
const completed = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve
  tx.onerror = () => reject(tx.error)
  tx.onabort = () => reject(tx.error || new Error('aborted'))
})

export const localCopyBelongsToOwner = (owner, localOwner, ownerTag, localUserId) => owner === 'guest'
  ? !localOwner && (ownerTag === null || ownerTag === '')
  : localOwner === owner && (ownerTag === owner || (ownerTag === null && localUserId === owner))

export function createStateStore({ indexedDB = globalThis.indexedDB } = {}) {
  let db = null
  let opening = null
  return {
    async open() {
      if (db) return true
      if (!indexedDB) return false
      if (!opening) opening = new Promise((resolve, reject) => {
        const open = indexedDB.open(DB, 1)
        open.onupgradeneeded = () => {
          if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'owner' })
        }
        open.onsuccess = () => resolve(open.result)
        open.onerror = () => reject(open.error)
        open.onblocked = () => reject(new Error('blocked'))
      }).then(value => {
        db = value
        db.onversionchange = () => { db.close(); db = null; opening = null }
        return db
      }).catch(() => { opening = null; return null })
      return !!(await opening)
    },
    async get(owner) {
      if (!db || typeof owner !== 'string' || !owner) return null
      try { return await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(owner)) || null }
      catch { return null }
    },
    async listProfiles() {
      if (!db) return null
      try { return await request(db.transaction(STORE, 'readonly').objectStore(STORE).getAll()) || [] }
      catch { return null }
    },
    async save(owner, { state, base = null, wid = null, owed = false, lastSynced = null, fingerprint = null, merge } = {}) {
      if (!db || typeof owner !== 'string' || !owner || !state || typeof state !== 'object') return false
      try {
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        const get = store.get(owner)
        let saved = null
        get.onsuccess = () => {
          const previous = get.result
          const next = previous?.state && typeof merge === 'function' ? merge(previous.state, state) : state
          const changedByMerge = previous && JSON.stringify(next) !== JSON.stringify(state)
          const same = previous && JSON.stringify(previous.state) === JSON.stringify(next)
          const nextBase = changedByMerge && same ? previous.base ?? null
            : changedByMerge && JSON.stringify(previous.base ?? null) !== JSON.stringify(base ?? null) ? null : base
          const nextOwed = changedByMerge && same ? previous.owed === true : !!owed || !!changedByMerge
          const outbox = nextOwed ? { state: next, base: nextBase, wid } : null
          saved = {
            owner, state: next, base: nextBase, wid, owed: nextOwed,
            syncMetaVersion: 2,
            lastSynced: changedByMerge && same ? previous.lastSynced ?? null : lastSynced ?? previous?.lastSynced ?? null,
            fingerprint: changedByMerge && same ? previous.fingerprint ?? null : fingerprint ?? previous?.fingerprint ?? null,
            outbox, recoveryState: same ? previous.recoveryState ?? null : previous?.state ?? null, savedAt: Date.now(),
          }
          store.put(saved)
        }
        await completed(tx)
        return saved || false
      } catch { return false }
    },
    async updateSyncMeta(owner, syncMeta = {}) {
      if (!db || typeof owner !== 'string' || !owner) return false
      try {
        const tx = db.transaction(STORE, 'readwrite')
        const store = tx.objectStore(STORE)
        const get = store.get(owner)
        let saved = null
        get.onsuccess = () => {
          const previous = get.result
          if (!previous) return
          const nextBase = Object.hasOwn(syncMeta, 'base') ? syncMeta.base || null : previous.base || null
          const nextOwed = Object.hasOwn(syncMeta, 'owed') ? syncMeta.owed === true : previous.owed === true
          saved = {
            ...previous,
            base: nextBase,
            owed: nextOwed,
            syncMetaVersion: 2,
            lastSynced: Object.hasOwn(syncMeta, 'lastSynced') ? syncMeta.lastSynced ?? null : previous.lastSynced ?? null,
            fingerprint: Object.hasOwn(syncMeta, 'fingerprint') ? syncMeta.fingerprint ?? null : previous.fingerprint ?? null,
            outbox: nextOwed ? { state: previous.state, base: nextBase, wid: previous.wid || null } : null,
            savedAt: Date.now(),
          }
          store.put(saved)
        }
        await completed(tx)
        return saved || false
      } catch { return false }
    },
  }
}

export const stateStore = createStateStore()

export async function migrateRadianLocalCopy({ store = stateStore, storage } = {}) {
  let localStorage = storage
  if (localStorage === undefined) {
    try { localStorage = globalThis.localStorage } catch { return false }
  }
  let raw
  try {
    if (!localStorage || localStorage.getItem(RADIAN_MIGRATED_KEY) === '1') return false
    raw = localStorage.getItem(RADIAN_KEY)
  } catch { return false }
  if (!raw || !await store.open()) return false
  const guest = await store.get('guest')
  const hasGuestData = guest?.state && (guest.state.active
    || ['workouts', 'routines', 'bodyweight', 'measurements', 'customEx'].some(key => Array.isArray(guest.state[key]) && guest.state[key].length))
  if (hasGuestData) {
    try { localStorage.setItem(RADIAN_MIGRATED_KEY, '1') } catch { /* source remains available */ }
    return false
  }
  let state
  try { state = convertRadianBackupState(JSON.parse(raw)) } catch { return false }
  if (guest?.state) state = mergeStates(guest.state, state)
  if (!await store.save('guest', { state, base: null, wid: null, owed: false })) return false
  const saved = await store.get('guest')
  if (!saved?.state || JSON.stringify(saved.state) !== JSON.stringify(state)) return false
  try { localStorage.setItem(RADIAN_MIGRATED_KEY, '1') } catch { /* guest copy is already durable in IndexedDB */ }
  return true
}

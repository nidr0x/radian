import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Window } from 'happy-dom'
import { syncFingerprint } from '../lib/sync-changes.js'

const mocks = vi.hoisted(() => ({ api: vi.fn() }))

vi.mock('../lib/api.js', () => ({ api: mocks.api, setRemoteAuth: vi.fn() }))
vi.mock('../lib/mobile.js', () => ({
  MOBILE: false,
  initReminderSync: vi.fn(),
  nativeLoad: vi.fn(async () => null),
  nativeSave: vi.fn(async () => {}),
  onAppActive: vi.fn(() => () => {}),
  readJsonFile: vi.fn(async () => null),
  syncReminder: vi.fn(),
  writeAutoBackup: vi.fn(async () => {}),
  writeJsonFile: vi.fn(async () => {}),
}))
vi.mock('../lib/health-sync.js', () => ({ initHealthSync: vi.fn(), syncHealth: vi.fn(async () => {}) }))
vi.mock('../lib/media-owed.js', () => ({ pendingRefCount: vi.fn(() => 0), settleMedia: vi.fn(async () => true), loadPending: vi.fn() }))
vi.mock('../lib/media-store.js', () => {
  let owner = 'guest'
  return {
    mediaStore: {
      clearAll: vi.fn(async () => {}),
      async setOwner(nextOwner) { owner = nextOwner || 'guest' },
      get owner() { return owner },
    },
    mediaStoreInUse: vi.fn(async () => false),
  }
})

const memoryIndexedDB = () => {
  const values = new Map()
  const objectStore = {
    get: key => {
      const result = {}
      queueMicrotask(() => { result.result = structuredClone(values.get(key)); result.onsuccess?.() })
      return result
    },
    put: record => values.set(record.owner, structuredClone(record)),
  }
  const database = {
    objectStoreNames: { contains: () => true },
    transaction: () => {
      const tx = { objectStore: () => objectStore }
      setTimeout(() => tx.oncomplete?.(), 0)
      return tx
    },
    close() {},
  }
  return { open: () => {
    const request = { result: database }
    queueMicrotask(() => request.onsuccess?.())
    return request
  }, seed: record => values.set(record.owner, structuredClone(record)) }
}

describe('persistencia del store web', () => {
  let useStore
  let stateStore
  let indexedDb

  beforeEach(async () => {
    vi.resetModules()
    const browser = new Window({ url: 'https://radian.example/' })
    Object.assign(globalThis, { window: browser, document: browser.document, location: browser.location })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: browser.localStorage })
    indexedDb = memoryIndexedDB()
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDb })
    mocks.api.mockReset().mockImplementation(async path => {
      if (path === '/api/config') return { allow_guest: true, invite_only: false, password_login: false }
      if (path === '/api/me') throw Object.assign(new Error('session expired'), { status: 401 })
      throw new Error(`Unexpected API request: ${path}`)
    })
    ;({ useStore } = await import('./useStore.js'))
    ;({ stateStore } = await import('../lib/state-store-idb.js'))
  })

  it('recupera el perfil por cuenta tras recargar sin guardar el estado en localStorage', async () => {
    localStorage.setItem('gym_owner', 'account-a')
    localStorage.setItem('gym_state_owner', 'account-a')
    localStorage.setItem('gym_user', JSON.stringify({ id: 'account-a', name: 'Ada' }))
    await stateStore.open()
    const initial = {
      ...useStore.getState().S,
      theme: 'light',
      workouts: [{ id: 'offline-workout' }],
      active: { id: 'active-session', startedAt: '2026-10-26T10:00:00.000Z', exercises: [] },
    }
    await stateStore.save('account-a', { state: initial, base: { rev: 2, ts: 1 }, wid: 'account-a-2', owed: false })

    await useStore.getState().boot()
    expect(useStore.getState().S.workouts).toEqual([{ id: 'offline-workout' }])
    expect(useStore.getState().S.active).toEqual(initial.active)
    expect(localStorage.getItem('gym_state_v1')).toBeNull()

    useStore.getState().update(state => { state.theme = 'dark' }, false)
    await useStore.getState().saveNow()
    expect((await stateStore.get('account-a')).state.theme).toBe('dark')
    expect(localStorage.getItem('gym_state_v1')).toBeNull()

    vi.resetModules()
    ;({ useStore } = await import('./useStore.js'))
    ;({ stateStore } = await import('../lib/state-store-idb.js'))
    await useStore.getState().boot()
    expect(useStore.getState().S).toMatchObject({ theme: 'dark', workouts: [{ id: 'offline-workout' }], active: initial.active })
    expect(localStorage.getItem('gym_state_v1')).toBeNull()

    await stateStore.save('account-b', { state: { ...useStore.getState().S, theme: 'purple', workouts: [{ id: 'other-account-workout' }] }, wid: 'account-b-1' })
    localStorage.setItem('gym_owner', 'account-b')
    localStorage.setItem('gym_state_owner', 'account-b')
    localStorage.setItem('gym_user', JSON.stringify({ id: 'account-b', name: 'Bea' }))
    vi.resetModules()
    ;({ useStore } = await import('./useStore.js'))
    ;({ stateStore } = await import('../lib/state-store-idb.js'))
    await useStore.getState().boot()
    expect(useStore.getState().S).toMatchObject({ theme: 'purple', workouts: [{ id: 'other-account-workout' }] })
    expect((await stateStore.get('account-a')).state.theme).toBe('dark')
    expect(localStorage.getItem('gym_state_v1')).toBeNull()
  })

  it('migra la copia legacy del dueño a IndexedDB antes de retirar localStorage', async () => {
    localStorage.setItem('gym_owner', 'account-a')
    localStorage.setItem('gym_state_owner', 'account-a')
    localStorage.setItem('gym_user', JSON.stringify({ id: 'account-a', name: 'Ada' }))
    const legacy = { ...useStore.getState().S, theme: 'light', workouts: [{ id: 'legacy-a' }] }
    localStorage.setItem('gym_state_v1', JSON.stringify(legacy))

    vi.resetModules()
    ;({ useStore } = await import('./useStore.js'))
    ;({ stateStore } = await import('../lib/state-store-idb.js'))
    await useStore.getState().boot()

    expect(useStore.getState().S).toMatchObject({ theme: 'light', workouts: [{ id: 'legacy-a' }] })
    expect((await stateStore.get('account-a')).state).toMatchObject({ theme: 'light', workouts: [{ id: 'legacy-a' }] })
    expect(localStorage.getItem('gym_state_v1')).toBeNull()
  })

  it('migra lastSynced y fingerprint de un perfil IDB v1 sin reemplazar su base u owed', async () => {
    localStorage.setItem('gym_owner', 'account-a')
    localStorage.setItem('gym_state_owner', 'account-a')
    localStorage.setItem('gym_user', JSON.stringify({ id: 'account-a', name: 'Ada' }))
    localStorage.setItem('gym_sync_owner', 'account-a')
    const profile = { ...useStore.getState().S, theme: 'dark', workouts: [{ id: 'offline-a' }] }
    const base = { rev: 2, ts: 20, wid: 'server-a2' }
    const fingerprint = syncFingerprint(profile)
    indexedDb.seed({ owner: 'account-a', state: profile, base, wid: 'local-a', owed: true, syncMetaVersion: 1 })
    localStorage.setItem('gym_synced_at', '100')
    localStorage.setItem('gym_synced_fp', JSON.stringify(fingerprint))

    await useStore.getState().boot()
    await useStore.getState().saveNow()

    expect(await stateStore.get('account-a')).toMatchObject({
      base,
      owed: true,
      syncMetaVersion: 2,
      lastSynced: 100,
      fingerprint,
    })
  })

  it('guarda la copia legacy de B bajo B mientras A inicia sesión', async () => {
    await stateStore.open()
    const stateA = { ...useStore.getState().S, theme: 'dark', workouts: [{ id: 'workout-a' }] }
    const stateB = { ...useStore.getState().S, theme: 'light', workouts: [{ id: 'legacy-b' }] }
    await stateStore.save('account-a', { state: stateA, wid: 'local-a' })
    localStorage.setItem('gym_owner', 'account-a')
    localStorage.setItem('gym_state_owner', 'account-b')
    localStorage.setItem('gym_user', JSON.stringify({ id: 'account-a', name: 'Ada' }))
    localStorage.setItem('gym_state_v1', JSON.stringify(stateB))

    vi.resetModules()
    ;({ useStore } = await import('./useStore.js'))
    ;({ stateStore } = await import('../lib/state-store-idb.js'))
    await useStore.getState().boot()

    expect(useStore.getState().S).toMatchObject({ theme: 'dark', workouts: [{ id: 'workout-a' }] })
    expect((await stateStore.get('account-b')).state).toMatchObject({ theme: 'light', workouts: [{ id: 'legacy-b' }] })
    expect(localStorage.getItem('gym_state_v1')).toBeNull()
  })

  it('reintenta la outbox de la cuenta al recargar y solo la limpia tras confirmar', async () => {
    await stateStore.open()
    const pending = { ...useStore.getState().S, workouts: [{ id: 'offline-workout' }] }
    await stateStore.save('account-a', {
      state: pending,
      base: { rev: 5, ts: 50, wid: 'server-a5' },
      wid: 'local-a',
      owed: true,
    })
    localStorage.setItem('gym_owner', 'account-a')
    localStorage.setItem('gym_state_owner', 'account-a')
    localStorage.setItem('gym_user', JSON.stringify({ id: 'account-a', name: 'Ada' }))
    expect(await stateStore.get('account-a')).toMatchObject({ owed: true, outbox: { state: { workouts: [{ id: 'offline-workout' }] } } })

    const putBodies = []
    mocks.api.mockImplementation(async (path, options = {}) => {
      if (path === '/api/config') return { allow_guest: true, invite_only: false, password_login: false }
      if (path === '/api/me') return { user: { id: 'account-a', name: 'Ada' } }
      if (path === '/api/data' && options.method === 'PUT') {
        putBodies.push(JSON.parse(options.body))
        return { rev: 6, wid: 'server-a6' }
      }
      if (path === '/api/data') return { state: pending, rev: 5 }
      throw new Error(`Unexpected API request: ${path}`)
    })
    vi.resetModules()
    ;({ useStore } = await import('./useStore.js'))
    ;({ stateStore } = await import('../lib/state-store-idb.js'))

    await useStore.getState().boot()
    await useStore.getState().saveNow()

    expect(putBodies).toHaveLength(1)
    expect(putBodies[0]).toMatchObject({ baseRev: 5, baseWid: 'server-a5', state: { workouts: [{ id: 'offline-workout' }] } })
    expect(await stateStore.get('account-a')).toMatchObject({ base: { rev: 6, wid: 'server-a6' }, owed: false, outbox: null })
  })

  it('conserva y actualiza la copia local si IndexedDB no se puede abrir', async () => {
    const legacy = { ...useStore.getState().S, theme: 'light', workouts: [{ id: 'legacy-a' }] }
    localStorage.setItem('gym_owner', 'account-a')
    localStorage.setItem('gym_state_owner', 'account-a')
    localStorage.setItem('gym_user', JSON.stringify({ id: 'account-a', name: 'Ada' }))
    localStorage.setItem('gym_sync_owner', 'account-a')
    localStorage.setItem('gym_sync', JSON.stringify({ rev: 4, ts: 40, wid: 'server-a4' }))
    localStorage.setItem('gym_dirty', '1')
    localStorage.setItem('gym_state_v1', JSON.stringify(legacy))
    const unavailableIndexedDB = {
      open() {
        const request = {}
        queueMicrotask(() => { request.error = new Error('unavailable'); request.onerror?.() })
        return request
      },
    }
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: unavailableIndexedDB })
    vi.resetModules()
    ;({ useStore } = await import('./useStore.js'))
    ;({ stateStore } = await import('../lib/state-store-idb.js'))

    await useStore.getState().boot()
    useStore.getState().update(state => { state.workouts.push({ id: 'offline-a' }) })
    await useStore.getState().saveNow()

    expect(useStore.getState().S).toMatchObject({ theme: 'light', workouts: [{ id: 'legacy-a' }, { id: 'offline-a' }] })
    expect(JSON.parse(localStorage.getItem('gym_state_v1'))).toMatchObject({ workouts: [{ id: 'legacy-a' }, { id: 'offline-a' }] })
    expect(localStorage.getItem('gym_sync_owner')).toBe('account-a')
    expect(localStorage.getItem('gym_dirty')).toBe('1')
    expect(await stateStore.open()).toBe(false)
  })

  it('restaura un backup sobre un tombstone y conserva el reset vigente', () => {
    useStore.setState({ S: {
      ...useStore.getState().S,
      workouts: [],
      resetAt: 40,
      resetIds: { workouts: ['old-workout'] },
      deleted: { workouts: { 'restored-workout': 30 } },
    } })

    useStore.getState().importBackup({
      workouts: [{ id: 'restored-workout', d: '2026-10-25', start: 10, end: 20, _ts: 10, entries: [] }],
    })

    const { S } = useStore.getState()
    expect(S.workouts.map(workout => workout.id)).toEqual(['restored-workout'])
    expect(S.deleted.workouts['restored-workout']).toBeLessThan(0)
    expect(S.resetAt).toBe(40)
    expect(S.resetIds.workouts).toEqual(['old-workout'])
  })

  it('migra metadatos legacy de A y una segunda pestaña cambia a B sin cruzar revisión ni ajustes', async () => {
    localStorage.setItem('gym_owner', 'account-a')
    localStorage.setItem('gym_state_owner', 'account-a')
    localStorage.setItem('gym_state_wid', 'local-a')
    localStorage.setItem('gym_user', JSON.stringify({ id: 'account-a', name: 'Ada' }))
    const stateA = { ...useStore.getState().S, theme: 'dark', workouts: [{ id: 'workout-a' }] }
    const stateB = { ...useStore.getState().S, theme: 'light', workouts: [{ id: 'workout-b' }] }
    const fingerprintA = syncFingerprint(stateA)
    const fingerprintB = syncFingerprint(stateB)
    indexedDb.seed({ owner: 'account-a', state: stateA, base: { rev: 2, ts: 20, wid: 'server-a2' }, wid: 'local-a', owed: false })
    indexedDb.seed({ owner: 'account-b', state: stateB, base: { rev: 9, ts: 90, wid: 'server-b9' }, wid: 'local-b', owed: false, syncMetaVersion: 2, lastSynced: 200, fingerprint: fingerprintB })
    await stateStore.open()
    localStorage.setItem('gym_sync', JSON.stringify({ rev: 7, ts: 70, wid: 'server-a7' }))
    localStorage.setItem('gym_dirty', '1')
    localStorage.setItem('gym_synced_at', '100')
    localStorage.setItem('gym_synced_fp', JSON.stringify(fingerprintA))

    await useStore.getState().boot()
    await useStore.getState().saveNow()
    expect(await stateStore.get('account-a')).toMatchObject({ syncMetaVersion: 2, lastSynced: 100, fingerprint: fingerprintA })
    const firstStore = useStore
    const firstStateStore = stateStore
    const firstWindow = window
    const secondWindow = new Window({ url: 'https://radian.example/' })
    const putBodies = []
    mocks.api.mockImplementation(async (path, options = {}) => {
      if (path === '/api/config') return { allow_guest: true, invite_only: false, password_login: false }
      if (path === '/api/me') throw Object.assign(new Error('session expired'), { status: 401 })
      if (path === '/api/data' && options.method === 'PUT') {
        putBodies.push(JSON.parse(options.body))
        return { rev: 10, wid: 'server-b10' }
      }
      throw new Error(`Unexpected API request: ${path}`)
    })
    Object.assign(globalThis, { window: secondWindow, document: secondWindow.document, location: secondWindow.location })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: secondWindow.navigator })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage })
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDb })
    vi.resetModules()
    ;({ useStore } = await import('./useStore.js'))
    ;({ stateStore } = await import('../lib/state-store-idb.js'))
    await useStore.getState().boot()
    const secondStore = useStore

    Object.assign(globalThis, { window: firstWindow, document: firstWindow.document, location: firstWindow.location })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: firstWindow.navigator })
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage })
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: indexedDb })
    await firstStore.getState().setUser({ id: 'account-b', name: 'Bea' })
    await firstStore.getState().saveNow()

    Object.assign(globalThis, { window: secondWindow, document: secondWindow.document, location: secondWindow.location })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: secondWindow.navigator })
    secondWindow.dispatchEvent(new secondWindow.StorageEvent('storage', {
      key: 'gym_owner', oldValue: 'account-a', newValue: 'account-b', url: secondWindow.location.href,
    }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(secondStore.getState().S).toMatchObject({ theme: 'light', workouts: [{ id: 'workout-b' }] })
    expect(secondStore.getState().user?.id).toBe('account-b')
    expect(secondStore.getState().sync.lastSynced).toBe(200)
    expect(secondStore.getState().unsyncedChanges()).toMatchObject({ owed: false, count: 0 })
    await secondStore.getState().pushState()
    await secondStore.getState().saveNow()

    expect(putBodies[0]).toMatchObject({ baseRev: 9, baseWid: 'server-b9', state: { theme: 'light', workouts: [{ id: 'workout-b' }] } })
    expect(await firstStateStore.get('account-a')).toMatchObject({
      base: { rev: 7, ts: 70, wid: 'server-a7' }, owed: true, syncMetaVersion: 2, lastSynced: 100, fingerprint: fingerprintA,
      outbox: { state: { theme: 'dark', workouts: [{ id: 'workout-a' }] }, base: { rev: 7, ts: 70, wid: 'server-a7' } },
    })
    expect(await firstStateStore.get('account-b')).toMatchObject({ state: { theme: 'light', workouts: [{ id: 'workout-b' }] }, base: { rev: 10, ts: 0, wid: 'server-b10' }, owed: false, syncMetaVersion: 2, lastSynced: expect.any(Number) })

    Object.assign(globalThis, { window: firstWindow, document: firstWindow.document, location: firstWindow.location })
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: firstWindow.navigator })
    localStorage.setItem('gym_owner', 'account-a')
    localStorage.setItem('gym_state_owner', 'account-a')
    localStorage.setItem('gym_state_wid', 'local-a')
    localStorage.setItem('gym_sync_owner', 'account-a')
    localStorage.setItem('gym_user', JSON.stringify({ id: 'account-a', name: 'Ada' }))
    const putBodiesA = []
    mocks.api.mockImplementation(async (path, options = {}) => {
      if (path === '/api/config') return { allow_guest: true, invite_only: false, password_login: false }
      if (path === '/api/me') return { user: { id: 'account-a', name: 'Ada' } }
      if (path === '/api/data' && options.method === 'PUT') {
        putBodiesA.push(JSON.parse(options.body))
        return { rev: 8, wid: 'server-a8' }
      }
      if (path === '/api/data') return { state: { ...stateA, _wid: 'server-a7' }, rev: 7 }
      throw new Error(`Unexpected API request: ${path}`)
    })
    vi.resetModules()
    ;({ useStore } = await import('./useStore.js'))
    ;({ stateStore } = await import('../lib/state-store-idb.js'))
    await useStore.getState().boot()
    await useStore.getState().saveNow()

    expect(putBodiesA.length).toBeGreaterThanOrEqual(1)
    expect(putBodiesA[0]).toMatchObject({ baseRev: 7, baseWid: 'server-a7', state: { theme: 'dark', workouts: [{ id: 'workout-a' }] } })
    expect(putBodiesA.every(({ state }) => state.workouts.every(({ id }) => id !== 'workout-b'))).toBe(true)
    expect(await stateStore.get('account-a')).toMatchObject({ owed: false, outbox: null })
    expect(await stateStore.get('account-b')).toMatchObject({ state: { theme: 'light', workouts: [{ id: 'workout-b' }] }, owed: false })
  })
})

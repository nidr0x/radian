import { describe, expect, it } from 'vitest'
import { createStateStore, localCopyBelongsToOwner, migrateRadianLocalCopy } from './state-store-idb.js'

const memoryIndexedDB = () => {
  const values = new Map()
  const store = {
    get: key => {
      const request = {}
      queueMicrotask(() => { request.result = values.get(key); request.onsuccess?.() })
      return request
    },
    put: record => values.set(record.owner, structuredClone(record)),
  }
  const database = {
    objectStoreNames: { contains: name => name === 'profiles' },
    transaction: () => {
      const tx = { objectStore: () => store }
      setTimeout(() => tx.oncomplete?.(), 0)
      return tx
    },
    close() {},
  }
  return { open: () => {
    const request = { result: database }
    queueMicrotask(() => { request.onsuccess?.() })
    return request
  } }
}

const memoryStorage = initial => {
  const values = new Map(Object.entries(initial))
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  }
}

describe('state-store-idb', () => {
  it('reconoce copias antiguas de invitado y separa cuentas', () => {
    expect(localCopyBelongsToOwner('guest', null, null, null)).toBe(true)
    expect(localCopyBelongsToOwner('guest', null, '', null)).toBe(true)
    expect(localCopyBelongsToOwner('guest', null, 'account-a', null)).toBe(false)
    expect(localCopyBelongsToOwner('account-a', 'account-a', null, 'account-a')).toBe(true)
    expect(localCopyBelongsToOwner('account-a', 'account-b', 'account-b', 'account-b')).toBe(false)
  })

  it('separa perfiles, conserva la copia previa y guarda la outbox por cuenta', async () => {
    const store = createStateStore({ indexedDB: memoryIndexedDB() })
    expect(await store.open()).toBe(true)
    await store.save('account-a', { state: { workouts: [1] }, base: { rev: 2 }, wid: 'a2', owed: true })
    await store.save('account-b', { state: { workouts: [9] }, base: null, wid: null, owed: false })
    await store.save('account-a', { state: { workouts: [1, 2] }, base: { rev: 2 }, wid: 'a3', owed: true })

    const a = await store.get('account-a')
    const b = await store.get('account-b')
    expect(a).toMatchObject({ state: { workouts: [1, 2] }, outbox: { state: { workouts: [1, 2] }, base: { rev: 2 }, wid: 'a3' }, recoveryState: { workouts: [1] } })
    expect(b).toMatchObject({ state: { workouts: [9] }, outbox: null, recoveryState: null })
  })

  it('combina el estado previo del perfil al guardar desde otra pestaña', async () => {
    const store = createStateStore({ indexedDB: memoryIndexedDB() })
    await store.open()
    await store.save('account-a', { state: { workouts: [{ id: 'from-a' }] }, base: { rev: 2 }, wid: 'a2' })

    const saved = await store.save('account-a', {
      state: { workouts: [{ id: 'from-b' }] },
      base: { rev: 2 },
      wid: 'b2',
      merge: (previous, incoming) => ({ workouts: [...previous.workouts, ...incoming.workouts] }),
    })

    expect(saved.state.workouts).toEqual([{ id: 'from-a' }, { id: 'from-b' }])
  })

  it('actualiza todo el metadato de sync solo en la cuenta correspondiente y lo conserva al guardar el estado', async () => {
    const store = createStateStore({ indexedDB: memoryIndexedDB() })
    await store.open()
    await store.save('account-a', { state: { theme: 'dark' }, base: { rev: 2, ts: 20, wid: 'server-a' }, wid: 'local-a', owed: false })
    await store.save('account-b', { state: { theme: 'light' }, base: { rev: 9, ts: 90, wid: 'server-b' }, wid: 'local-b', owed: false })

    const fingerprint = { workouts: { 'workout-a': 'hash-a' }, s: 'settings-a' }
    await store.updateSyncMeta('account-a', {
      base: { rev: 3, ts: 30, wid: 'server-a3' },
      owed: true,
      lastSynced: 100,
      fingerprint,
    })
    await store.save('account-a', { state: { theme: 'blue' }, base: { rev: 3, ts: 30, wid: 'server-a3' }, wid: 'local-a3', owed: true })

    expect(await store.get('account-a')).toMatchObject({
      base: { rev: 3, ts: 30, wid: 'server-a3' },
      owed: true,
      syncMetaVersion: 2,
      lastSynced: 100,
      fingerprint,
    })
    expect(await store.get('account-b')).toMatchObject({ base: { rev: 9, ts: 90, wid: 'server-b' }, owed: false, lastSynced: null, fingerprint: null })
  })

  it('migra una vez radian-data-v1 al perfil invitado y conserva la fuente original', async () => {
    const store = createStateStore({ indexedDB: memoryIndexedDB() })
    const source = JSON.stringify({
      schemaVersion: 1,
      profile: { theme: 'light', nutritionContext: 'private' },
      plan: { id: 'legacy-plan', version: 1, days: [{ id: 'routine-legacy', weekday: 1, name: 'Push', exercises: [] }] },
      sessions: [{ id: 'workout-legacy', dateKey: '2026-10-25', startedAt: '2026-10-25T10:00:00.000Z', plannedExercises: [] }],
      progress: [{ id: 'weight-legacy', date: '2026-10-25', weightKg: 80 }],
      exercises: [],
      checkins: [{ id: 'excluded', energy: 'low', soreness: 'some' }],
    })
    const storage = memoryStorage({ 'radian-data-v1': source })
    await store.open()
    await store.save('guest', { state: { unit: 'kg', theme: 'dark', workouts: [], routines: [], bodyweight: [], measurements: [], customEx: [] } })
    expect(await migrateRadianLocalCopy({ store, storage })).toBe(true)
    expect(await migrateRadianLocalCopy({ store, storage })).toBe(false)
    const guest = await store.get('guest')
    expect(guest.state).toMatchObject({ theme: 'dark', routines: [{ id: 'routine-legacy' }], workouts: [{ id: 'workout-legacy' }] })
    expect(guest.state).not.toHaveProperty('checkins')
    expect(guest.state).not.toHaveProperty('nutritionContext')
    expect(storage.getItem('radian-data-v1')).toBe(source)
    expect(storage.getItem('gym_radian_migrated_v1')).toBe('1')
  })

  it('omite radian-data-v1 si el perfil guest ya tiene datos y conserva ambas copias', async () => {
    const store = createStateStore({ indexedDB: memoryIndexedDB() })
    const source = JSON.stringify({
      schemaVersion: 1,
      profile: { theme: 'light' },
      plan: { id: 'legacy-plan', version: 1, days: [{ id: 'legacy-routine', name: 'Old plan', exercises: [] }] },
      sessions: [{ id: 'legacy-workout', dateKey: '2026-10-25', startedAt: '2026-10-25T10:00:00.000Z', plannedExercises: [] }],
      progress: [],
      exercises: [],
    })
    const storage = memoryStorage({ 'radian-data-v1': source })
    await store.open()
    await store.save('guest', {
      state: {
        unit: 'kg',
        theme: 'dark',
        workouts: [{ id: 'kept-workout' }],
        routines: [{ id: 'kept-routine' }],
      },
    })

    expect(await migrateRadianLocalCopy({ store, storage })).toBe(false)
    expect((await store.get('guest')).state).toMatchObject({
      theme: 'dark',
      workouts: [{ id: 'kept-workout' }],
      routines: [{ id: 'kept-routine' }],
    })
    expect(storage.getItem('radian-data-v1')).toBe(source)
    expect(storage.getItem('gym_radian_migrated_v1')).toBe('1')
  })
})

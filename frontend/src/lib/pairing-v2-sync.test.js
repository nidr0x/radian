import { describe, expect, it } from 'vitest'
import { createPairingV2Client } from './pairing-v2-sync.js'

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...headers },
})

function makePairServer() {
  const pairs = new Map()
  const revoked = new Set()
  const legacy = new Map()
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input, 'https://example.test')
    if (url.pathname === '/api/sync') {
      const key = new Headers(init.headers).get('X-Radian-Sync-Key')
      const data = legacy.get(key)
      return json({ data: data ?? null, updatedAt: data ? '2026-10-26T00:00:00.000Z' : null })
    }
    if (url.pathname !== '/api/pair/v2') return json({ error: 'not_found' }, 404)
    const headers = new Headers(init.headers)
    const id = url.searchParams.get('id') || headers.get('X-Pair-Id')
    if (init.method === 'PUT') {
      if (revoked.has(id)) return json({ error: 'pair_revoked' }, 410)
      const current = pairs.get(id)
      const base = Number(String(headers.get('If-Match') || '').replaceAll('"', ''))
      if ((current?.revision ?? 0) !== base) return json({ error: 'pair_conflict', revision: current?.revision ?? 0 }, 409)
      const bytes = new Uint8Array(await new Response(init.body).arrayBuffer())
      const revision = base + 1
      pairs.set(id, { revision, bytes, auth: headers.get('Authorization') })
      return json({ revision })
    }
    const current = pairs.get(id)
    if (!current) return json({ error: revoked.has(id) ? 'pair_revoked' : 'pair_not_found' }, revoked.has(id) ? 410 : 404)
    if (headers.get('Authorization') !== current.auth) return json({ error: 'pair_forbidden' }, 403)
    if (init.method === 'DELETE') { pairs.delete(id); revoked.add(id); return json({ deleted: true }) }
    const tag = `"${current.revision}"`
    if (headers.get('If-None-Match') === tag) return new Response(null, { status: 304, headers: { ETag: tag } })
    return new Response(current.bytes, { headers: { 'X-Pair-Revision': String(current.revision), 'X-Pair-SHA256': 'test' } })
  }
  return { fetchImpl, legacy }
}

function makeStore(initial) {
  let state
  const listeners = new Set()
  const mergePairedState = S => {
    const previous = state
    const local = state.S
    const byId = new Map([...(local.workouts || []), ...(S.workouts || [])].map(workout => [workout.id, workout]))
    state = { ...state, S: { ...local, ...S, workouts: [...byId.values()] } }
    for (const listener of listeners) listener(state, previous)
  }
  state = { S: structuredClone(initial), user: null, mergePairedState }
  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    setS(S) {
      const previous = state
      state = { ...state, S }
      for (const listener of listeners) listener(state, previous)
    },
  }
}

const emptyState = () => ({ unit: 'kg', routines: [], workouts: [], bodyweight: [], measurements: [], customEx: [] })
const makeSessionStorage = () => {
  const values = new Map()
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}

describe('pairing v2 client flow', () => {
  it('creates, reopens, continuously syncs and revokes a reusable channel', async () => {
    const { fetchImpl } = makePairServer()
    const sessionStorageImpl = makeSessionStorage()
    const first = makeStore({ ...emptyState(), workouts: [{ id: 'one', d: '2026-10-01' }] })
    const owner = createPairingV2Client({ store: first, fetchImpl, autoSync: false, baseUrl: 'https://example.test/?link=old-secret#/home', sessionStorageImpl })
    const { link } = await owner.create()
    expect(new URL(link).search).toBe('')
    const code = new URL(link).hash.match(/pair-v2=([A-Za-z0-9_-]{43})/)?.[1]
    expect(code).toHaveLength(43)
    expect(sessionStorageImpl.getItem('radian-pair-v2')).toBe(code)
    first.setS({ ...first.getState().S, _ts: 999 })
    await owner.sync()
    expect(owner.getStatus().revision).toBe(1)

    const second = makeStore(emptyState())
    const peer = createPairingV2Client({ store: second, fetchImpl, autoSync: false })
    await peer.open(code)
    expect(second.getState().S.workouts.map(workout => workout.id)).toContain('one')

    first.setS({ ...first.getState().S, workouts: [...first.getState().S.workouts, { id: 'two', d: '2026-10-02' }] })
    await owner.sync()
    await peer.sync()
    expect(second.getState().S.workouts.map(workout => workout.id)).toEqual(expect.arrayContaining(['one', 'two']))

    const restoredStore = makeStore(emptyState())
    const restored = createPairingV2Client({ store: restoredStore, fetchImpl, autoSync: false, sessionStorageImpl })
    await restored.resume()
    expect(restoredStore.getState().S.workouts.map(workout => workout.id)).toEqual(expect.arrayContaining(['one', 'two']))

    await owner.revoke()
    expect(sessionStorageImpl.getItem('radian-pair-v2')).toBeNull()
    await expect(peer.sync()).rejects.toMatchObject({ status: 410 })
  })

  it('rekeys an encrypted Radian v1 copy in the browser and verifies the v2 readback', async () => {
    const server = makePairServer()
    const key = 'ABCD-EFGH-IJKL'
    const data = {
      schemaVersion: 1,
      profile: { theme: 'dark' },
      plan: { id: 'plan-1', version: 1, days: [{ id: 'routine-1', weekday: 1, name: 'Push', exercises: [] }] },
      sessions: [{ id: 'workout-1', dateKey: '2026-10-25', startedAt: '2026-10-25T10:00:00.000Z', plannedExercises: [] }],
      progress: [{ id: 'weight-1', date: '2026-10-25', weightKg: 80 }],
      exercises: [],
      checkins: [{ id: 'excluded', energy: 'low', soreness: 'some' }],
    }
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), 'PBKDF2', false, ['deriveKey'])
    const aes = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'])
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify(data)))
    const b64 = bytes => btoa(String.fromCharCode(...bytes))
    server.legacy.set(key, { version: 1, algorithm: 'AES-GCM', salt: b64(salt), iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) })

    const store = makeStore(emptyState())
    const client = createPairingV2Client({ store, fetchImpl: server.fetchImpl, autoSync: false, baseUrl: 'https://example.test/' })
    const result = await client.migrateLegacy(key)
    expect(result.state.routines.map(routine => routine.id)).toContain('routine-1')
    expect(result.state.workouts.map(workout => workout.id)).toContain('workout-1')
    expect(result.state.bodyweight.map(entry => entry.id)).toContain('weight-1')
    expect(result.state).not.toHaveProperty('checkins')
    expect(result).toHaveProperty('verified', true)
    expect(server.legacy.has(key)).toBe(true)
  })
})

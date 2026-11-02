import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXIDX } from './exercises.js'
import WORKOUT_GUIDE_MAP from './workout-guide-map.json' with { type: 'json' }
import {
  installedApp,
  planMediaUrls,
  prefetchAllowed,
  prefetchMedia,
  startMediaPrefetch,
} from './media-prefetch.js'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const exerciseId = Object.keys(WORKOUT_GUIDE_MAP)[0]
const exerciseSlug = WORKOUT_GUIDE_MAP[exerciseId]
const plannedState = { routines: [{ ex: [{ id: exerciseId }] }], active: null }
const successfulResponse = () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) })

function fakeStore(S = plannedState) {
  let state = { S }
  const listeners = new Set()
  return {
    getState: () => state,
    subscribe: listener => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setState: S => {
      state = { S }
      listeners.forEach(listener => listener(state))
    },
  }
}

function fakeEnvironment({ standalone = true, onLine = true } = {}) {
  const media = { matches: standalone, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  const serviceWorker = { controller: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() }
  const win = { matchMedia: vi.fn(() => media), navigator: null }
  const nav = { standalone: false, onLine, serviceWorker }
  const cache = { match: vi.fn(async () => null) }
  const cachesApi = { open: vi.fn(async () => cache) }
  return { media, serviceWorker, win, nav, cache, cachesApi }
}

describe('Workout Guide media prefetch', () => {
  it('recognizes standalone installs and rejects tabs, offline, metered and data-saver connections', () => {
    expect(installedApp({ matchMedia: () => ({ matches: true }) }, {})).toBe(true)
    expect(installedApp({ matchMedia: () => ({ matches: false }) }, {})).toBe(false)
    expect(installedApp({}, { standalone: true })).toBe(true)
    expect(prefetchAllowed({ onLine: false })).toBe(false)
    expect(prefetchAllowed({ onLine: true, connection: { saveData: true } })).toBe(false)
    expect(prefetchAllowed({ onLine: true, connection: { type: 'cellular' } })).toBe(false)
    expect(prefetchAllowed({ onLine: true, connection: { effectiveType: '2g' } })).toBe(false)
    expect(prefetchAllowed({ onLine: true, connection: { effectiveType: '3g' } })).toBe(true)
    expect(prefetchAllowed({ onLine: true })).toBe(true)
  })

  it('does not fetch in a tab, and prefetches only guide frames in the installed app', async () => {
    vi.useFakeTimers()
    const tab = fakeEnvironment({ standalone: false })
    const tabFetch = vi.fn(async () => successfulResponse())
    const stopTab = startMediaPrefetch(fakeStore(), {
      delay: 0, win: tab.win, nav: tab.nav, cachesApi: tab.cachesApi,
    })
    await vi.runOnlyPendingTimersAsync()
    expect(tabFetch).not.toHaveBeenCalled()
    expect(tab.cachesApi.open).not.toHaveBeenCalled()
    stopTab()

    const app = fakeEnvironment()
    const appFetch = vi.fn(async () => successfulResponse())
    vi.stubGlobal('fetch', appFetch)
    vi.stubGlobal('location', { href: 'https://gym.example/app' })
    try {
      const stopApp = startMediaPrefetch(fakeStore(), {
        delay: 0, win: app.win, nav: app.nav, cachesApi: app.cachesApi,
      })
      await vi.runOnlyPendingTimersAsync()
      await vi.waitFor(() => expect(appFetch).toHaveBeenCalledTimes(3))
      expect(appFetch.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
        `/exercise-media/workout-guide/${exerciseSlug}/frame-1.png`,
        `/exercise-media/workout-guide/${exerciseSlug}/frame-2.png`,
        `/exercise-media/workout-guide/${exerciseSlug}/frame-3.png`,
      ])
      stopApp()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('skips cache hits and never exceeds two concurrent fetches', async () => {
    const urls = ['a', 'b', 'c', 'd', 'e']
    let release
    const barrier = new Promise(resolve => { release = resolve })
    let active = 0
    let maxActive = 0
    const fetchImpl = vi.fn(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await barrier
      active--
      return successfulResponse()
    })
    const cache = { match: vi.fn(async url => url === 'a' ? {} : null) }
    const resultPromise = prefetchMedia(urls, { cache, fetchImpl })

    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2))
    expect(fetchImpl.mock.calls.map(([url]) => url)).not.toContain('a')
    release()
    await expect(resultPromise).resolves.toEqual({ wanted: 5, missing: 4, fetched: 4 })
    expect(maxActive).toBe(2)
  })

  it('contains fetch and cache failures and stops after the bounded refusal burst', async () => {
    const cache = { match: vi.fn(async () => { throw new Error('cache unavailable') }) }
    const fetchImpl = vi.fn(async () => { throw new Error('offline') })

    await expect(prefetchMedia(['a', 'b', 'c', 'd', 'e', 'f'], { cache, fetchImpl }))
      .resolves.toMatchObject({ wanted: 6, missing: 6, fetched: 0 })
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('counts non-OK responses as failures and stops scheduling more frames', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }))

    await expect(prefetchMedia(['a', 'b', 'c', 'd', 'e', 'f'], { fetchImpl }))
      .resolves.toMatchObject({ wanted: 6, fetched: 0 })
    expect(fetchImpl.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(fetchImpl.mock.calls.length).toBeLessThanOrEqual(4)
  })

  it('rechecks eligibility before scheduling another frame', async () => {
    let allowed = true
    const fetchImpl = vi.fn(async () => {
      allowed = false
      return successfulResponse()
    })

    const result = await prefetchMedia(['a', 'b', 'c'], { fetchImpl, allowed: () => allowed })

    expect(result.fetched).toBe(1)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('skips work when there is no controlling service worker', async () => {
    vi.useFakeTimers()
    const env = fakeEnvironment()
    env.serviceWorker.controller = null
    const store = fakeStore()
    const stop = startMediaPrefetch(store, {
      delay: 0, win: env.win, nav: env.nav, cachesApi: env.cachesApi,
    })
    await vi.runOnlyPendingTimersAsync()
    expect(env.cachesApi.open).not.toHaveBeenCalled()
    stop()
  })
})

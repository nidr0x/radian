import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('./media-owed.js', () => ({
  loadPending: vi.fn(),
  pendingRefCount: vi.fn(() => 0),
  publishMediaStatus: vi.fn(),
  registerMediaRunner: vi.fn(),
}))

let createMediaSync
beforeAll(async () => {
  vi.stubGlobal('navigator', { userAgent: '' })
  ;({ createMediaSync } = await import('./media-sync.js'))
})
afterAll(() => vi.unstubAllGlobals())

describe('media sync', () => {
  it('checks hashes in API-sized batches', async () => {
    const refs = Array.from({ length: 101 }, (_, i) => ({
      kind: 'image',
      mime: 'image/jpeg',
      hash: i.toString(16).padStart(64, '0'),
      size: 1,
      width: 1,
      height: 1,
      at: 1,
    }))
    const store = { getState: () => ({
      user: { id: 'account-a' },
      sync: {},
      config: { media: true },
      S: { workouts: [{ media: refs }] },
    }) }
    const media = { owner: 'account-a', ready: vi.fn(async () => {}), markSynced: vi.fn(async () => {}) }
    const batches = []
    const api = vi.fn(async (_path, options) => {
      const hashes = JSON.parse(options.body).hashes
      batches.push(hashes)
      if (hashes.length > 100) throw Object.assign(new Error('invalid_media_hashes'), { status: 400 })
      return { missing: [], usage: { bytes: 0, quotaBytes: 1000 } }
    })
    const sync = createMediaSync({ store, media, api, now: () => 1_000_000 })

    await sync.syncMedia({ force: true })

    expect(batches.map(batch => batch.length)).toEqual([100, 1])
    expect(media.markSynced).toHaveBeenCalledTimes(101)
  })
})

import { describe, expect, it, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import { sha256Hex } from './sha256.js'
import { readZip, zipStore } from './zip.js'
import {
  BACKUP_JSON,
  exportBackupZip,
  readBackupFile,
  storeBackupMedia,
} from './backup-media.js'

const PNG = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
))

function refFor(hash, size = PNG.length) {
  return { kind: 'image', hash, mime: 'image/png', size, width: 1, height: 1, at: 1 }
}

function backupState(ref) {
  return {
    routines: [],
    workouts: [{ id: 'workout-1', d: '2024-01-02', entries: [], media: [ref] }],
    customEx: [{ id: 'custom-1', n: 'synthetic', custom: true, media: ref }],
  }
}

describe('backup ZIP media', () => {
  it('exports referenced media once, imports it with its valid hash, and stores it pending', async () => {
    const hash = await sha256Hex(PNG)
    const state = backupState(refFor(hash))
    const media = { get: vi.fn(async h => h === hash ? { blob: new Blob([PNG], { type: 'image/png' }), mime: 'image/png' } : null) }
    const exported = await exportBackupZip(state, { media, now: new Date('2024-01-01T00:00:00Z') })
    const entries = await readZip(exported.blob)
    const imported = await readBackupFile(exported.blob)
    const stored = []
    const destination = { put: vi.fn(async (...args) => stored.push(args)) }
    const before = structuredClone(imported.state)

    expect(exported).toMatchObject({ included: 1, missing: 0 })
    expect(entries.map(e => e.name)).toContain(`${'media/'}${hash}.png`)
    expect(entries.map(e => e.name)).toContain(BACKUP_JSON)
    expect(imported.files).toHaveLength(1)
    expect(imported.files[0].hash).toBe(hash)
    await expect(storeBackupMedia(imported.files, { media: destination }))
      .resolves.toEqual({ stored: 1, skipped: 0 })
    expect(destination.put).toHaveBeenCalledWith(hash, expect.any(Blob), { mime: 'image/png', pending: true })
    expect(stored).toHaveLength(1)
    expect(imported.state).toEqual(before)
  })

  it('skips media whose bytes do not match the hash stored in the archive name', async () => {
    const originalHash = await sha256Hex(PNG)
    const tampered = PNG.slice()
    tampered[tampered.length - 4] ^= 1
    const state = backupState(refFor(originalHash))
    const archive = await zipStore([
      { name: BACKUP_JSON, blob: new Blob([JSON.stringify(state)], { type: 'application/json' }) },
      { name: `media/${originalHash}.png`, blob: new Blob([tampered], { type: 'image/png' }) },
      { name: 'README.txt', blob: new Blob(['synthetic fixture']) },
    ])
    const imported = await readBackupFile(archive)
    const destination = { put: vi.fn(async () => {}) }

    await expect(storeBackupMedia(imported.files, { media: destination }))
      .resolves.toEqual({ stored: 0, skipped: 1 })
    expect(destination.put).not.toHaveBeenCalled()
    expect(imported.state).toEqual(state)
  })

  it('rejects a truncated ZIP instead of returning a partial backup', async () => {
    const hash = await sha256Hex(PNG)
    const state = backupState(refFor(hash))
    const media = { get: vi.fn(async () => ({ blob: new Blob([PNG]), mime: 'image/png' })) }
    const exported = await exportBackupZip(state, { media })
    const truncated = exported.blob.slice(0, exported.blob.size - 10)

    await expect(readBackupFile(truncated)).rejects.toMatchObject({ code: 'not-zip' })
  })
})

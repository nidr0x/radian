import { describe, expect, it } from 'vitest'
import { applySyncChanges, syncChanges, syncFingerprint } from './sync-changes.js'

describe('versioned sync changes', () => {
  it('diffs fields, entity edits, removals and per-key maps from a confirmed baseline', () => {
    const before = {
      theme: 'light',
      deleted: [],
      workouts: [{ id: 'workout-1', d: '2026-11-17', entries: [] }, { id: 'workout-2', d: '2026-11-18', entries: [] }],
      exNotes: { squat: 'old', press: 'keep' },
    }
    const after = {
      theme: 'dark',
      deleted: [{ type: 'workouts', id: 'workout-2', at: 10 }],
      workouts: [{ id: 'workout-1', d: '2026-11-17', entries: [{ id: 'squat', sets: [] }] }],
      exNotes: { squat: 'new', press: 'keep' },
    }

    const changes = syncChanges(after, syncFingerprint(before))

    expect(changes).toContainEqual({ kind: 'field', key: 'theme', value: 'dark' })
    expect(changes).toContainEqual({ kind: 'field', key: 'deleted', value: after.deleted })
    expect(changes).toContainEqual({ kind: 'entity', collection: 'workouts', id: 'workout-1', position: 0, value: after.workouts[0] })
    expect(changes).toContainEqual({ kind: 'entity', collection: 'workouts', id: 'workout-2', deleted: true })
    expect(changes).toContainEqual({ kind: 'map', map: 'exNotes', key: 'squat', value: 'new' })
    expect(changes).not.toContainEqual(expect.objectContaining({ kind: 'map', key: 'press' }))
  })

  it('applies a remote batch without dropping unchanged local entities and requests snapshot fallback for old fingerprints', () => {
    const local = { workouts: [
      { id: 'workout-1', d: '2026-11-17', entries: [] },
      { id: 'workout-2', d: '2026-11-18', entries: [] },
    ], theme: 'light' }
    const remote = applySyncChanges(local, [
      { kind: 'field', key: 'theme', value: 'dark' },
      { kind: 'entity', collection: 'workouts', id: 'workout-1', position: 0, value: { id: 'workout-1', d: '2026-11-17', entries: [], note: 'updated' } },
      { kind: 'entity', collection: 'workouts', id: 'workout-2', deleted: true },
    ])

    expect(remote).toEqual({ theme: 'dark', workouts: [{ id: 'workout-1', d: '2026-11-17', entries: [], note: 'updated' }] })
    expect(syncChanges(local, { w: {}, s: 'legacy' })).toBeNull()
  })

  it('uses stable date and time keys for legacy workouts and measurements', () => {
    const before = {
      workouts: [
        { d: '2026-11-17', start: 10, entries: [] },
        { d: '2026-11-18', start: 20, entries: [] },
      ],
      measurements: [{ d: '2026-11-17', t: 'morning', chest: 90 }],
    }
    const after = {
      workouts: [
        { d: '2026-11-18', start: 20, entries: [], note: 'moved' },
        { d: '2026-11-17', start: 10, entries: [] },
      ],
      measurements: [{ d: '2026-11-17', t: 'morning', chest: 91 }],
    }

    const changes = syncChanges(after, syncFingerprint(before))

    expect(changes).toContainEqual({ kind: 'entity', collection: 'workouts', id: '2026-11-18|20', position: 0, value: after.workouts[0] })
    expect(changes).toContainEqual({ kind: 'entity', collection: 'measurements', id: '2026-11-17|morning', position: 0, value: after.measurements[0] })
    expect(applySyncChanges(before, changes)).toEqual(after)
  })
})

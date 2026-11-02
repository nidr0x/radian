import { describe, expect, it } from 'vitest'
import { keepReset, mergeStates, stampChange, stampRestore } from './sync-merge.js'

describe('tombstones and profile recovery', () => {
  it('records a workout removal after its edit and drops the stale offline copy', () => {
    const workout = { id: 'workout-a', d: '2026-10-25', start: 10, end: 20, _ts: 20, entries: [] }
    const before = { _ts: 25, unit: 'kg', workouts: [workout], exWeights: { bench: { w: 40, d: '2026-10-25' } } }
    const after = { ...before, workouts: [] }
    stampChange(before, after, 1)

    expect(after.deleted.workouts['workout-a']).toBe(26)
    expect(mergeStates(after, { _ts: 25, unit: 'kg', workouts: [workout], exWeights: before.exWeights }).workouts).toEqual([])
  })

  it('keeps an entry edited after its removal', () => {
    const removed = { _ts: 50, unit: 'kg', workouts: [], deleted: { workouts: { 'workout-a': 40 } } }
    const edited = {
      _ts: 60,
      unit: 'kg',
      workouts: [{ id: 'workout-a', d: '2026-10-25', start: 10, end: 60, _ts: 60, entries: [] }],
      deleted: { workouts: { 'workout-a': 40 } },
    }

    expect(mergeStates(removed, edited).workouts.map(workout => workout.id)).toEqual(['workout-a'])
  })

  it('marks a backup item as restored so a recorded removal does not erase it again', () => {
    const backup = {
      _ts: 20,
      unit: 'kg',
      workouts: [{ id: 'workout-a', d: '2026-10-25', start: 10, end: 20, _ts: 10, entries: [] }],
    }
    const current = { _ts: 60, unit: 'kg', workouts: [], deleted: { workouts: { 'workout-a': 50 } } }
    stampRestore(backup, [current], 100)

    const merged = mergeStates(current, backup)
    expect(backup.deleted.workouts['workout-a']).toBe(-100)
    expect(merged.workouts.map(workout => workout.id)).toEqual(['workout-a'])
    expect(merged.deleted.workouts['workout-a']).toBe(-100)
  })

  it('keeps reset entries deleted while retaining entries the reset never named', () => {
    const reset = {
      _ts: 100,
      resetAt: 100,
      resetIds: { workouts: ['old-workout'], routines: ['old-routine'], favEx: ['bench'], exNotes: ['bench'] },
      unit: 'kg',
      theme: 'dark',
      workouts: [],
      routines: [],
      favEx: [],
      exNotes: {},
    }
    const offline = {
      _ts: 80,
      unit: 'kg',
      theme: 'light',
      workouts: [
        { id: 'old-workout', d: '2026-10-20', start: 10, end: 20, _ts: 20, entries: [] },
        { id: 'new-workout', d: '2026-10-25', start: 30, end: 40, _ts: 110, entries: [] },
      ],
      routines: [{ id: 'old-routine' }, { id: 'new-routine' }],
      favEx: ['bench', 'row'],
      exNotes: { bench: 'old note', row: 'kept note' },
    }

    const merged = mergeStates(reset, offline)
    expect(merged.workouts.map(workout => workout.id)).toEqual(['new-workout'])
    expect(merged.routines.map(routine => routine.id)).toEqual(['new-routine'])
    expect(merged.favEx).toEqual(['row'])
    expect(merged.exNotes).toEqual({ row: 'kept note' })
    expect(merged.theme).toBe('dark')
    expect(merged.resetAt).toBe(100)
  })

  it('keeps the reset marker when a backup replaces the profile', () => {
    const next = { _ts: 50, workouts: [{ id: 'restored' }] }
    keepReset({ resetAt: 100, resetIds: { workouts: ['old-workout'] } }, next)

    expect(next.resetAt).toBe(100)
    expect(next.resetIds.workouts).toEqual(['old-workout'])
  })
})

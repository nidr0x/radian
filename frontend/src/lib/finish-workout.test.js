import { describe, expect, it } from 'vitest'
import { buildCompletedWorkout } from './finish-workout.js'
import { editCompletedSession, saveWorkoutEdit } from './session-edit.js'
import { repeatSessionEntries } from './session-repeat.js'
import { routineFromSession } from './session-routines.js'

const plan = { v: 1, mode: 'amrap', durationSec: 300 }
const base = {
  id: 'workout-1', d: '2026-11-27', start: 1_000, name: 'Lunch', bw: null,
  entries: [{ id: 'push-up', sets: [{ w: 0, r: 8, done: true, at: 3_000 }], target: { mode: 'reps', sets: 1 } }],
  interval: {
    v: 1, plan, status: 'done', startedAt: 1_000, endedAt: 301_000, elapsedMs: 300_000,
    confirmed: [], skipped: [], loggedSetIndices: [{ station: 0, setIndex: 0 }], rounds: 3, partialReps: 4, roundTimes: [],
  },
}

describe('completed interval workouts', () => {
  it('buildCompletedWorkout_keepsConfirmedTimeOnlyResult', () => {
    const active = {
      ...base,
      entries: [{ id: 'push-up', sets: [], target: { mode: 'reps', sets: 1 } }],
    }
    const result = buildCompletedWorkout(active, { end: 900_000 })

    expect(result.entries).toEqual([])
    expect(result.interval).toEqual({
      v: 1, plan, startedAt: 1_000, endedAt: 301_000, elapsedMs: 300_000,
      confirmed: [], skipped: [], rounds: 3, partialReps: 4, roundTimes: [],
    })
    expect(result.end).toBe(301_000)
  })

  it('buildCompletedWorkout_usesIntervalEndedAt', () => {
    const result = buildCompletedWorkout(base, { end: 900_000 })

    expect(result.end).toBe(301_000)
    expect(result.interval.endedAt).toBe(301_000)
  })

  it('buildCompletedWorkout_preservesIntervalOnEditAndRepeat', () => {
    const saved = buildCompletedWorkout(base, { end: 900_000 })
    const state = { active: null, workouts: [saved], routines: [], unit: 'kg', exWeights: {} }
    editCompletedSession(state, saved.id)
    const edited = saveWorkoutEdit(state, 500_000)
    const repeated = repeatSessionEntries(state, edited, { exists: () => true })

    expect(edited.interval).toEqual(saved.interval)
    expect(repeated.intervalPlan).toEqual(plan)
    expect(repeated).not.toHaveProperty('intervalResult')
    expect(repeated.entries[0].sets[0]).toMatchObject({ done: false, r: 8 })
  })

  it('buildCompletedWorkout_discardsEmptyOrdinarySession', () => {
    const result = buildCompletedWorkout({
      id: 'empty', d: '2026-11-27', start: 1_000, name: 'Freestyle', entries: [],
    }, { end: 2_000 })

    expect(result).toBeNull()
  })

  it('routineFromSession_copiesPlanWithoutIntervalResult', () => {
    const routine = routineFromSession(base, 'Repeat plan')

    expect(routine.interval).toEqual(plan)
    expect(routine).not.toHaveProperty('intervalResult')
  })
})

import { describe, expect, it } from 'vitest'
import { parseHevyRoutines, parseHevyWorkouts } from './import-hevy.js'

const templates = [
  { id: 'hold', title: 'Plank', type: 'duration', primary_muscle_group: 'abdominals' },
  { id: 'row', title: 'Cable Row', type: 'weight_reps', primary_muscle_group: 'upper_back' },
  { id: 'run', title: 'Treadmill', type: 'distance_duration', primary_muscle_group: 'cardio' },
]

const workout = exercises => ({
  id: 'hevy-workout-1',
  title: 'Morning',
  description: 'Workout note',
  start_time: '2024-03-03T08:00:00Z',
  end_time: '2024-03-03T08:40:00Z',
  exercises,
})

describe('Hevy imports', () => {
  it('keeps duration holds as timed sets and distance exercises as cardio', () => {
    const parsed = parseHevyWorkouts([workout([
      { exercise_template_id: 'hold', title: 'Plank', sets: [{ duration_seconds: 60, weight_kg: 5 }] },
      { exercise_template_id: 'run', title: 'Treadmill', sets: [{ duration_seconds: 180, distance_meters: 1000 }] },
    ])], templates)

    expect(parsed.workouts[0].entries[0].sets[0]).toMatchObject({ sec: 60, w: 5, done: true })
    expect(parsed.workouts[0].entries[0].sets[0]).not.toHaveProperty('min')
    expect(parsed.workouts[0].entries[1].sets[0]).toMatchObject({ min: 3, speed: 20, done: true })
  })

  it('preserves repeated workout exercises, order, notes, session notes, and supersets', () => {
    const parsed = parseHevyWorkouts([workout([
      { exercise_template_id: 'hold', title: 'Plank', notes: 'first hold', superset_id: 'A', sets: [{ duration_seconds: 60, weight_kg: 5 }] },
      { exercise_template_id: 'row', title: 'Cable Row', notes: 'row cue', superset_id: 'A', sets: [{ reps: 10, weight_kg: 20 }] },
      { exercise_template_id: 'hold', title: 'Plank', notes: 'second hold', superset_id: 'B', sets: [{ duration_seconds: 30 }] },
    ])], templates)
    const imported = parsed.workouts[0]
    const holdId = parsed.customEx.find(ex => ex.n === 'plank').id
    const rowId = parsed.customEx.find(ex => ex.n === 'cable row').id

    expect(imported.note).toBe('Workout note')
    expect(imported.entries.map(entry => entry.id)).toEqual([holdId, rowId, holdId])
    expect(imported.entries.map(entry => entry.note)).toEqual(['first hold', 'row cue', 'second hold'])
    expect(imported.entries[0].sg).toBeTruthy()
    expect(imported.entries[1].sg).toBe(imported.entries[0].sg)
    expect(imported.entries[2].sg).toBeUndefined()
  })

  it('preserves weighted time mode, repeated routine exercises, notes, and superset order', () => {
    const parsed = parseHevyRoutines([{
      id: 'hevy-routine-1',
      title: 'Timed circuit',
      exercises: [
        { exercise_template_id: 'hold', title: 'Plank', notes: 'weighted hold', superset_id: 'A', sets: [{ duration_seconds: 60, weight_kg: 5 }] },
        { exercise_template_id: 'row', title: 'Cable Row', notes: 'row cue', superset_id: 'A', sets: [{ reps: 10, weight_kg: 20 }] },
        { exercise_template_id: 'hold', title: 'Plank', notes: 'bodyweight hold', superset_id: 'B', sets: [{ duration_seconds: 30 }] },
      ],
    }], templates)
    const routine = parsed.routines[0]

    expect(routine.ex).toHaveLength(3)
    expect(routine.ex[0]).toMatchObject({ sec: 60, weight: 5, mode: 'time', note: 'weighted hold' })
    expect(routine.ex.map(exercise => exercise.id)).toEqual([routine.ex[0].id, routine.ex[1].id, routine.ex[0].id])
    expect(routine.ex[0].sg).toBe(routine.ex[1].sg)
    expect(routine.ex[2].sg).toBeUndefined()
  })
})

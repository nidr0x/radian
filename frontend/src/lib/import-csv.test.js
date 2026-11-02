import { describe, expect, it } from 'vitest'
import { mergeImport, parseImport, parseWorkoutCSV } from './import-csv.js'

const FITNOTES = '\uFEFFDate,Exercise,Category,Weight,Weight Unit,Reps,Distance,Distance Unit,Time,Comment\r\n2024-01-02,Deadlift,back,135.5,lb,5,,,,"top set"\r\n'
const STRONG = [
  'Date;Workout Name;Duration;Exercise Name;Set Order;Weight;Reps;Distance;Seconds;Notes;Workout Notes;RPE',
  ['2024-03-02 07:00:00', 'Morning', '1h 5m', 'Barbell Bench Press', '1', '80,5', '8', '', '', 'top set', 'early session', '8,5'].join(';'),
  ['2024-03-02 18:00:00', 'Evening', '52m', 'Barbell Bench Press', '1', '75', '6', '', '', 'back-off', 'late session', '9'].join(';'),
].join('\r\n')
const HEVY = [
  'title,start_time,end_time,description,exercise_title,superset_id,exercise_notes,set_index,set_type,weight_kg,reps,distance_km,duration_seconds,rpe',
  'Morning,2024-03-03T08:00:00Z,2024-03-03T08:40:00Z,Push day,Bench Press (Barbell),,top set,0,failure,60.25,8,,,9.5',
].join('\n')

const emptyState = () => ({ workouts: [], bodyweight: [], customEx: [], exWeights: {} })

function importIfUsable(state, parsed) {
  if (parsed.error || (parsed.kind === 'bodyweight' ? !parsed.bodyweight.length : !parsed.workouts.length)) {
    return { added: 0 }
  }
  return mergeImport(state, parsed)
}

function importTextIfUsable(state, text) {
  try { return importIfUsable(state, parseImport(text)) }
  catch { return { added: 0, error: true } }
}

describe('CSV history imports', () => {
  it('imports a FitNotes pound set with decimals into the profile unit', () => {
    const parsed = parseImport(FITNOTES, { unit: 'kg' })
    const set = parsed.workouts[0].entries[0].sets[0]

    expect(parsed).toMatchObject({ source: 'FitNotes', fileUnit: 'lb', converted: true, sets: 1, skipped: 0 })
    expect(parsed.workouts[0]).toMatchObject({ d: '2024-01-02', name: 'Imported' })
    expect(parsed.workouts[0].entries[0].id).toBe('0032')
    expect(set).toMatchObject({ w: 61.5, r: 5, done: true })
    expect(parsed.workouts[0].vol).toBe(307.5)
    expect(parsed.workouts[0].entries[0].note).toBe('top set')
  })

  it('keeps Strong sessions apart by start time and reads comma decimals and workout duration', () => {
    const parsed = parseImport(STRONG, { unit: 'kg' })

    expect(parsed).toMatchObject({ source: 'Strong', sets: 2, skipped: 0, fileUnit: '', converted: false })
    expect(parsed.workouts).toHaveLength(2)
    expect(parsed.workouts.map(w => w.name)).toEqual(['Morning', 'Evening'])
    expect(parsed.workouts.map(w => w.d)).toEqual(['2024-03-02', '2024-03-02'])
    expect(parsed.workouts[0].end - parsed.workouts[0].start).toBe(65 * 60 * 1000)
    expect(parsed.workouts[0].entries[0].sets[0].w).toBe(80.5)
    expect(parsed.workouts[0].entries[0].note).toBe('top set')
    expect(parsed.workouts[0].note).toBe('early session')
  })

  it('imports Hevy CSV titles, ISO times, failure sets and kg-to-pound decimals', () => {
    const parsed = parseImport(HEVY, { unit: 'lb' })
    const workout = parsed.workouts[0]
    const set = workout.entries[0].sets[0]

    expect(parsed).toMatchObject({ source: 'Hevy', sets: 1, skipped: 0, converted: true })
    expect(workout).toMatchObject({ d: '2024-03-03', name: 'Morning' })
    expect(workout.end - workout.start).toBe(40 * 60 * 1000)
    expect(workout.entries[0].id).toBe('0025')
    expect(set.w).toBe(132.8)
    expect(set).toMatchObject({ r: 8, failure: true, rpe: 9.5 })
  })

  it('does not modify state for missing required columns or malformed quoted CSV', () => {
    const state = emptyState()
    const before = structuredClone(state)
    const missingExercise = parseImport('Date,Reps\n2024-01-02,5')
    const malformedCsv = 'Date,Exercise,Weight,Reps\n2024-01-02,"Deadlift,80,5'

    expect(missingExercise.error).toBe('unrecognised')
    expect(() => parseImport(malformedCsv)).toThrow(SyntaxError)
    expect(importIfUsable(state, missingExercise)).toEqual({ added: 0 })
    expect(importTextIfUsable(state, malformedCsv)).toEqual({ added: 0, error: true })
    expect(state).toEqual(before)
  })

  it('skips invalid rows without changing state when the file has no usable workout', () => {
    const state = emptyState()
    const before = structuredClone(state)
    const parsed = parseWorkoutCSV('Date,Exercise,Weight,Weight Unit,Reps\n2024-01-02,Deadlift,-10,kg,5')

    expect(parsed).toMatchObject({ kind: 'workouts', sets: 0, skipped: 1, workouts: [] })
    expect(importIfUsable(state, parsed)).toEqual({ added: 0 })
    expect(state).toEqual(before)
  })

  it('merges duplicate imports once and leaves the first workout intact', () => {
    const state = emptyState()
    const parsed = parseImport(STRONG, { unit: 'kg' })

    expect(mergeImport(state, parsed)).toEqual({ added: 2, skipped: 0 })
    const firstImport = structuredClone(state)
    expect(mergeImport(state, parseImport(STRONG, { unit: 'kg' }))).toEqual({ added: 0, skipped: 2 })
    expect(state).toEqual(firstImport)
  })
})

describe('Apple Health body-weight exports', () => {
  it('reads decimal pounds and kilograms per record and keeps the last weigh-in per day', () => {
    const xml = [
      '<HealthData locale="en_US">',
      '<Record type="HKQuantityTypeIdentifierBodyMass" unit="lb" value="150.5" startDate="2024-01-02 06:00:00 +0000"/>',
      '<Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="70.2" startDate="2024-01-03 06:00:00 +0000"/>',
      '<Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="70.45" startDate="2024-01-03 08:00:00 +0000"/>',
      '</HealthData>',
    ].join('\n')
    const parsed = parseImport(xml, { unit: 'kg' })

    expect(parsed).toMatchObject({ kind: 'bodyweight', source: 'Apple Health', fileUnit: 'kg / lb', converted: true })
    expect(parsed.bodyweight).toEqual([
      { d: '2024-01-02', w: 68.3, t: new Date('2024-01-02T06:00:00Z').getTime() },
      { d: '2024-01-03', w: 70.5, t: new Date('2024-01-03T08:00:00Z').getTime() },
    ])
  })

  it('does not modify state for malformed XML or an invalid-only body-mass entry', () => {
    const state = emptyState()
    const before = structuredClone(state)
    const malformed = parseImport('<HealthData><Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="70"')
    const invalidDate = parseImport([
      '<HealthData>',
      '<Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="70" startDate="2024-02-30 08:00:00 +0000"/>',
      '</HealthData>',
    ].join(''))

    expect(malformed.error).toBeTruthy()
    expect(invalidDate.error).toBeTruthy()
    expect(importIfUsable(state, malformed)).toEqual({ added: 0 })
    expect(importIfUsable(state, invalidDate)).toEqual({ added: 0 })
    expect(state).toEqual(before)
  })

  it('keeps an existing weigh-in when the same export is imported again', () => {
    const parsed = parseImport('<HealthData><Record type="HKQuantityTypeIdentifierBodyMass" unit="kg" value="72.4" startDate="2024-01-02 08:00:00 +0000"/></HealthData>')
    const state = { ...emptyState(), bodyweight: [{ d: '2024-01-02', w: 71.9, t: 10 }] }
    const before = structuredClone(state)

    expect(mergeImport(state, parsed)).toEqual({ added: 0, skipped: 1 })
    expect(state).toEqual(before)
  })
})

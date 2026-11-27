import { describe, expect, it } from 'vitest'
import { buildIntervalSession, canStartInterval, confirmIntervalStation } from './interval-session.js'
import { dispatchInterval } from './interval-engine.js'

const circuit = { v: 1, mode: 'circuit', rounds: 3, gapSec: 15, roundRestSec: 0 }

describe('interval session setup', () => {
  it('buildIntervalSession_preservesNormalSessionWithoutInterval', () => {
    const active = { id: 'workout-1', entries: [{ id: 'squat', sets: [] }] }
    const result = buildIntervalSession(active, { id: 'routine-1', ex: [{ id: 'squat' }] }, 1_000)

    expect(result).toBe(active)
  })

  it('buildIntervalSession_snapshotsStationsAtStart', () => {
    const routine = {
      id: 'routine-1',
      interval: circuit,
      ex: [{ id: 'squat' }, { id: 'row' }, { id: 'squat' }],
    }
    const active = {
      id: 'workout-1',
      entries: [
        { id: 'squat', rid: 'routine-1', sets: [] },
        { id: 'row', rid: 'routine-1', sets: [] },
        { id: 'squat', rid: 'routine-1', sets: [] },
      ],
    }
    const started = buildIntervalSession(active, routine, 1_000)
    routine.ex.reverse()

    expect(started.interval).toMatchObject({ status: 'ready', plan: circuit, workoutId: 'workout-1' })
    expect(started.interval.stations).toEqual([
      { entryIndex: 0, entryKey: expect.any(String), exerciseId: 'squat', routineId: 'routine-1' },
      { entryIndex: 1, entryKey: expect.any(String), exerciseId: 'row', routineId: 'routine-1' },
      { entryIndex: 2, entryKey: expect.any(String), exerciseId: 'squat', routineId: 'routine-1' },
    ])
    expect(started.interval.stations.map(station => station.entryKey)).toHaveLength(3)
    expect(new Set(started.interval.stations.map(station => station.entryKey)).size).toBe(3)
  })

  it('canStartInterval_rejectsMixedRoutineSelection', () => {
    const result = canStartInterval([
      { id: 'normal', ex: [{ id: 'squat' }] },
      { id: 'circuit', interval: circuit, ex: [{ id: 'row' }] },
    ], 'pwa')

    expect(result).toEqual({ allowed: false, reason: 'mixed' })
  })

  it('canStartInterval_rejectsWatchLaunch', () => {
    expect(canStartInterval([{ id: 'circuit', interval: circuit, ex: [{ id: 'row' }] }], 'watch'))
      .toEqual({ allowed: false, reason: 'watch' })
  })

  it('confirmIntervalStation_logsActualWorkOnce', () => {
    const started = buildIntervalSession({ id: 'workout-1', entries: [
      { id: 'squat', sets: [{ w: 0, r: 0, done: false }] },
    ] }, { id: 'routine-1', interval: { ...circuit, rounds: 1, gapSec: 0 }, ex: [{ id: 'squat' }] }, 1_000)
    started.interval = dispatchInterval(started.interval, { type: 'start' }, 1_000).run

    const logged = confirmIntervalStation(started, { round: 0, station: 0 }, [
      { setIndex: 0, values: { w: 40, r: 8 } },
    ], 2_000)
    const duplicate = confirmIntervalStation(logged, { round: 0, station: 0 }, [
      { setIndex: 0, values: { w: 400, r: 80 } },
    ], 3_000)

    expect(logged.entries[0].sets[0]).toMatchObject({ w: 40, r: 8, done: true, at: 2_000 })
    expect(logged.interval.confirmed).toEqual([{ round: 0, station: 0 }])
    expect(duplicate).toBe(logged)
    expect(duplicate.entries[0].sets[0].w).toBe(40)
  })

  it('confirmIntervalStation_doesNotLogSkippedWork', () => {
    const active = buildIntervalSession({ id: 'workout-2', entries: [
      { id: 'row', sets: [{ w: 0, r: 0, done: false }] },
    ] }, { id: 'routine-1', interval: { ...circuit, rounds: 1 }, ex: [{ id: 'row' }] }, 1_000)
    active.interval = dispatchInterval(active.interval, { type: 'start' }, 1_000).run
    active.interval = dispatchInterval(active.interval, { type: 'skip-work' }, 2_000).run

    const result = confirmIntervalStation(active, { round: 0, station: 0 }, [
      { setIndex: 0, values: { w: 50, r: 6 } },
    ], 3_000)

    expect(result).toBe(active)
    expect(result.entries[0].sets[0]).toEqual({ w: 0, r: 0, done: false })
  })

  it('confirmIntervalStation_appendsRoundsBeyondPrescription', () => {
    const active = buildIntervalSession({ id: 'workout-3', entries: [
      { id: 'squat', sets: [{ w: 20, r: 8, done: false }, { w: 20, r: 8, done: false }] },
    ] }, { id: 'routine-1', interval: { ...circuit, rounds: 1, gapSec: 0 }, ex: [{ id: 'squat' }] }, 1_000)
    active.interval = dispatchInterval(active.interval, { type: 'start' }, 1_000).run
    let result = confirmIntervalStation(active, { round: 0, station: 0 }, [
      { setIndex: 0, values: { w: 20, r: 8 } },
    ], 2_000)
    result.interval = dispatchInterval(result.interval, { type: 'start' }, 3_000).run
    const reusedSet = confirmIntervalStation(result, { round: 1, station: 0 }, [
      { setIndex: 0, values: { w: 20, r: 8 } },
    ], 3_500)
    expect(reusedSet).toBe(result)
    result = confirmIntervalStation(result, { round: 1, station: 0 }, [
      { setIndex: 1, values: { w: 20, r: 9 } },
    ], 4_000)

    expect(result.interval).toMatchObject({ status: 'done', rounds: 2, totalRounds: 2 })
    expect(result.interval.confirmed).toEqual([{ round: 0, station: 0 }, { round: 1, station: 0 }])
    expect(result.entries[0].sets.map(set => set.done)).toEqual([true, true])
  })

  it('confirmIntervalStation_keepsDuplicateExercisesDistinct', () => {
    const active = buildIntervalSession({ id: 'workout-4', entries: [
      { id: 'squat', sets: [{ w: 0, r: 0, done: false }] },
      { id: 'squat', sets: [{ w: 0, r: 0, done: false }] },
    ] }, { id: 'routine-1', interval: { ...circuit, rounds: 1, gapSec: 0 }, ex: [{ id: 'squat' }, { id: 'squat' }] }, 1_000)
    active.interval = dispatchInterval(active.interval, { type: 'start' }, 1_000).run

    const result = confirmIntervalStation(active, { round: 0, station: 0 }, [
      { setIndex: 0, values: { w: 25, r: 10 } },
    ], 2_000)

    expect(result.entries.map(entry => entry.sets[0].done)).toEqual([true, false])
    expect(result.interval.confirmed).toEqual([{ round: 0, station: 0 }])
  })

  it('confirmIntervalStation_rejectsConfirmationAfterTheTimedBlockExpires', () => {
    const active = buildIntervalSession({ id: 'workout-5', entries: [
      { id: 'squat', sets: [{ w: 0, r: 0, done: false }] },
      { id: 'row', sets: [{ w: 0, r: 0, done: false }] },
    ] }, {
      id: 'routine-1',
      interval: { v: 1, mode: 'intervals', workSec: 5, restSec: 0, rounds: 1 },
      ex: [{ id: 'squat' }, { id: 'row' }],
    }, 1_000)
    active.interval = dispatchInterval(active.interval, { type: 'start' }, 1_000).run

    const result = confirmIntervalStation(active, { round: 0, station: 0 }, [
      { setIndex: 0, values: { w: 40, r: 8 } },
    ], 6_000)

    expect(result).toBe(active)
    expect(active.interval.confirmed).toEqual([])
    expect(active.interval.skipped).toEqual([])
    expect(active.entries[0].sets[0]).toEqual({ w: 0, r: 0, done: false })
  })
})

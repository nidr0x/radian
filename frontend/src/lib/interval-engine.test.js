import { describe, expect, it } from 'vitest'
import {
  cleanIntervalPlan,
  createIntervalRun,
  dispatchInterval,
  reconcileInterval,
} from './interval-engine.js'

const stations = [
  { entryIndex: 0, exerciseId: 'push-up', routineId: 'routine-a' },
  { entryIndex: 1, exerciseId: 'row', routineId: 'routine-a' },
]

describe('interval engine', () => {
  it('cleanIntervalPlan_clampsFieldsAndRejectsUnknownMode', () => {
    expect(cleanIntervalPlan({ v: 1, mode: 'circuit', rounds: 99, gapSec: -5, roundRestSec: 900 }))
      .toEqual({ v: 1, mode: 'circuit', rounds: 50, gapSec: 0, roundRestSec: 600 })
    expect(cleanIntervalPlan({ v: 1, mode: 'amrap', durationSec: 5 }))
      .toEqual({ v: 1, mode: 'amrap', durationSec: 60 })
    expect(cleanIntervalPlan({ v: 1, mode: 'emom', windowSec: 2, rounds: 200 }))
      .toEqual({ v: 1, mode: 'emom', windowSec: 10, rounds: 99 })
    expect(cleanIntervalPlan({ v: 1, mode: 'intervals', workSec: 1, restSec: 900, rounds: 0 }))
      .toEqual({ v: 1, mode: 'intervals', workSec: 5, restSec: 600, rounds: 1 })
    expect(cleanIntervalPlan({ v: 1, mode: 'unknown' })).toBeNull()
  })

  it('dispatchInterval_freezesRemainingTimeAcrossPause', () => {
    const run = createIntervalRun({
      plan: { v: 1, mode: 'amrap', durationSec: 300 }, stations, workoutId: 'workout-1', now: 1_000,
    })
    const started = dispatchInterval(run, { type: 'start' }, 1_000).run
    const paused = dispatchInterval(started, { type: 'pause' }, 101_000).run
    expect(paused).toMatchObject({ status: 'paused', pausedRemainingMs: 200_000 })

    const resumed = dispatchInterval(paused, { type: 'resume' }, 900_000).run
    expect(resumed).toMatchObject({ status: 'running', deadlineAt: 1_100_000 })
  })

  it('dispatchInterval_excludesAnUnfinishedPauseWhenStopped', () => {
    const run = createIntervalRun({
      plan: { v: 1, mode: 'amrap', durationSec: 300 }, stations, workoutId: 'workout-1', now: 1_000,
    })
    const started = dispatchInterval(run, { type: 'start' }, 1_000).run
    const paused = dispatchInterval(started, { type: 'pause' }, 11_000).run

    const stopped = dispatchInterval(paused, { type: 'stop' }, 901_000).run

    expect(stopped).toMatchObject({
      status: 'done', endedAt: 901_000, elapsedMs: 10_000, pausedDurationMs: 890_000,
      pausedAt: null, pausedRemainingMs: null,
    })
  })

  it('reconcileInterval_advancesExpiredPhasesOnceWithoutLoggingWork', () => {
    const run = createIntervalRun({
      plan: { v: 1, mode: 'intervals', workSec: 10, restSec: 5, rounds: 2 },
      stations,
      workoutId: 'workout-1',
      now: 0,
    })
    const started = dispatchInterval(run, { type: 'start' }, 0).run
    const first = reconcileInterval(started, 11_000)
    const again = reconcileInterval(first.run, 11_000)

    expect(first.run).toMatchObject({ status: 'running', phase: 'rest', station: 0 })
    expect(first.run.confirmed).toEqual([])
    expect(first.run.skipped).toEqual([{ round: 0, station: 0 }])
    expect(again.run.skipped).toEqual(first.run.skipped)
    expect(again.effects).toEqual([])
  })

  it('dispatchInterval_doesNotApplyAStaleSkipToTheNextZeroRestBlock', () => {
    const run = createIntervalRun({
      plan: { v: 1, mode: 'intervals', workSec: 5, restSec: 0, rounds: 1 },
      stations,
      workoutId: 'workout-1',
      now: 0,
    })
    const started = dispatchInterval(run, { type: 'start' }, 0).run

    const result = dispatchInterval(started, { type: 'skip-work', round: 0, station: 0 }, 5_000).run

    expect(result).toMatchObject({ status: 'running', phase: 'work', round: 0, station: 1, blockIndex: 1 })
    expect(result.skipped).toEqual([{ round: 0, station: 0 }])
    expect(result.confirmed).toEqual([])
  })

  it('dispatchInterval_doesNotConfirmAStaleTimedBlockAsTheNextStation', () => {
    const run = createIntervalRun({
      plan: { v: 1, mode: 'intervals', workSec: 5, restSec: 0, rounds: 1 },
      stations,
      workoutId: 'workout-1',
      now: 0,
    })
    const started = dispatchInterval(run, { type: 'start' }, 0).run

    const result = dispatchInterval(started, { type: 'confirm-work', round: 0, station: 0 }, 5_000).run

    expect(result).toMatchObject({ status: 'running', phase: 'work', round: 0, station: 1, blockIndex: 1 })
    expect(result.skipped).toEqual([{ round: 0, station: 0 }])
    expect(result.confirmed).toEqual([])
  })

  it('dispatchInterval_keepsEmomBoundariesAnchoredToStart', () => {
    const run = createIntervalRun({
      plan: { v: 1, mode: 'emom', windowSec: 60, rounds: 2 }, stations, workoutId: 'workout-1', now: 5_000,
    })
    const started = dispatchInterval(run, { type: 'start' }, 5_000).run
    const completedEarly = dispatchInterval(started, { type: 'confirm-work' }, 25_000).run

    expect(completedEarly).toMatchObject({ phase: 'rest', deadlineAt: 65_000, station: 0 })
    const next = reconcileInterval(completedEarly, 65_000).run
    expect(next).toMatchObject({ phase: 'work', deadlineAt: 125_000, station: 1, startedAt: 5_000 })
  })

  it('amrap_stopsAtCapAndKeepsExplicitRoundsAndPartialReps', () => {
    const run = createIntervalRun({ plan: { v: 1, mode: 'amrap', durationSec: 60 }, stations, now: 0 })
    const started = dispatchInterval(run, { type: 'start' }, 0).run
    started.rounds = 4
    started.partialReps = 3

    const finished = reconcileInterval(started, 90_000).run

    expect(finished).toMatchObject({ status: 'done', endedAt: 60_000, elapsedMs: 60_000, rounds: 4, partialReps: 3 })
    expect(finished.confirmed).toEqual([])
    expect(finished.skipped).toEqual([])
  })

  it('emom_earlyCompletionKeepsOriginalWindowBoundary', () => {
    const run = createIntervalRun({
      plan: { v: 1, mode: 'emom', windowSec: 60, rounds: 2 }, stations: stations.slice(0, 1), now: 500,
    })
    const started = dispatchInterval(run, { type: 'start' }, 500).run
    const completedEarly = dispatchInterval(started, { type: 'confirm-work' }, 20_000).run

    expect(completedEarly).toMatchObject({ phase: 'rest', deadlineAt: 60_500, confirmed: [{ round: 0, station: 0 }] })
    expect(reconcileInterval(completedEarly, 60_500).run).toMatchObject({
      phase: 'work', round: 1, station: 0, deadlineAt: 120_500,
    })
  })

  it('emom_expiredStationIsSkipped', () => {
    const run = createIntervalRun({
      plan: { v: 1, mode: 'emom', windowSec: 60, rounds: 2 }, stations: stations.slice(0, 1), now: 500,
    })
    const started = dispatchInterval(run, { type: 'start' }, 500).run
    const recovered = reconcileInterval(started, 60_500).run

    expect(recovered).toMatchObject({
      status: 'running', phase: 'work', round: 1, deadlineAt: 120_500,
      confirmed: [], skipped: [{ round: 0, station: 0 }],
    })
  })

  it('intervals_tabataRunsEight20By10Blocks', () => {
    const run = createIntervalRun({
      plan: { v: 1, mode: 'intervals', workSec: 20, restSec: 10, rounds: 8 },
      stations: stations.slice(0, 1), now: 0,
    })
    let current = dispatchInterval(run, { type: 'start' }, 0).run
    for (let block = 0; block < 8; block++) {
      current = reconcileInterval(current, block * 30_000 + 20_000).run
      if (block < 7) current = reconcileInterval(current, (block + 1) * 30_000).run
    }
    current = reconcileInterval(current, 240_000).run

    expect(current).toMatchObject({ status: 'done', endedAt: 240_000, rounds: 0 })
    expect(current.confirmed).toEqual([])
    expect(current.skipped).toHaveLength(8)
  })
})

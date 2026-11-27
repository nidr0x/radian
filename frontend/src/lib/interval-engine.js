const MODES = Object.freeze({
  circuit: {
    defaults: { rounds: 3, gapSec: 15, roundRestSec: 0 },
    limits: { rounds: [1, 50], gapSec: [0, 300], roundRestSec: [0, 600] },
  },
  amrap: {
    defaults: { durationSec: 600 },
    limits: { durationSec: [60, 3600] },
  },
  emom: {
    defaults: { windowSec: 60, rounds: 10 },
    limits: { windowSec: [10, 600], rounds: [1, 99] },
  },
  intervals: {
    defaults: { workSec: 20, restSec: 10, rounds: 8 },
    limits: { workSec: [5, 3600], restSec: [0, 600], rounds: [1, 50] },
  },
})

const objectOf = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null
const finiteNow = value => Number.isFinite(value) ? value : 0
const finiteInt = (value, fallback, [min, max]) => {
  const number = Number(value)
  return Math.max(min, Math.min(max, Math.trunc(Number.isFinite(number) ? number : fallback)))
}

/** Return a versioned interval plan with all supported fields bounded to their documented range. */
export function cleanIntervalPlan(plan) {
  const source = objectOf(plan)
  if (!source || source.v !== 1 || !Object.hasOwn(MODES, source.mode)) return null
  const mode = MODES[source.mode]
  return {
    v: 1,
    mode: source.mode,
    ...Object.fromEntries(Object.entries(mode.limits).map(([key, range]) => [
      key,
      finiteInt(source[key], mode.defaults[key], range),
    ])),
  }
}

function plainStation(station, entryIndex) {
  const source = objectOf(station) || {}
  return Object.fromEntries([
    ['entryIndex', Number.isInteger(source.entryIndex) ? source.entryIndex : entryIndex],
    ['entryKey', typeof source.entryKey === 'string' ? source.entryKey : undefined],
    ['exerciseId', typeof source.exerciseId === 'string' ? source.exerciseId : undefined],
    ['routineId', typeof source.routineId === 'string' ? source.routineId : undefined],
    ['name', typeof source.name === 'string' ? source.name : undefined],
  ].filter(([, value]) => value !== undefined))
}

/** Create the plain, serializable state for one workout's interval run. */
export function createIntervalRun({ plan, stations = [], workoutId = null, now = 0 } = {}) {
  const normalized = cleanIntervalPlan(plan)
  if (!normalized) return null
  const createdAt = finiteNow(now)
  return {
    v: 1,
    plan: normalized,
    workoutId: typeof workoutId === 'string' ? workoutId : null,
    stations: Array.isArray(stations) ? stations.map(plainStation) : [],
    totalRounds: normalized.rounds,
    status: 'ready',
    phase: 'ready',
    phaseStartedAt: createdAt,
    deadlineAt: null,
    startedAt: null,
    endedAt: null,
    elapsedMs: 0,
    pausedAt: null,
    pausedRemainingMs: null,
    pausedDurationMs: 0,
    scheduleStartedAt: null,
    blockIndex: 0,
    round: 0,
    station: 0,
    pendingBlockIndex: null,
    roundStartedAt: null,
    rounds: 0,
    confirmed: [],
    skipped: [],
    loggedSetIndices: [],
    partialReps: 0,
    roundTimes: [],
  }
}

const totalRounds = run => run.totalRounds ?? run.plan.rounds
const totalBlocks = run => run.stations.length * totalRounds(run)
const durationMs = seconds => seconds * 1000
const hasPosition = (items, round, station) => items.some(item => item.round === round && item.station === station)

function withEffect(effects, type, run, at, extra = {}) {
  effects.push({ type, at, phase: run.phase, round: run.round, station: run.station, ...extra })
}

function finishRun(run, at, effects) {
  const pausedDuration = Number.isFinite(run.pausedDurationMs) ? Math.max(0, run.pausedDurationMs) : 0
  const currentPause = Number.isFinite(run.pausedAt) ? Math.max(0, at - run.pausedAt) : 0
  run.pausedDurationMs = pausedDuration + currentPause
  run.pausedAt = null
  run.pausedRemainingMs = null
  run.status = 'done'
  run.phase = 'done'
  run.phaseStartedAt = at
  run.deadlineAt = null
  run.pendingBlockIndex = null
  run.endedAt = at
  run.elapsedMs = Math.max(0, at - (run.startedAt ?? at) - run.pausedDurationMs)
  withEffect(effects, 'finished', run, at)
}

function setBlock(run, blockIndex, at) {
  const total = totalBlocks(run)
  if (blockIndex >= total || !run.stations.length) return false
  const previousRound = run.round
  run.blockIndex = blockIndex
  run.round = Math.floor(blockIndex / run.stations.length)
  run.station = blockIndex % run.stations.length
  run.phase = 'work'
  run.phaseStartedAt = at
  run.pendingBlockIndex = null
  if (run.round !== previousRound) run.roundStartedAt = at
  if (run.plan.mode === 'intervals') run.deadlineAt = at + durationMs(run.plan.workSec)
  else if (run.plan.mode === 'emom') {
    run.deadlineAt = run.scheduleStartedAt + durationMs((blockIndex + 1) * run.plan.windowSec)
  } else run.deadlineAt = null
  return true
}

function completeRound(run, at) {
  if (!run.stations.every((_, station) => hasPosition(run.confirmed, run.round, station))) return
  const complete = run.round + 1
  if (complete <= run.rounds) return
  run.rounds = complete
  run.roundTimes.push({ round: complete, elapsedMs: Math.max(0, at - (run.roundStartedAt ?? run.startedAt)) })
}

function advanceAfterWork(run, at, effects, { completed, scheduled = false } = {}) {
  const round = run.round
  const station = run.station
  const nextBlock = run.blockIndex + 1
  if (completed && !hasPosition(run.confirmed, round, station)) run.confirmed.push({ round, station })
  if (!completed && !hasPosition(run.skipped, round, station)) run.skipped.push({ round, station })

  if (run.plan.mode === 'emom') {
    if (station === run.stations.length - 1) completeRound(run, at)
    run.phase = 'rest'
    run.phaseStartedAt = at
    run.pendingBlockIndex = nextBlock
    run.finishAfterWindow = nextBlock >= totalBlocks(run)
    // Every EMOM slot ends at its original start-relative boundary, whether work finished early
    // or the device returned from sleep after that boundary.
    run.deadlineAt = run.scheduleStartedAt + durationMs((run.blockIndex + 1) * run.plan.windowSec)
    withEffect(effects, completed ? 'work-confirmed' : 'work-skipped', run, at)
    return
  }

  if (station === run.stations.length - 1) completeRound(run, at)
  if (nextBlock >= totalBlocks(run)) {
    if (run.plan.mode === 'intervals' && run.plan.restSec > 0) {
      run.phase = 'rest'
      run.phaseStartedAt = at
      run.deadlineAt = at + durationMs(run.plan.restSec)
      run.pendingBlockIndex = nextBlock
      withEffect(effects, completed ? 'work-confirmed' : 'work-skipped', run, at)
      return
    }
    finishRun(run, at, effects)
    return
  }

  let restSec = 0
  let restPhase = 'rest'
  if (run.plan.mode === 'circuit') {
    if (station === run.stations.length - 1) {
      restSec = run.plan.roundRestSec
      restPhase = 'roundRest'
    } else restSec = run.plan.gapSec
  } else if (run.plan.mode === 'intervals') restSec = run.plan.restSec

  const restStart = scheduled ? at : at
  if (restSec > 0) {
    run.phase = restPhase
    run.phaseStartedAt = restStart
    run.deadlineAt = restStart + durationMs(restSec)
    run.pendingBlockIndex = nextBlock
    withEffect(effects, completed ? 'work-confirmed' : 'work-skipped', run, at)
    return
  }

  if (run.plan.mode === 'intervals') completeRound(run, at)
  setBlock(run, nextBlock, at)
  withEffect(effects, completed ? 'work-confirmed' : 'work-skipped', run, at)
}

function applyAction(run, action, now, effects) {
  const type = typeof action === 'string' ? action : action?.type
  if (type === 'start' && run.status === 'done' && run.plan.mode === 'circuit' && run.stations.length) {
    const nextRound = totalRounds(run)
    run.totalRounds = nextRound + 1
    run.status = 'running'
    run.phase = 'work'
    run.phaseStartedAt = now
    run.startedAt ??= now
    run.endedAt = null
    run.pausedAt = null
    run.pausedRemainingMs = null
    run.blockIndex = nextRound * run.stations.length
    run.round = nextRound
    run.station = 0
    run.roundStartedAt = now
    run.deadlineAt = null
    withEffect(effects, 'round-added', run, now)
    return
  }
  if (type === 'start' && run.status === 'ready') {
    if (run.plan.mode !== 'amrap' && !run.stations.length) return
    run.status = 'running'
    run.startedAt = now
    run.scheduleStartedAt = now
    run.roundStartedAt = now
    run.phase = 'work'
    run.phaseStartedAt = now
    if (run.plan.mode === 'amrap') run.deadlineAt = now + durationMs(run.plan.durationSec)
    else if (run.plan.mode === 'intervals') run.deadlineAt = now + durationMs(run.plan.workSec)
    else if (run.plan.mode === 'emom') run.deadlineAt = now + durationMs(run.plan.windowSec)
    else run.deadlineAt = null
    withEffect(effects, 'started', run, now)
    return
  }

  if (type === 'pause' && run.status === 'running') {
    run.status = 'paused'
    run.pausedAt = now
    run.pausedRemainingMs = run.deadlineAt == null ? null : Math.max(0, run.deadlineAt - now)
    withEffect(effects, 'paused', run, now)
    return
  }

  if (type === 'resume' && run.status === 'paused') {
    const pauseDuration = Math.max(0, now - run.pausedAt)
    run.pausedDurationMs += pauseDuration
    run.scheduleStartedAt += pauseDuration
    run.status = 'running'
    run.phaseStartedAt = now
    run.deadlineAt = run.pausedRemainingMs == null ? null : now + run.pausedRemainingMs
    run.pausedAt = null
    run.pausedRemainingMs = null
    withEffect(effects, 'resumed', run, now)
    return
  }

  if (type === 'stop' && (run.status === 'running' || run.status === 'paused')) {
    finishRun(run, now, effects)
    return
  }

  if ((type === 'confirm-work' || type === 'skip-work') && run.status === 'running' && run.phase === 'work') {
    if (run.plan.mode === 'amrap') return
    if (Number.isInteger(action?.round) && action.round !== run.round) return
    if (Number.isInteger(action?.station) && action.station !== run.station) return
    advanceAfterWork(run, now, effects, { completed: type === 'confirm-work' })
  }
}

function reconcileMutable(run, now, effects) {
  if (run.status !== 'running' || run.deadlineAt == null) return
  let steps = 0
  while (run.status === 'running' && run.deadlineAt != null && run.deadlineAt <= now && steps++ < 10_000) {
    const boundary = run.deadlineAt
    if (run.plan.mode === 'amrap') {
      finishRun(run, boundary, effects)
      continue
    }
    if (run.phase === 'rest' || run.phase === 'roundRest') {
      const pending = run.pendingBlockIndex
      if (pending >= totalBlocks(run)) {
        finishRun(run, boundary, effects)
        continue
      }
      if (!setBlock(run, pending, boundary)) finishRun(run, boundary, effects)
      else withEffect(effects, 'phase-advanced', run, boundary)
      continue
    }
    if (run.phase !== 'work') {
      run.deadlineAt = null
      continue
    }

    if (run.plan.mode === 'emom') {
      advanceAfterWork(run, boundary, effects, { completed: false, scheduled: true })
      continue
    }
    if (run.plan.mode === 'intervals') {
      advanceAfterWork(run, boundary, effects, { completed: false, scheduled: true })
      continue
    }
    run.deadlineAt = null
  }
}

/** Apply one user action without mutating the previously persisted run. */
export function dispatchInterval(source, action, now = 0) {
  if (!objectOf(source)) return { run: null, effects: [] }
  const run = structuredClone(source)
  const at = finiteNow(now)
  const effects = []
  if (run.status === 'running' && action?.type !== 'start' && action?.type !== 'resume') reconcileMutable(run, at, effects)
  applyAction(run, action, at, effects)
  return { run, effects }
}

/** Advance expired timed blocks from absolute deadlines; expired work is skipped, never confirmed. */
export function reconcileInterval(source, now = 0) {
  if (!objectOf(source)) return { run: null, effects: [] }
  const run = structuredClone(source)
  const effects = []
  reconcileMutable(run, finiteNow(now), effects)
  return { run, effects }
}

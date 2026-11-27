import { cleanIntervalPlan, createIntervalRun, dispatchInterval } from './interval-engine.js'

const list = value => Array.isArray(value) ? value : []

/** Whether the selected routines can be started with the requested entry point. */
export function canStartInterval(routines, source = 'pwa') {
  const selected = (Array.isArray(routines) ? routines : routines ? [routines] : []).filter(Boolean)
  const configured = selected.filter(routine => routine.interval != null)
  if (!configured.length) return { allowed: true, reason: null }
  if (selected.length !== 1) return { allowed: false, reason: 'mixed' }
  if (source === 'watch' || source === 'apple-watch') return { allowed: false, reason: 'watch' }
  if (!cleanIntervalPlan(configured[0].interval)) return { allowed: false, reason: 'invalid' }
  if (!list(configured[0].ex).length) return { allowed: false, reason: 'empty' }
  return { allowed: true, reason: null }
}

/** Add the interval configuration and an immutable station order to the active workout snapshot. */
export function buildIntervalSession(active, routine, now = 0) {
  if (!active || !routine?.interval) return active
  const plan = cleanIntervalPlan(routine.interval)
  if (!plan || !list(active.entries).length) return null

  const entries = active.entries.map((entry, entryIndex) => ({
    ...entry,
    intervalEntryKey: `${active.id}:${entryIndex}`,
  }))
  const stations = entries.map((entry, entryIndex) => ({
    entryIndex,
    entryKey: entry.intervalEntryKey,
    exerciseId: String(entry.id),
    ...(typeof entry.rid === 'string' ? { routineId: entry.rid } : { routineId: routine.id }),
    ...(typeof entry.name === 'string' ? { name: entry.name } : {}),
  }))
  const interval = createIntervalRun({ plan, stations, workoutId: active.id, now })
  if (!interval) return null
  return { ...active, entries, interval }
}

const positionIn = (items, round, station) => list(items).some(item => item.round === round && item.station === station)

function actualSetsOf(actual) {
  if (Array.isArray(actual)) return actual
  if (Array.isArray(actual?.sets)) return actual.sets
  return actual && typeof actual === 'object' ? [actual] : []
}

function confirmedValues(actual) {
  const source = actual?.values && typeof actual.values === 'object' ? actual.values : actual
  const values = {}
  for (const key of ['w', 'r', 'sec', 'min', 'speed', 'distance', 'incline', 'effort', 'hr', 'restHr']) {
    if (Number.isFinite(Number(source?.[key])) && source[key] != null) values[key] = Number(source[key])
  }
  return values
}

/** Log only the set values explicitly supplied by the workout editor, once per round/station. */
export function confirmIntervalStation(active, { round, station } = {}, actual, now = 0) {
  const interval = active?.interval
  if (!interval || !Number.isInteger(round) || !Number.isInteger(station)) return active
  if (positionIn(interval.confirmed, round, station) || positionIn(interval.skipped, round, station)) return active
  if (interval.status !== 'running' || interval.round !== round || interval.station !== station || interval.phase !== 'work') return active

  const descriptor = interval.stations?.[station]
  const entry = active.entries?.find(row => row?.intervalEntryKey === descriptor?.entryKey)
  if (!entry) return active
  const loggedSetIndices = Array.isArray(interval.loggedSetIndices) ? interval.loggedSetIndices : []
  const alreadyLogged = new Set(loggedSetIndices.filter(item => item?.station === station).map(item => item.setIndex))
  const pending = actualSetsOf(actual).flatMap(item => {
    const setIndex = Number.isInteger(item?.setIndex) ? item.setIndex : Number.isInteger(item?.index) ? item.index : -1
    const values = confirmedValues(item)
    const alreadyDone = item?.done === true
    const row = entry.sets?.[setIndex]
    if (setIndex < 0 || alreadyLogged.has(setIndex) || row?.warmup === true || row?.phase === 'warmup') return []
    if (!alreadyDone && !Object.keys(values).length) return []
    if (setIndex >= 0 && setIndex < entry.sets.length) return [{ setIndex, values, alreadyDone }]
    return []
  })
  if (!pending.length) return active

  const dispatched = dispatchInterval(interval, { type: 'confirm-work', round, station }, now)
  if (!positionIn(dispatched.run?.confirmed, round, station)) return active

  const updated = structuredClone(active)
  const updatedEntry = updated.entries.find(row => row?.intervalEntryKey === descriptor.entryKey)
  for (const item of pending) {
    const row = updatedEntry.sets[item.setIndex]
    if (!row || row.warmup === true || row.phase === 'warmup') continue
    Object.assign(row, item.values)
    row.done = true
    if (!Number.isFinite(row.at)) row.at = Number.isFinite(now) ? now : 0
  }
  if (!updatedEntry.sets.some(row => row?.done === true && row.warmup !== true && row.phase !== 'warmup')) return active

  updated.interval = dispatched.run
  updated.interval.loggedSetIndices = [
    ...loggedSetIndices,
    ...pending.map(({ setIndex }) => ({ station, setIndex })),
  ]
  return updated
}

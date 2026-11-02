const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const list = value => Array.isArray(value) ? value : []
const weight = value => Number.isFinite(value) ? value : undefined
const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 7])
const dateOf = value => {
  if (typeof value !== 'string') return ''
  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const isTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
  const date = isDate ? value : isTimestamp ? value.slice(0, 10) : ''
  if (!date) return ''
  const parsed = new Date(`${date}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : ''
}
const timestampOf = value => {
  if (Number.isFinite(value)) return value
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}
// Mirrors the last default plan prescription for each exercise in initialPlan.ts.
// Update this table when built-in planned set counts change; storage.migrateData uses the same fallback.
const DEFAULT_PLANNED_SET_COUNTS = new Map([
  ['incline-press', 3], ['chest-press', 3], ['cable-fly', 2], ['lateral-raise', 3],
  ['triceps-pushdown', 2], ['overhead-triceps', 2], ['lat-pulldown', 3], ['chest-supported-row', 3],
  ['straight-arm-pulldown', 2], ['reverse-fly', 2], ['biceps-curl', 2], ['incline-curl', 2],
  ['machine-crunch', 2], ['leg-press', 3], ['romanian-deadlift', 3], ['leg-curl', 3],
  ['leg-extension', 2], ['calf-raise', 3], ['shoulder-press', 3],
])
const legacyWarmupSetCount = exercise => Number.isFinite(exercise?.warmupSets)
  ? Math.min(3, Math.max(0, Math.round(exercise.warmupSets)))
  : 0
export const legacyPlannedSetCount = exercise => {
  const fallback = DEFAULT_PLANNED_SET_COUNTS.get(exercise?.exerciseId) ?? 3
  const sets = Number.isFinite(exercise?.sets)
    ? Math.min(12, Math.max(1, Math.round(exercise.sets)))
    : fallback
  return sets + legacyWarmupSetCount(exercise)
}
const legacySetLogs = exercise => {
  const warmupSets = legacyWarmupSetCount(exercise)
  return Array.from({ length: legacyPlannedSetCount(exercise) }, (_, index) => ({
    setNumber: index + 1,
    phase: index < warmupSets ? 'warmup' : 'work',
    targetReps: weight(exercise.repMin),
    actualReps: weight(exercise.actualReps),
    weightKg: weight(exercise.actualWeightKg),
    completed: exercise.completed === true,
  }))
}

const sourceData = input => {
  if (!isObject(input)) throw new Error('unsupported_radian_backup')
  if (!Object.hasOwn(input, 'data')) return input
  if (input.app !== 'radian' || !isObject(input.data)) throw new Error('unsupported_radian_backup')
  return input.data
}

// shortcut: this list mirrors the current built-in catalogue; update it when built-in exercise IDs change.
const BUILTIN_EXERCISE_IDS = new Set(DEFAULT_PLANNED_SET_COUNTS.keys())

export function convertRadianBackupState(input) {
  const source = sourceData(input)
  if (!SUPPORTED_SCHEMA_VERSIONS.has(source.schemaVersion)
    || !isObject(source.profile)
    || !isObject(source.plan)
    || !Array.isArray(source.plan.days)) {
    throw new Error('unsupported_radian_backup')
  }

  const routines = list(source.plan.days).map(day => ({
    id: day.id,
    name: day.name || day.shortLabel || 'Imported routine',
    dayKey: Number.isInteger(day.weekday) && day.weekday >= 0 && day.weekday <= 6
      ? ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][day.weekday]
      : undefined,
    focus: day.focus || undefined,
    ex: list(day.exercises).map(exercise => ({
      id: exercise.exerciseId || exercise.id,
      name: exercise.name,
      sets: exercise.sets,
      reps: exercise.repMin === exercise.repMax ? String(exercise.repMin) : `${exercise.repMin}-${exercise.repMax}`,
      restSec: exercise.restSeconds,
      active: exercise.active !== false,
      warmupSets: exercise.warmupSets,
      progressionPolicy: exercise.progressionPolicy,
      progressionIncrementKg: exercise.progressionIncrementKg,
    })),
  }))

  const sessions = list(source.sessions)
  const sessionDates = sessions.map(session => isObject(session)
    ? dateOf(session.dateKey) || dateOf(session.startedAt)
    : '')
  if (sessionDates.some(date => !date)) throw new Error('unimportable_radian_session')

  const workouts = sessions.map((session, sessionIndex) => {
    const start = timestampOf(session.startedAt)
    const end = timestampOf(session.completedAt)
    return {
      id: session.id,
      d: sessionDates[sessionIndex],
      ...(start !== undefined ? { start } : {}),
      ...(end !== undefined ? { end } : {}),
      routineId: session.workoutDayId,
      name: routines.find(routine => routine.id === session.workoutDayId)?.name || 'Imported workout',
      incomplete: session.status === 'in_progress',
      entries: list(session.plannedExercises).map(exercise => ({
        id: exercise.exerciseId,
        name: exercise.name,
        plannedExerciseId: exercise.plannedExerciseId,
        completed: exercise.completed === true,
        sets: (Array.isArray(exercise.setLogs) ? exercise.setLogs : legacySetLogs(exercise)).map(set => ({
          n: set.setNumber,
          r: weight(set.actualReps) ?? weight(set.targetReps),
          w: weight(set.weightKg),
          done: set.completed === true,
          phase: set.phase === 'warmup' ? 'warmup' : 'work',
        })),
      })),
    }
  })

  const bodyweight = []
  const measurements = []
  for (const entry of list(source.progress)) {
    const date = dateOf(entry.date)
    if (!date) continue
    if (weight(entry.weightKg) !== undefined) bodyweight.push({ id: entry.id, d: date, w: entry.weightKg, unit: 'kg' })
    const values = Object.fromEntries(['waistCm', 'chestCm', 'armCm', 'hipCm']
      .filter(key => weight(entry[key]) !== undefined)
      .map(key => [key.replace('Cm', ''), entry[key]]))
    if (Object.keys(values).length) measurements.push({ id: entry.id, d: date, ...values, unit: 'cm' })
  }

  const customEx = list(source.exercises).filter(exercise => isObject(exercise)
    && typeof exercise.id === 'string' && !BUILTIN_EXERCISE_IDS.has(exercise.id)).map(exercise => ({
    id: exercise.id,
    name: exercise.name,
    muscle: exercise.muscleGroup,
    equipment: exercise.equipment,
    aliases: list(exercise.aliases),
  }))
  return {
    unit: 'kg',
    ...(['dark', 'light', 'system'].includes(source.profile.theme) ? { theme: source.profile.theme } : {}),
    routines,
    workouts,
    bodyweight,
    measurements,
    customEx,
    radianPlan: { id: source.plan.id, version: source.plan.version },
  }
}

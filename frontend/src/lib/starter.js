// The tuple-based PPL seed remains for the demo; user-facing starter plans come from the full
// catalog below and are copied into ordinary editable routines.
import { uid } from './format.js'
import { EXIDX } from './exercises.js'
import { eqAvailable, ALL_EQUIPMENT } from './equipment.js'
import { ROUTINE_CATALOG, ROUTINE_CATALOG_ERRORS } from './routine-catalog.js'
import { getLang, t } from './i18n-core.js'
export { ROUTINE_CATALOG_ERRORS as starterCatalogErrors }

const PPL = [
  ['push', 'Push Day', 'barbell', [['0025', 4, 8], ['0047', 3, 10], ['0426', 3, 10], ['0334', 3, 12], ['0241', 3, 12], ['0251', 3, 10]]],
  ['pull', 'Pull Day', 'pullup', [['2330', 4, 10], ['0027', 4, 8], ['1323', 3, 10], ['0031', 3, 10], ['0313', 3, 12]]],
  ['legs', 'Leg Day', 'legs', [['0043', 4, 8], ['0085', 3, 10], ['0739', 3, 12], ['0585', 3, 12], ['0586', 3, 12], ['0605', 4, 15]]]
]

const build = routines =>
  routines.map(([, name, emoji, list]) => ({ id: uid(), name, emoji, ex: list.map(([id, sets, reps]) => ({ id, sets, reps, weight: 0 })) }))

// Fresh routine objects (new ids) — [push, pull, legs]. The demo build seeds a history on
// top of exactly these three, so this entry point keeps its shape.
export const starterRoutines = () => build(PPL)

// Catalog metadata for the chooser; frequency comes from the sessions themselves.
export const starterPlanOptions = () =>
  ROUTINE_CATALOG.map(plan => ({ ...plan, days: plan.sessions.length }))

// The weekdays a plan would claim, or null for an unknown id.
export const starterPlanDays = id => ROUTINE_CATALOG.find(plan => plan.id === id)?.sessions.map(({ day }) => day) ?? null

// Words that name the equipment, not the movement ("barbell", "lever", "machine"…), so that
// "barbell bench press" and "dumbbell bench press" read as the same lift.
const EQ_WORDS = new Set(ALL_EQUIPMENT.flatMap(e => e.split(/[^a-z0-9]+/)).concat(['lever', 'leverage', 'machine', 'sled']))
const words = ex => new Set(ex.n.toLowerCase().split(/[^a-z0-9]+/).filter(w => w && !EQ_WORDS.has(w)))
const jaccard = (a, b) => {
  const inter = [...a].filter(x => b.has(x)).length
  return inter ? inter / (a.size + b.size - inter) : 0
}

// Names that are not working sets: stretches, holds, mobility and warm-up drills. Never a
// stand-in for a lift, whatever body part and muscle they share with it.
const NOT_A_LIFT = /stretch|isometric|squeeze|yoga|\bpose\b|toe touch|\broll(er)?\b|mobility|circles|warm-?up|boxing|against wall/i
// "… on exercise ball" is tagged with its weight (dumbbell), but needs a ball nobody ticked.
const NEEDS_BALL = /exercise ball|stability ball|swiss ball|bosu/i

// The best stand-in for `ex` among exercises the equipment list allows. Same body part, and it
// has to share the target muscle, the main muscle or a helper muscle with `ex`. Closest wins:
// same target muscle, then the movement by name, then helper muscles. When `ex` is a loaded
// lift, one that is loaded too beats a body-weight drill — a push-up is not a bench press.
// `taken` keeps a routine from ending up with the same exercise twice. null when nothing fits.
export const substituteFor = (ex, equipment, taken) => {
  const hasBall = equipment.includes('stability ball') || equipment.includes('bosu ball')
  const exWords = words(ex), exSm = new Set([ex.mg, ...(ex.sm || [])])
  const loaded = ex.eq !== 'body weight'
  let best = null, bestScore = -Infinity
  for (const c of Object.values(EXIDX)) {
    if (c.bp !== ex.bp || taken.has(c.id) || !eqAvailable(equipment, c)) continue
    if (NOT_A_LIFT.test(c.n) || (!hasBall && NEEDS_BALL.test(c.n))) continue
    const sm = jaccard(exSm, new Set([c.mg, ...(c.sm || [])]))
    if (c.tg !== ex.tg && c.mg !== ex.mg && !sm) continue
    const score = 2 * (c.tg === ex.tg) + (c.mg === ex.mg) + 3 * jaccard(exWords, words(c)) + 2 * sm
      - (loaded && c.eq === 'body weight' ? 3 : 0)
    // id as the last key: the same equipment always gives the same plan
    if (score > bestScore || (score === bestScore && c.id < best.id)) { best = c; bestScore = score }
  }
  return best
}

// Fits sessions to the selected equipment while preserving each exercise's full prescription.
const fitSessions = (sessions, equipment) => {
  let swapped = 0, dropped = 0
  const changes = []
  const droppedSessions = []
  const fitted = sessions.map(session => {
    const taken = new Set(session.exercises.map(({ id }) => id))
    const out = []
    for (const exercise of session.exercises) {
      const ex = EXIDX[exercise.id]
      if (eqAvailable(equipment, ex)) { out.push({ ...exercise }); continue }
      const sub = substituteFor(ex, equipment, taken)
      if (!sub) {
        dropped++
        changes.push({ type: 'removed', day: session.day, sessionName: session.name, sessionNameEs: session.nameEs, sessionNameKey: session.nameKey, exerciseId: exercise.id })
        continue
      }
      taken.add(sub.id)
      swapped++
      changes.push({ type: 'substituted', day: session.day, sessionName: session.name, sessionNameEs: session.nameEs, sessionNameKey: session.nameKey, exerciseId: exercise.id, substituteId: sub.id })
      out.push({ ...exercise, id: sub.id })
    }
    if (!out.length) {
      droppedSessions.push({ day: session.day, sessionName: session.name, sessionNameEs: session.nameEs, sessionNameKey: session.nameKey })
      return null
    }
    return { ...session, exercises: out }
  }).filter(Boolean)
  return { sessions: fitted, swapped, dropped, changes, droppedSessions }
}

// Builds ordinary editable routines from a catalog template. Invalid bundled data keeps imports off.
export const buildStarterPlan = (id, equipment) => {
  const template = ROUTINE_CATALOG.find(plan => plan.id === id)
  if (!template) return null
  if (ROUTINE_CATALOG_ERRORS.length || template.sessions.some(session => session.exercises.some(exercise => !EXIDX[exercise.id]))) {
    return { template, invalid: true, effectiveSessions: 0, sessions: [], routines: [], schedule: [] }
  }
  const fit = equipment ? fitSessions(template.sessions, equipment) : null
  const sessions = fit ? fit.sessions : template.sessions
  const routines = sessions.map(session => ({
    id: uid(),
    name: session.nameKey ? t(session.nameKey) : getLang().toLowerCase().startsWith('es') ? session.nameEs || session.name : session.name,
    emoji: session.emoji,
    ex: session.exercises.map(exercise => ({ ...exercise, ...(exercise.note ? { note: t(exercise.note) } : {}), weight: 0 }))
  }))
  return {
    template,
    sessions,
    effectiveSessions: sessions.length,
    routines,
    schedule: sessions.map((session, index) => ({ day: session.day, routineId: routines[index].id })),
    ...(fit && { fit: { requestedSessions: template.sessions.length, effectiveSessions: sessions.length, swapped: fit.swapped, dropped: fit.dropped, changes: fit.changes, droppedSessions: fit.droppedSessions } })
  }
}

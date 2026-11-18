/* How much of this device's copy the server has not seen yet.
 *
 * Signing out and disconnecting refuse to wipe a copy that still owes the server something, and
 * say how much ("3 changes are not on your server"). The store keeps a small fingerprint of the
 * last copy this device and the server agreed on — one hash per workout, weigh-in, routine and
 * custom exercise, one for everything else (settings, the week plan, working weights, notes) —
 * and counts what differs from it. It is a count of things touched, not a diff: two edits to the
 * same workout are one change, and a changed setting and a changed plan are one change together.
 */

const list = v => (Array.isArray(v) ? v : [])
const ARRAYS = ['workouts', 'bodyweight', 'routines', 'customEx', 'measurements', 'favEx', 'equipProfiles', 'gymCards']
const MAPS = ['exNotes', 'exWeights']
const LOCAL = new Set(['_rev', '_wid', '_wids', 'active'])
export const MAX_SYNC_BATCH_BYTES = 256_000
export const MAX_SYNC_BATCH_CHANGES = 100
export const MAX_SYNC_CHANGE_BYTES = 65_536 + 1_024

// FNV-1a over the JSON text: cheap, stable across runs, and plenty to tell an entry that is the
// same from one that was edited.
function hash(v) {
  const s = JSON.stringify(v) ?? ''
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(36)
}

const workoutKey = w => (typeof w?.id === 'string' && w.id ? w.id : `${w?.d}|${w?.start}`)
const entityKey = (field, value) => {
  if (field === 'workouts') return workoutKey(value)
  if (field === 'bodyweight') return `${value?.d ?? ''}|${value?.t ?? ''}`
  if (field === 'measurements') return value?.id || `${value?.d ?? ''}|${value?.t ?? ''}`
  if (field === 'favEx') return typeof value === 'string' ? value : null
  return typeof value?.id === 'string' && value.id ? value.id : null
}
// The lists counted entry by entry, keyed the way lib/sync-merge.js unions them.
const LISTS = {
  w: ['workouts', workoutKey],
  b: ['bodyweight', e => e?.d],
  r: ['routines', r => r?.id],
  c: ['customEx', e => e?.id],
}
// Not content: the stamps and the revision say when, not what (`deleted` and `edited` go with a
// change the lists or the rest already count); the running workout never syncs.
const NOT_CONTENT = new Set(['_ts', '_rev', 'active', 'deleted', 'edited', ...Object.values(LISTS).map(([f]) => f)])

/** A fingerprint of `S`: per-entry hashes of the counted lists, one hash (`s`) for the rest. */
export function syncFingerprint(S) {
  const fp = {}
  for (const [k, [field, key]] of Object.entries(LISTS)) {
    fp[k] = {}
    for (const x of list(S?.[field])) {
      const id = key(x)
      if (id != null) fp[k][id] = hash(x)
    }
  }
  const rest = {}
  for (const f of Object.keys(S || {}).sort()) if (!NOT_CONTENT.has(f)) rest[f] = S[f]
  fp.s = hash(rest)
  fp.version = 2
  fp.fields = {}
  for (const f of Object.keys(S || {}).sort()) {
    if (LOCAL.has(f) || ARRAYS.includes(f) || MAPS.includes(f)) continue
    fp.fields[f] = hash(S[f])
  }
  fp.entities = {}
  fp.presence = {}
  for (const field of ARRAYS) {
    fp.entities[field] = {}
    fp.presence[field] = Object.hasOwn(S || {}, field)
    for (const [index, value] of list(S?.[field]).entries()) {
      const id = entityKey(field, value)
      if (id != null) fp.entities[field][id] = hash({ value, position: index })
    }
  }
  fp.maps = {}
  for (const field of MAPS) {
    fp.maps[field] = {}
    fp.presence[field] = Object.hasOwn(S || {}, field)
    const entries = S?.[field] && typeof S[field] === 'object' && !Array.isArray(S[field]) ? S[field] : {}
    for (const [key, value] of Object.entries(entries)) fp.maps[field][key] = hash(value)
  }
  return fp
}

/** Bounded-protocol operations between this copy and its last confirmed v2 fingerprint. */
export function syncChanges(S, fingerprint) {
  const before = fingerprint?.version === 2 ? fingerprint : fingerprint == null ? syncFingerprint({}) : null
  if (!before) return null
  const now = syncFingerprint(S || {})
  const changes = []
  for (const key of new Set([...Object.keys(before.fields || {}), ...Object.keys(now.fields)])) {
    if (before.fields?.[key] === now.fields[key]) continue
    changes.push(Object.hasOwn(now.fields, key)
      ? { kind: 'field', key, value: S[key] }
      : { kind: 'field', key, deleted: true })
  }
  for (const field of ARRAYS) {
    const present = !!now.presence[field]
    if (before.presence?.[field] !== present && present) changes.push({ kind: 'collection', key: field, present: true })
    const oldRows = before.entities?.[field] || {}
    const nextRows = now.entities[field]
    for (const [index, value] of list(S?.[field]).entries()) {
      const id = entityKey(field, value)
      if (id != null && oldRows[id] !== nextRows[id]) changes.push({ kind: 'entity', collection: field, id, position: index, value })
    }
    for (const id of Object.keys(oldRows)) if (!Object.hasOwn(nextRows, id)) changes.push({ kind: 'entity', collection: field, id, deleted: true })
    if (before.presence?.[field] !== present && !present) changes.push({ kind: 'collection', key: field, present: false })
  }
  for (const field of MAPS) {
    const present = !!now.presence[field]
    if (before.presence?.[field] !== present && present) changes.push({ kind: 'collection', key: field, present: true })
    const oldRows = before.maps?.[field] || {}
    const nextRows = now.maps[field]
    const entries = S?.[field] && typeof S[field] === 'object' && !Array.isArray(S[field]) ? S[field] : {}
    for (const [key, value] of Object.entries(entries)) if (oldRows[key] !== nextRows[key]) changes.push({ kind: 'map', map: field, key, value })
    for (const key of Object.keys(oldRows)) if (!Object.hasOwn(nextRows, key)) changes.push({ kind: 'map', map: field, key, deleted: true })
    if (before.presence?.[field] !== present && !present) changes.push({ kind: 'collection', key: field, present: false })
  }
  return changes
}

export function applySyncChanges(state, changes) {
  const next = { ...(state || {}) }
  for (const change of changes || []) {
    if (change.kind === 'field') {
      if (change.deleted) delete next[change.key]
      else next[change.key] = change.value
    } else if (change.kind === 'collection') {
      if (!change.present) delete next[change.key]
      else if (!Object.hasOwn(next, change.key)) next[change.key] = ARRAYS.includes(change.key) ? [] : {}
    } else if (change.kind === 'map') {
      const value = next[change.map] && typeof next[change.map] === 'object' && !Array.isArray(next[change.map]) ? { ...next[change.map] } : {}
      if (change.deleted) delete value[change.key]
      else value[change.key] = change.value
      next[change.map] = value
    } else if (change.kind === 'entity') {
      const value = list(next[change.collection]).slice()
      const index = value.findIndex(item => entityKey(change.collection, item) === change.id)
      if (change.deleted) {
        if (index >= 0) value.splice(index, 1)
      } else {
        if (index >= 0) value.splice(index, 1)
        value.splice(Math.min(change.position, value.length), 0, change.value)
      }
      next[change.collection] = value
    }
  }
  return next
}

/**
 * How many entries of `S` were added, edited or removed since the copy `fp` was taken of, plus
 * one when anything else changed. null when there is no fingerprint to compare with — the device
 * last agreed with the server before it kept one, so it cannot say how much is waiting.
 */
export function countChanges(S, fp) {
  if (!fp || typeof fp !== 'object') return null
  const now = syncFingerprint(S)
  let n = now.s !== fp.s ? 1 : 0
  for (const k of Object.keys(LISTS)) {
    const a = now[k] || {}
    const b = fp[k] || {}
    for (const id of Object.keys(a)) if (a[id] !== b[id]) n++
    for (const id of Object.keys(b)) if (!(id in a)) n++
  }
  return n
}

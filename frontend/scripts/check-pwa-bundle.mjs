#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXDB } from '../src/lib/exercises-data.js'
import { ROUTINE_CATALOG } from '../src/lib/routine-catalog.js'

const MINIMUM_GUIDE_MAPPINGS = 85
const readJson = (path, label, problems) => {
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { problems.push(`${label}: missing or invalid JSON`); return null }
}

const checkWorkoutGuide = (root, problems) => {
  const guideRoot = join(root, 'exercise-media/workout-guide')
  const sourceMap = readJson(fileURLToPath(new URL('../src/lib/workout-guide-map.json', import.meta.url)), 'Workout Guide source map', problems)
  const mappings = readJson(join(guideRoot, 'mappings.json'), 'Workout Guide mappings', problems)
  const manifest = readJson(join(guideRoot, 'manifest.json'), 'Workout Guide manifest', problems)
  if (!sourceMap || !mappings || !manifest) return

  const catalogueIds = new Set(EXDB.map(exercise => exercise.id))
  const sourceEntries = Object.entries(sourceMap)
  const slugs = new Set()
  if (sourceEntries.length < MINIMUM_GUIDE_MAPPINGS) problems.push(`Workout Guide source map: expected at least ${MINIMUM_GUIDE_MAPPINGS} exercises, found ${sourceEntries.length}`)
  for (const [exerciseId, slug] of sourceEntries) {
    if (!catalogueIds.has(exerciseId)) problems.push(`Workout Guide source map: unknown exercise ID ${exerciseId}`)
    if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) problems.push(`Workout Guide source map: invalid slug for ${exerciseId}`)
    else slugs.add(slug)
  }

  const mappedPairs = new Set(sourceEntries.map(([exerciseId, slug]) => `${exerciseId}\0${slug}`))
  if (!Array.isArray(mappings) || mappings.length !== sourceEntries.length) {
    problems.push(`Workout Guide mappings: expected ${sourceEntries.length} entries`)
  } else {
    const publicIds = new Set()
    for (const entry of mappings) {
      const pair = `${entry?.exerciseId}\0${entry?.slug}`
      if (!mappedPairs.has(pair)) problems.push(`Workout Guide mappings: unexpected exercise/slug ${entry?.exerciseId}/${entry?.slug}`)
      if (publicIds.has(entry?.exerciseId)) problems.push(`Workout Guide mappings: duplicate exercise ID ${entry?.exerciseId}`)
      publicIds.add(entry?.exerciseId)
    }
    if (publicIds.size !== sourceEntries.length) problems.push('Workout Guide mappings: source map and distributed mappings differ')
  }

  const routineIds = new Set(ROUTINE_CATALOG.flatMap(program => program.sessions.flatMap(session => session.exercises.map(exercise => exercise.id))))
  for (const exerciseId of routineIds) {
    if (!sourceMap[exerciseId]) problems.push(`Workout Guide source map: routine exercise ${exerciseId} has no illustration`)
  }

  if (!Array.isArray(manifest) || manifest.length !== slugs.size) {
    problems.push(`Workout Guide manifest: expected ${slugs.size} unique illustrations`)
  } else {
    const manifestSlugs = new Set()
    for (const entry of manifest) {
      const { slug, appExercise, frames } = entry ?? {}
      if (!mappedPairs.has(`${appExercise?.id}\0${slug}`)) problems.push(`Workout Guide manifest: representative exercise is not mapped ${appExercise?.id}/${slug}`)
      if (!slugs.has(slug)) problems.push(`Workout Guide manifest: unused illustration ${slug}`)
      if (manifestSlugs.has(slug)) problems.push(`Workout Guide manifest: duplicate slug ${slug}`)
      manifestSlugs.add(slug)
      if (!Array.isArray(frames) || frames.length !== 3) {
        problems.push(`Workout Guide manifest: ${slug} must have three frames`)
        continue
      }
      for (let index = 1; index <= 3; index++) {
        const frame = frames[index - 1]
        const expectedPath = `${slug}/frame-${index}.png`
        if (frame?.index !== index || frame?.path !== expectedPath) problems.push(`Workout Guide manifest: invalid frame ${index} for ${slug}`)
        else if (!readFileExists(join(guideRoot, expectedPath))) problems.push(`Workout Guide frame missing: ${expectedPath}`)
      }
    }
  }

  let pngCount = 0
  try { pngCount = readdirSync(guideRoot, { recursive: true }).filter(path => String(path).endsWith('.png')).length }
  catch { problems.push('Workout Guide media: directory unavailable') }
  if (pngCount !== manifest.length * 3) problems.push(`Workout Guide media: expected ${manifest.length * 3} PNG frames, found ${pngCount}`)
  for (const notice of ['ATTRIBUTION.md', 'CREDITS.md', 'LICENSE-ASSETS', 'LICENSES.md']) {
    if (!readFileExists(join(guideRoot, notice))) problems.push(`Workout Guide notice missing: ${notice}`)
  }
}

const readFileExists = path => {
  return existsSync(path)
}

export function checkPwaBundle(root) {
  const assets = join(root, 'assets')
  let files
  try { files = readdirSync(assets) } catch { return [`${assets}: no build assets`] }
  const problems = []
  for (const file of files) {
    if (/^coach-local-.*\.js$/.test(file)) problems.push(`${file}: native Coach code is included`)
    if (!file.endsWith('.js')) continue
    const source = readFileSync(join(assets, file), 'utf8')
    if (/@capacitor(?:\/|-)|CapacitorHttp|capacitor:\/\/localhost/i.test(source)) problems.push(`${file}: native dependency reference found`)
  }
  checkWorkoutGuide(root, problems)
  return problems
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = checkPwaBundle(resolve(process.argv[2] || join(fileURLToPath(new URL('../dist/', import.meta.url)))))
  if (problems.length) {
    for (const problem of problems) console.error('✗ ' + problem)
    process.exit(1)
  }
  console.log('PWA bundle has no native modules; Workout Guide mappings cover the routine catalogue and all local frames/notices are present.')
}

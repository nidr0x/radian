import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { convertRadianBackupState, legacyPlannedSetCount } from '../src/lib/radian-conversion.js'

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const digest = value => createHash('sha256').update(value).digest('hex')
const canonical = value => Array.isArray(value)
  ? `[${value.map(item => item === undefined ? 'null' : canonical(item)).join(',')}]`
  : isObject(value)
    ? `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
    : JSON.stringify(value)
const list = value => Array.isArray(value) ? value : []
const sumChildren = (rows, getChildren) => list(rows).reduce((total, row) =>
  total + (isObject(row) && Array.isArray(getChildren(row)) ? getChildren(row).length : 0), 0)
const buildReconciliation = (input, state) => {
  const source = isObject(input.data) ? input.data : input
  const sourceSessions = list(source.sessions)
  const convertedSessions = list(state.workouts)
  const progress = list(source.progress)
  const measurementKeys = ['waistCm', 'chestCm', 'armCm', 'hipCm']

  return {
    account: { source: 1, converted: 1 },
    routines: { source: list(source.plan.days).length, converted: list(state.routines).length },
    routineExercises: {
      source: sumChildren(source.plan.days, day => day.exercises),
      converted: sumChildren(state.routines, routine => routine.ex),
    },
    sessions: { source: sourceSessions.length, converted: convertedSessions.length },
    sessionExercises: {
      source: sumChildren(sourceSessions, session => session.plannedExercises),
      converted: sumChildren(convertedSessions, session => session.entries),
    },
    sessionSets: {
      source: sourceSessions.reduce((total, session) => total + list(session?.plannedExercises).reduce((sum, exercise) =>
        sum + (Array.isArray(exercise?.setLogs) ? exercise.setLogs.length : legacyPlannedSetCount(exercise)), 0), 0),
      converted: convertedSessions.reduce((total, session) => total + sumChildren(session?.entries, exercise => exercise.sets), 0),
    },
    bodyweight: {
      source: progress.filter(entry => isObject(entry) && Number.isFinite(entry.weightKg)).length,
      converted: list(state.bodyweight).length,
    },
    measurements: {
      source: progress.filter(entry => isObject(entry)
        && measurementKeys.some(key => Number.isFinite(entry[key]))).length,
      converted: list(state.measurements).length,
    },
    customExercises: {
      source: list(source.exercises).filter(exercise => isObject(exercise) && typeof exercise.id === 'string').length,
      converted: list(state.customEx).length,
    },
    notExportedOrImported: ['passkeys', 'OAuth/consentimientos', 'pairing', 'medios R2'],
  }
}

export function convertRadianBackup(input, accountId) {
  if (typeof accountId !== 'string' || !/^[A-Za-z\d_-]{8,128}$/.test(accountId)) {
    throw new Error('invalid_migration_input')
  }
  if (!isObject(input) || input.app !== 'radian' || !isObject(input.data)) {
    throw new Error('unsupported_radian_backup')
  }
  const state = convertRadianBackupState(input)
  const sourceHash = digest(canonical(input));
  const reconciliation = buildReconciliation(input, state)
  return {
    format: 'radian-to-opengym/v1',
    accountId,
    migrationId: digest(`${accountId}\0${sourceHash}`),
    sourceChecksum: sourceHash,
    stateChecksum: digest(canonical(state)),
    reconciliation,
    state,
  };
}

const arg = (args, key) => {
  const index = args.indexOf(key)
  return index >= 0 ? args[index + 1] : null
}

export function migrateFiles({ inputPath, outputPath, rollbackPath, accountId }) {
  const inputFile = resolve(inputPath)
  const outputFile = resolve(outputPath)
  const rollbackFile = resolve(rollbackPath)
  if (outputFile === inputFile || rollbackFile === inputFile || outputFile === rollbackFile) throw new Error('migration_paths_must_be_distinct')
  if (existsSync(outputFile) || existsSync(rollbackFile)) throw new Error('migration_output_exists')
  const sourceBytes = readFileSync(inputFile)
  if (sourceBytes.byteLength > 16 * 1024 * 1024) throw new Error('radian_backup_too_large')
  let sourceText
  try { sourceText = new TextDecoder('utf-8', { fatal: true }).decode(sourceBytes) }
  catch { throw new Error('invalid_radian_backup_encoding') }
  const converted = convertRadianBackup(JSON.parse(sourceText), accountId)
  const outputText = `${JSON.stringify({ ...converted, rollback: { file: basename(rollbackFile), checksum: digest(sourceBytes) } }, null, 2)}\n`
  const createdFiles = []
  const writeExclusive = (path, content) => {
    const fd = openSync(path, 'wx')
    createdFiles.push(path)
    let failure
    try { writeFileSync(fd, content) } catch (error) { failure = error }
    try { closeSync(fd) } catch (error) { failure ??= error }
    if (failure) throw failure
  }
  try {
    writeExclusive(rollbackFile, sourceBytes)
    writeExclusive(outputFile, outputText)
  } catch (error) {
    for (const path of createdFiles.reverse()) {
      try { unlinkSync(path) } catch { /* preserve the original write error */ }
    }
    throw error;
  }
  return {
    outputFile,
    rollbackFile,
    migrationId: converted.migrationId,
    sourceChecksum: converted.sourceChecksum,
    stateChecksum: converted.stateChecksum,
    reconciliation: converted.reconciliation,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const inputPath = arg(process.argv, '--input')
  const outputPath = arg(process.argv, '--output')
  const rollbackPath = arg(process.argv, '--rollback')
  const accountId = arg(process.argv, '--account-id')
  if (!inputPath || !outputPath || !rollbackPath || !accountId) {
    process.stderr.write('Usage: node scripts/migrate-radian-to-opengym.mjs --input backup.json --account-id ID --output opengym.json --rollback radian-rollback.json\n')
    process.exitCode = 2
  } else {
    try { process.stdout.write(`${JSON.stringify(migrateFiles({ inputPath, outputPath, rollbackPath, accountId }))}\n`) }
    catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'migration_failed'}\n`); process.exitCode = 1 }
  }
}

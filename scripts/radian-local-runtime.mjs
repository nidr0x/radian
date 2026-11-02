#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const wrangler = join(root, 'node_modules', '.bin', 'wrangler')
const pagesPort = port('RADIAN_LOCAL_PAGES_PORT', 8787)
const jobsPort = port('RADIAN_LOCAL_JOBS_PORT', 8788)
if (pagesPort === jobsPort) throw new Error('Pages and Jobs must use different ports')
for (const path of ['frontend/dist/index.html', 'frontend/dist/sw.js']) {
  try { await readFile(join(root, path)) } catch { throw new Error('Build the PWA first: npm --prefix frontend run build') }
}

const runtime = await mkdtemp(join(tmpdir(), 'radian-local-validation-'))
const persist = join(runtime, 'persist')
const pagesDir = join(runtime, 'pages')
const jobsDir = join(runtime, 'jobs')
const children = []
const env = { ...process.env, CI: '1', NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' }
for (const key of Object.keys(env)) {
  if (/^(?:CLOUDFLARE|CF)_(?:API_TOKEN|API_KEY|ACCOUNT_ID|GLOBAL_API_KEY)$/.test(key)) delete env[key]
}

function port(name, fallback) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`${name} must be a TCP port`)
  return value
}

async function config(source, directory, name, links) {
  await mkdir(directory, { recursive: true })
  for (const [target, path] of Object.entries(links)) await symlink(join(root, path), join(directory, target), 'dir')
  const data = JSON.parse(await readFile(join(root, source), 'utf8'))
  delete data.$schema
  data.name = name
  if (data.pages_build_output_dir) data.pages_build_output_dir = './dist'
  if (data.main) data.main = './workers/radian-jobs.ts'
  for (const database of data.d1_databases ?? []) delete database.preview_database_id
  data.vars = { ...data.vars, COACH_DISABLED: '1' }
  await writeFile(join(directory, 'wrangler.jsonc'), `${JSON.stringify(data, null, 2)}\n`)
}

function run(args, cwd) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(wrangler, ['--cwd', cwd, ...args], { env, stdio: ['ignore', 'inherit', 'inherit'] })
    child.once('error', rejectRun)
    child.once('exit', code => code === 0 ? resolveRun() : rejectRun(new Error(`Wrangler exited with code ${code}`)))
  })
}

function start(args, cwd) {
  const child = spawn(wrangler, ['--cwd', cwd, ...args], { env, stdio: 'inherit' })
  children.push(child)
  return child
}

function waitExit(child) {
  return child.exitCode !== null ? Promise.resolve() : once(child, 'exit')
}

async function waitForPages(child) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error('Pages stopped before its health check passed')
    try {
      const response = await fetch(`http://127.0.0.1:${pagesPort}/api/health`, { signal: AbortSignal.timeout(1000) })
      if (response.ok && (await response.json()).ok === true) return
    } catch { /* retry until Pages is ready */ }
    await new Promise(resolveDelay => setTimeout(resolveDelay, 500))
  }
  throw new Error(`Pages did not become healthy on port ${pagesPort}`)
}

let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

try {
  await mkdir(persist)
  await config('wrangler.radian.local.jsonc', pagesDir, 'radian-pages-local-validation', {
    dist: 'frontend/dist', functions: 'functions', migrations: 'migrations',
  })
  await config('wrangler.radian.jobs.local.jsonc', jobsDir, 'radian-jobs-local-validation', {
    functions: 'functions', migrations: 'migrations', workers: 'workers',
  })
  const database = JSON.parse(await readFile(join(pagesDir, 'wrangler.jsonc'), 'utf8')).d1_databases[0].database_name
  await run(['d1', 'migrations', 'apply', database, '--local', '--persist-to', persist], pagesDir)

  const pages = start(['pages', 'dev', '--ip', '127.0.0.1', '--port', String(pagesPort), '--persist-to', persist], pagesDir)
  const jobs = start(['dev', '--ip', '127.0.0.1', '--port', String(jobsPort), '--persist-to', persist, '--test-scheduled'], jobsDir)
  await waitForPages(pages)
  if (jobs.exitCode !== null) throw new Error('Jobs stopped during startup')
  process.stdout.write(`Pages: http://127.0.0.1:${pagesPort}/\nJobs scheduled test: http://127.0.0.1:${jobsPort}/__scheduled\n`)
  process.stdout.write('Todo usa persistencia local temporal; pulsa Ctrl+C para detener ambos servicios y descartarla.\n')
  await Promise.race([waitExit(pages), waitExit(jobs)])
} catch (error) {
  process.stderr.write(`${error?.message || error}\n`)
  process.exitCode = 1
} finally {
  stop()
  await Promise.all(children.map(waitExit))
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  await rm(runtime, { recursive: true, force: true })
}

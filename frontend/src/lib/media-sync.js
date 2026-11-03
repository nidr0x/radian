/* Photos and videos of custom exercises and of logged workouts between this device and its server.
 *
 * ONE mechanism for every move between modes, keyed by content hash and safe to repeat: ask the
 * server which of the state's files it lacks (POST /api/media/missing), then send the ones this
 * device holds (PUT /api/media/{hash}). That covers, without a special case each:
 *  - a guest signing up or in (adoptProfile keeps the guest's exercises, their refs point at
 *    files in this browser's store, and they go up),
 *  - a phone in local mode being paired (the same, from the phone's folder),
 *  - a stash handed back after a forced sign-out (applyStash, then its files go up),
 *  - a backup imported from a zip (its files come in as pending),
 *  - the server having dropped a file after its grace period (any device that still has it
 *    sends it again),
 *  - a server without media: nothing is sent, the files stay here and pending, and Settings
 *    says they are waiting.
 * Downloads go the other way (fetchToStore): each is checked against its hash and its type before
 * it is kept, so a login page or a proxy's answer is never stored under a file's name.
 *
 * It also keeps the local store tidy (localMediaGc) and makes the plan's custom media local ahead
 * of time (startCustomMediaPrefetch), so a workout opened without a network still shows them.
 */
import { referencedHashes, referencedFiles, MEDIA_MIMES } from './media-refs.js'
import { sniffKind } from './media-sniff.js'
import { sha256Hex } from './sha256.js'
import { mediaStore as sharedStore } from './media-store.js'
import { api, apiBlob, apiUpload } from './api.js'
import { prefetchAllowed } from './media-prefetch.js'
import { MB, BG_UPLOAD_METERED_MAX_MB, LOCAL_CACHE_MAX_MB, LOCAL_GC_GRACE_MS, limitsFrom, fmtMB } from './media-limits.js'
import { MOBILE, nativeLoad } from './mobile.js'
import { registerMediaRunner, publishMediaStatus, pendingRefCount, loadPending } from './media-owed.js'
import { t } from './i18n-core.js'

const MIN = 60000
const DEDUPE_MS = 10 * MIN
const SETTLE_BUDGET_MS = 60000
const MISSING_CHUNK = 100
const UPLOAD_BACKOFF = [1, 2, 5, 15, 60].map(m => m * MIN)
const MISSING_BACKOFF = [30000, 2 * MIN, 10 * MIN, 30 * MIN]
// How many of the latest workouts with photos or videos get their posters made local ahead of
// time: the history's first screens, a few KB each.
const RECENT_WORKOUT_POSTERS = 20
// Refusals that will not change by trying again: the file stays here, pending, and is not
// offered again until someone asks (the Settings row).
const REJECTED = new Set(['media-too-large', 'media-type', 'media-invalid', 'media-too-long', 'proxy-too-large', 'hash-mismatch'])
const PERSISTED_KEY = 'gym_state_v1'

const sleep = ms => new Promise(r => setTimeout(r, ms))
const isNetwork = e => !e || e.status == null || e.code === 'timeout' || e.code === 'network'
const ownerHash = (owner, hash) => JSON.stringify([owner, hash])

/**
 * One sync. `deps` are what it talks to — the app store (getState/subscribe), the local media
 * store, the transports — all injectable, which is how media-sync.test.js runs it.
 */
export function createMediaSync(deps = {}) {
  const d = {
    media: sharedStore,
    // Reached through arrows, so a test that mocks lib/api.js without these never trips over
    // them before a sync actually runs.
    api: (...a) => api(...a),
    apiBlob: (...a) => apiBlob(...a),
    apiUpload: (...a) => apiUpload(...a),
    sha256: sha256Hex,
    allowed: () => prefetchAllowed(),
    now: () => Date.now(),
    toast: msg => import('../store/useUI.js').then(({ useUI }) => useUI.getState().toast(msg)).catch(() => {}),
    locks: globalThis.navigator?.locks,
    storage: (() => { try { return globalThis.localStorage } catch { return null } })(),
    // The phone's file mirror of the state (lib/mobile.js), read by the local clean-up: on a
    // phone it is the durable copy and can be newer than localStorage (evicted WebView storage,
    // a write refused for room), so what it refers to is kept even if memory does not know it yet.
    nativeLoad: MOBILE ? () => nativeLoad() : null,
    ...deps
  }
  let store = d.store || null
  let running = null
  let runningEpoch = null
  let again = null
  let sessionEpoch = 0
  let sessionKey = null
  let sessionController = null
  let lastRun = { refs: '', at: 0, complete: false }
  let retryNotBefore = 0
  let gcWaiting = false   // a clean-up asked for before boot finished, run once it has
  let quotaTold = false
  const rejectTold = new Set()
  const upBackoff = new Map()     // owner+hash → { step, until }
  const missBackoff = new Map()   // owner+hash → { step, until }
  const fetching = new Map()      // owner+hash → the download in flight

  const sessionFor = (st = store?.getState()) => {
    let savedOwner = null
    try { savedOwner = d.storage?.getItem('gym_owner') || null } catch { /* use the store's owner */ }
    const owner = typeof d.media.owner === 'string' ? d.media.owner : savedOwner || st?.user?.id || 'guest'
    const uid = st?.user?.id || null
    const key = JSON.stringify([owner, uid])
    if (key !== sessionKey) {
      sessionController?.abort()
      sessionEpoch++
      sessionController = typeof AbortController === 'function' ? new AbortController() : null
      sessionKey = key
      again = null
      lastRun = { refs: '', at: 0, complete: false }
      retryNotBefore = 0
      quotaTold = false
      rejectTold.clear()
      upBackoff.clear()
      missBackoff.clear()
      fetching.clear()
    }
    return { owner, uid, epoch: sessionEpoch, signal: sessionController?.signal }
  }
  const isCurrent = session => {
    const current = sessionFor()
    return !!session && current.epoch === session.epoch && current.owner === session.owner && current.uid === session.uid && !session.signal?.aborted
  }
  const bump = (map, owner, hash, steps) => {
    const key = ownerHash(owner, hash)
    const cur = map.get(key)
    const step = cur ? Math.min(cur.step + 1, steps.length - 1) : 0
    map.set(key, { step, until: d.now() + steps[step] })
  }
  const active = (map, owner, hash) => (map.get(ownerHash(owner, hash))?.until || 0) > d.now()
  const withLock = (name, fn) => (d.locks && typeof d.locks.request === 'function' ? d.locks.request(name, fn) : fn())

  const publishPending = async (session, extra) => {
    if (!isCurrent(session)) return
    const S = store?.getState().S
    publishMediaStatus({ pending: S ? pendingRefCount(S) : 0, ...extra })
  }

  async function run({ force = false, retryRejected = false } = {}, session) {
    if (!store) return
    const st = store.getState()
    if (!isCurrent(session)) return
    if (!st.user) { await publishPending(session, { usage: null }); return }
    if (st.sync?.held || session.owner !== st.user.id) {
      publishMediaStatus({ usage: null, pending: 0, deferred: 0, rejected: 0, unavailable: 0 })
      return
    }
    await d.media.ready?.(session.owner)
    if (!isCurrent(session)) return
    // A boot without a network leaves the config unknown; ask again rather than decide on nothing.
    let cfg = st.config
    if (!cfg && typeof st.loadConfig === 'function') cfg = await st.loadConfig()
    if (!isCurrent(session)) return
    if (!cfg?.media) { await publishPending(session, { usage: null }); return }
    const files = referencedFiles(st.S)
    const refs = files.map(f => f.hash)
    // Nothing referenced (a reset, everything deleted) forgets the last run: the same files coming
    // back from a backup within ten minutes are new to the server again, not a repeat of that run.
    if (!refs.length) { lastRun = { refs: '', at: 0, complete: false }; await publishPending(session, { deferred: 0, rejected: 0, unavailable: 0 }); return }
    const key = refs.join(',')
    if (!force && lastRun.complete && lastRun.refs === key && d.now() - lastRun.at < DEDUPE_MS) return
    if (!force && d.now() < retryNotBefore) return
    if (retryRejected) { missBackoff.clear(); rejectTold.clear() }

    let missing = []
    let usage = null
    try {
      for (let i = 0; i < refs.length; i += MISSING_CHUNK) {
        if (!isCurrent(session)) return
        const r = await d.api('/api/media/missing', { method: 'POST', body: JSON.stringify({ hashes: refs.slice(i, i + MISSING_CHUNK) }), signal: session.signal })
        if (!isCurrent(session)) return
        if (Array.isArray(r?.missing)) missing.push(...r.missing)
        if (r?.usage) usage = r.usage
      }
    } catch (e) {
      if (!isCurrent(session)) return
      lastRun = { refs: key, at: d.now(), complete: false }
      if (e?.status === 429) retryNotBefore = d.now() + (Number(e.data?.retryAfter) || 60) * 1000
      return
    }
    const missingSet = new Set(missing)
    for (const h of refs) {
      if (missingSet.has(h)) continue
      missBackoff.delete(ownerHash(session.owner, h))   // the server has it: a device showing it as missing may ask again
      upBackoff.delete(ownerHash(session.owner, h))
      await d.media.markSynced(h, session.owner)
      if (!isCurrent(session)) return
    }
    let deferred = 0, unavailable = 0, rejected = 0, skipped = 0, stopped = false
    let added = 0
    const lim = limitsFrom(cfg)
    const capOf = mime => {
      const kind = MEDIA_MIMES[mime]?.kind
      return Math.round((kind === 'video' ? lim.videoMB : kind === 'gif' ? lim.gifMB : lim.imageMB) * MB)
    }
    const refuse = async h => {
      await d.media.markRejected(h, session.owner)
      if (!isCurrent(session)) return
      rejected++
      if (!rejectTold.has(h)) { rejectTold.add(h); d.toast(t('The server refused the file as too large.')) }
    }
    for (const h of missing) {
      if (!isCurrent(session)) return
      const rec = await d.media.get(h, session.owner)
      if (!isCurrent(session)) return
      if (!rec) { unavailable++; continue }   // nobody here has it: shown as missing until someone sends it
      if (rec.rejected && !retryRejected) { rejected++; continue }
      // Over this server's cap for its kind (a phone picked it under the defaults, or the caps
      // came down since): refused here, as the server would. Sent, a body more than twice the cap
      // can end in a reset rather than the 413, which reads as no network — backed off and
      // tried again for ever, and a forced run would stop at it every time.
      if (rec.size > capOf(rec.mime)) { await refuse(h); continue }
      if (!force && rec.size > BG_UPLOAD_METERED_MAX_MB * MB && !d.allowed()) { deferred++; continue }   // big files wait for Wi-Fi
      if (!force && active(upBackoff, session.owner, h)) { skipped++; continue }
      try {
        const res = await d.apiUpload('/api/media/' + h, rec.blob, rec.mime, { signal: session.signal })
        if (!isCurrent(session)) return
        await d.media.markSynced(h, session.owner)
        if (!isCurrent(session)) return
        upBackoff.delete(ownerHash(session.owner, h))
        quotaTold = false
        if (res && res.existed === false) added += rec.size
      } catch (e) {
        if (!isCurrent(session)) return
        const code = e?.code
        if (code === 'media-quota') {
          if (!quotaTold) {
            quotaTold = true
            d.toast(t('Your photo and video space on the server is full ({0} of {1} MB).', fmtMB(Number(e.data?.usedMB) || 0), fmtMB(Number(e.data?.quotaMB) || 0)))
          }
          stopped = true
          break
        }
        if (e?.status === 429) {
          retryNotBefore = d.now() + (Number(e.retryAfter) || 60) * 1000
          stopped = true
          break
        }
        if (REJECTED.has(code) || e?.status === 413 || e?.status === 415) {
          await d.media.markRejected(h, session.owner)
          if (!isCurrent(session)) return
          rejected++
          if (!rejectTold.has(h)) {
            rejectTold.add(h)
            d.toast(code === 'media-type' || code === 'media-invalid'
              ? t('That file type isn’t supported. Use a photo, a GIF, or an MP4, MOV or WebM video.')
              : code === 'media-too-long' ? t('That video is too long. Max {0} seconds.', Number(e.data?.maxSec) || 60)
                : t('The server refused the file as too large.'))
          }
          continue
        }
        // No network, a stall, a server error, a full disk, a refused session: this one waits,
        // and so does the rest of the run — the next trigger (the network coming back, the next
        // sync) tries again.
        bump(upBackoff, session.owner, h, UPLOAD_BACKOFF)
        stopped = true
        break
      }
    }
    lastRun = { refs: key, at: d.now(), complete: !stopped && !deferred && !skipped }
    if (usage && added) usage = { ...usage, bytes: (usage.bytes || 0) + added }
    await publishPending(session, { usage, deferred, rejected, unavailable })
  }

  /** Makes the state's files and the server agree, once at a time (a second call while one runs
   *  is folded into one more run after it). `force` skips the 10-minute dedupe, the upload
   *  backoff and the wait for Wi-Fi; `retryRejected` also offers again what the server refused. */
  function syncMedia(opts = {}) {
    const session = sessionFor()
    if (running && runningEpoch === session.epoch) {
      again = { force: !!(again?.force || opts.force), retryRejected: !!(again?.retryRejected || opts.retryRejected) }
      return running
    }
    const job = (async () => {
      try { await withLock('radian-media-sync', () => run(opts, session)) }
      catch { /* best effort: the next trigger tries again */ }
      finally {
        if (running === job) {
          running = null
          runningEpoch = null
          if (again) { const a = again; again = null; syncMedia(a) }
        }
      }
    })()
    running = job
    runningEpoch = session.epoch
    return job
  }

  /** Before a sign-out decides: the run in flight, then one forced run, at most 60 s. */
  async function settle() {
    if (running) await running.catch(() => {})
    await Promise.race([syncMedia({ force: true }), sleep(SETTLE_BUDGET_MS)])
  }

  /**
   * Downloads one file into the local store, checked: its sha256 must be its name and its
   * first bytes must be the type the state says (`expect.mime`), and an answer longer than the
   * state says (`expect.size`) is not even read. Resolves true once it is stored. Rejects with
   * code 'missing' (the server does not have it — the per-hash backoff then keeps devices from
   * asking every render), 'offline', 'integrity' or 'unavailable' (no server to ask). `force`
   * asks past that backoff — a tap on a tile that failed.
   */
  function fetchToStore(hash, expect = {}, { force = false, owner = d.media.owner || 'guest' } = {}) {
    const session = sessionFor()
    owner = String(owner || 'guest')
    const key = ownerHash(owner, hash)
    if (fetching.has(key)) return fetching.get(key)
    const job = (async () => {
      if (!store || !isCurrent(session) || session.owner !== owner || session.uid !== owner || store.getState().sync?.held) {
        throw Object.assign(new Error('unavailable'), { code: 'unavailable' })
      }
      await d.media.ready?.(owner)
      if (!isCurrent(session)) throw Object.assign(new Error('unavailable'), { code: 'unavailable' })
      if (!force && active(missBackoff, owner, hash)) throw Object.assign(new Error('missing'), { code: 'missing' })
      let blob
      try { blob = await d.apiBlob('/api/media/' + hash, { expectSize: typeof expect.size === 'number' ? expect.size : undefined, signal: session.signal }) }
      catch (e) {
        if (!isCurrent(session)) throw Object.assign(new Error('unavailable'), { code: 'unavailable' })
        if (e?.status === 404) { bump(missBackoff, owner, hash, MISSING_BACKOFF); throw Object.assign(new Error('missing'), { code: 'missing' }) }
        if (e?.code === 'not-paired' || e?.status === 401) throw Object.assign(new Error('unavailable'), { code: 'unavailable' })
        if (isNetwork(e)) throw Object.assign(new Error('offline'), { code: 'offline' })
        throw Object.assign(new Error('integrity'), { code: 'integrity' })
      }
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (!isCurrent(session)) throw Object.assign(new Error('unavailable'), { code: 'unavailable' })
      const sniffed = sniffKind(bytes.subarray(0, 64))
      const mime = sniffed?.mime
      if (!mime || !MEDIA_MIMES[mime] || (expect.mime && mime !== expect.mime) || (await d.sha256(bytes)) !== hash) {
        throw Object.assign(new Error('integrity'), { code: 'integrity' })
      }
      if (!isCurrent(session)) throw Object.assign(new Error('unavailable'), { code: 'unavailable' })
      await d.media.put(hash, new Blob([bytes], { type: mime }), { mime, pending: false, owner })
      if (!isCurrent(session)) throw Object.assign(new Error('unavailable'), { code: 'unavailable' })
      missBackoff.delete(key)
      return true
    })()
    fetching.set(key, job)
    job.catch(() => {}).finally(() => { if (fetching.get(key) === job) fetching.delete(key) })
    return job
  }
  /** Whether a download of `hash` would be tried now (not inside a 'missing' backoff). */
  const mayFetch = (hash, owner = d.media.owner || 'guest') => !active(missBackoff, String(owner || 'guest'), hash)

  /**
   * Deletes the local files nothing needs any more. Live = what the state in memory references,
   * what the saved copy references (another tab may be on an older or newer one), what any stash
   * references, what an open editor holds as its draft (mediaStore.hold), and anything put in the
   * last hour (a draft abandoned without closing, or another tab's). Signed in, the store is then kept under LOCAL_CACHE_MAX_MB by evicting main files
   * that are safely on the server, least recently shown first; posters the state references and
   * pending files are never evicted, and a guest's or a local phone's referenced files are never
   * evicted at all — for them this is the only copy.
   *
   * Not before boot has finished (`ready`): until then the state in memory can be the one
   * localStorage held while the copy boot is about to restore — the phone's file mirror, the
   * server's pull — refers to files memory does not know yet, and on a phone in local mode those
   * files are the only copy. A call that comes too early is remembered and runs once `ready`
   * flips (start). Resolves false when it did not run.
   */
  async function localMediaGc() {
    if (!store) return false
    if (!store.getState().ready) { gcWaiting = true; return false }
    const session = sessionFor()
    if (store.getState().sync?.held || (session.uid && session.uid !== session.owner)) return false
    await d.media.ready?.(session.owner)
    if (!isCurrent(session)) return false
    gcWaiting = false
    await withLock('radian-media', async () => {
      if (!isCurrent(session)) return
      const st = store.getState()
      const live = referencedHashes(st.S)
      try {
        const raw = d.storage?.getItem(PERSISTED_KEY)
        if (raw) for (const h of referencedHashes(JSON.parse(raw))) live.add(h)
      } catch { /* an unreadable copy keeps nothing extra */ }
      try {
        if (typeof st.stashedMediaHashes === 'function') for (const h of await st.stashedMediaHashes()) live.add(h)
      } catch { return }   // the stash could not be read: delete nothing rather than guess
      if (!isCurrent(session)) return
      // A second guard on a phone: the mirror is read even after boot, since a copy that failed
      // to reach localStorage lives only there and in memory, and memory may already have moved on.
      try {
        if (d.nativeLoad) { const saved = await d.nativeLoad(); if (saved) for (const h of referencedHashes(saved)) live.add(h) }
      } catch { return }   // the mirror could not be read: delete nothing rather than guess
      if (!isCurrent(session)) return
      // A file an open editor holds as its draft is live too, however long the editor has been open.
      const held = r => typeof d.media.isHeld === 'function' && d.media.isHeld(r.hash, session.owner)
      const cutoff = d.now() - LOCAL_GC_GRACE_MS
      const all = await d.media.list(session.owner)
      if (!isCurrent(session)) return
      for (const r of all) if (!live.has(r.hash) && !held(r) && (r.putAt || 0) < cutoff) {
        if (!isCurrent(session)) return
        await d.media.remove(r.hash, session.owner)
      }
      if (!st.user) return
      const left = (await d.media.list(session.owner)).filter(r => live.has(r.hash) || held(r) || (r.putAt || 0) >= cutoff)
      if (!isCurrent(session)) return
      let bytes = left.reduce((n, r) => n + (r.size || 0), 0)
      if (bytes <= LOCAL_CACHE_MAX_MB * MB) return
      const refs = referencedFiles(st.S)
      const posters = new Set(refs.filter(f => f.poster).map(f => f.hash))
      const inState = new Set(refs.map(f => f.hash))
      const candidates = left
        .filter(r => !r.pending && !posters.has(r.hash) && !held(r) && (r.putAt || 0) < cutoff)
        .sort((a, b) => (inState.has(a.hash) - inState.has(b.hash)) || ((a.shownAt || 0) - (b.shownAt || 0)))
      for (const r of candidates) {
        if (bytes <= LOCAL_CACHE_MAX_MB * MB) break
        if (!isCurrent(session)) return
        await d.media.remove(r.hash, session.owner)
        bytes -= r.size || 0
      }
    })
    return true
  }

  /**
   * Makes the posters and files of every custom exercise in the plan and in the session in
   * progress local, so they show without a network — and the posters of the photos and videos
   * of the most recent workouts that have some (RECENT_WORKOUT_POSTERS), so the history's
   * thumbnails do too; their main files come down when one is opened. Signed in only (nothing to
   * fetch from otherwise), and only on a connection that is not metered (prefetchAllowed).
   */
  function startCustomMediaPrefetch({ delay = 8000 } = {}) {
    if (!store) return () => {}
    let timer = null
    let busy = false
    const want = () => {
      const S = store.getState().S
      const ids = new Set()
      ;(S?.routines || []).forEach(r => (r?.ex || []).forEach(e => { if (e?.id) ids.add(e.id) }))
      ;(S?.active?.entries || []).forEach(en => { if (en?.id) ids.add(en.id) })
      const used = { customEx: (S?.customEx || []).filter(c => c && ids.has(c.id)) }
      const withMedia = (Array.isArray(S?.workouts) ? S.workouts : []).filter(w => Array.isArray(w?.media) && w.media.length)
      const posters = referencedFiles({ workouts: withMedia.slice(-RECENT_WORKOUT_POSTERS) }).filter(f => f.poster)
      return [...referencedFiles(used), ...posters]
    }
    const runPrefetch = async () => {
      timer = null
      const st = store.getState()
      const session = sessionFor(st)
      if (busy || !st.user || st.sync?.held || session.owner !== st.user.id || !st.config?.media || !d.allowed()) return
      busy = true
      try {
        for (const f of want()) {
          if (!isCurrent(session)) break
          if (!d.allowed()) break
          if (await d.media.has(f.hash, session.owner) || !mayFetch(f.hash, session.owner)) continue
          try { await fetchToStore(f.hash, f, { owner: session.owner }) } catch (e) { if (e?.code === 'offline' || e?.code === 'unavailable') break }
        }
      } finally { busy = false }
    }
    const schedule = () => { clearTimeout(timer); timer = setTimeout(runPrefetch, delay) }
    let seen = store.getState().S
    const unsub = store.subscribe(s => {
      if (s.S?.routines === seen?.routines && s.S?.active === seen?.active && s.S?.customEx === seen?.customEx && s.S?.workouts === seen?.workouts) return
      seen = s.S
      schedule()
    })
    globalThis.addEventListener?.('online', schedule)
    schedule()
    return () => { unsub(); clearTimeout(timer); globalThis.removeEventListener?.('online', schedule) }
  }

  /**
   * Wires it all to the app store: a run 2 s after the referenced files change, a sync lands
   * (sync.lastSynced moves) or the account changes; a forced one when the network comes back;
   * the local clean-up once the app is idle and 10 s after the references change — both only
   * once boot has finished, and one asked for before that runs when it does. The references
   * are compared as a joined string, because every update clones the state and S.customEx is a
   * new array each time.
   */
  function start(appStore) {
    store = appStore
    loadPending()
    registerMediaRunner({ settle })
    let timer = null
    let pendingForce = false
    const schedule = (ms, force = false) => {
      pendingForce = pendingForce || force
      clearTimeout(timer)
      timer = setTimeout(() => { const f = pendingForce; pendingForce = false; timer = null; syncMedia({ force: f }) }, ms)
    }
    let gcTimer = null
    const scheduleGc = ms => { clearTimeout(gcTimer); gcTimer = setTimeout(() => { gcTimer = null; localMediaGc().catch(() => {}) }, ms) }
    let mediaOwner = d.media.owner
    const mediaOff = typeof d.media.subscribe === 'function' ? d.media.subscribe(() => {
      const owner = d.media.owner
      if (owner === mediaOwner) return
      mediaOwner = owner
      sessionFor(store.getState())
      publishMediaStatus({ usage: null, pending: pendingRefCount(store.getState().S), deferred: 0, rejected: 0, unavailable: 0 })
      schedule(500)
      scheduleGc(2000)
    }) : () => {}
    const refsKey = S => [...referencedHashes(S)].sort().join(',')
    let prev = store.getState()
    let prevRefs = refsKey(prev.S)
    const unsub = store.subscribe(s => {
      const refs = s.S === prev.S ? prevRefs : refsKey(s.S)
      const moved = refs !== prevRefs
      if (moved || s.sync?.lastSynced !== prev.sync?.lastSynced || s.user?.id !== prev.user?.id) schedule(2000)
      if (moved) scheduleGc(10000)
      // Boot has restored the state: a clean-up that was asked for before now sees the real copy.
      if (s.ready && !prev.ready && gcWaiting) scheduleGc(2000)
      prev = s
      prevRefs = refs
    })
    const online = () => schedule(500, true)
    globalThis.addEventListener?.('online', online)
    const idle = cb => (typeof globalThis.requestIdleCallback === 'function' ? globalThis.requestIdleCallback(cb, { timeout: 30000 }) : setTimeout(cb, 5000))
    idle(() => localMediaGc().catch(() => {}))
    schedule(3000)
    const stopPrefetch = startCustomMediaPrefetch()
    return () => { unsub(); mediaOff(); stopPrefetch(); clearTimeout(timer); clearTimeout(gcTimer); sessionController?.abort(); globalThis.removeEventListener?.('online', online) }
  }

  return { syncMedia, settle, fetchToStore, mayFetch, localMediaGc, startCustomMediaPrefetch, start, _setStore: s => { store = s } }
}

// The app's own instance, made on first use so importing this module costs nothing.
let shared = null
const inst = () => (shared || (shared = createMediaSync()))
export const startMediaSync = appStore => inst().start(appStore)
export const syncMedia = opts => inst().syncMedia(opts)
export const fetchToStore = (hash, expect, opts) => inst().fetchToStore(hash, expect, opts)
export const mayFetch = (hash, owner) => inst().mayFetch(hash, owner)
export const localMediaGc = () => inst().localMediaGc()
export const settleMediaSync = () => inst().settle()
/** Tests only. */
export const _setSharedMediaSync = s => { shared = s }

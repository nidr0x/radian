import { useEffect, useRef, useState } from 'react'
import { t, exerciseNameFor } from '../lib/i18n.js'
import { exOr } from '../lib/exercises.js'
import { dispatchInterval, reconcileInterval } from '../lib/interval-engine.js'

const nameOf = station => station?.name || (station?.exerciseId ? exerciseNameFor(exOr(station.exerciseId)) : '')
const formatClock = milliseconds => {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

function nextStationFor(interval) {
  const stations = interval?.stations || []
  if (!stations.length) return null
  const block = interval.pendingBlockIndex ?? interval.blockIndex + 1
  if (block >= stations.length * (interval.totalRounds ?? interval.plan?.rounds ?? 1)) return null
  return stations[block % stations.length]
}

function clockFor(interval, now) {
  if (interval.status === 'paused') return interval.pausedRemainingMs ?? 0
  if (interval.deadlineAt != null) return Math.max(0, interval.deadlineAt - now)
  if (interval.status === 'ready') {
    const seconds = interval.plan?.mode === 'amrap' ? interval.plan.durationSec
      : interval.plan?.mode === 'intervals' ? interval.plan.workSec
        : interval.plan?.mode === 'emom' ? interval.plan.windowSec : 0
    return seconds * 1000
  }
  return Math.max(0, now - (interval.phaseStartedAt || now))
}

export default function IntervalPlayer({ active, onIntervalChange, onConfirm, onFinish }) {
  const interval = active?.interval
  const [now, setNow] = useState(() => Date.now())
  const intervalRef = useRef(interval)
  const onChangeRef = useRef(onIntervalChange)
  intervalRef.current = interval
  onChangeRef.current = onIntervalChange

  useEffect(() => {
    const tick = window.setInterval(() => {
      const at = Date.now()
      setNow(at)
      const current = intervalRef.current
      if (!current || current.status !== 'running' || current.deadlineAt == null) return
      const next = reconcileInterval(current, at).run
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        intervalRef.current = next
        onChangeRef.current?.(next)
      }
    }, 250)
    return () => window.clearInterval(tick)
  }, [])

  useEffect(() => {
    const reconcile = () => {
      const current = intervalRef.current
      if (!current || document.visibilityState === 'hidden') return
      const at = Date.now()
      setNow(at)
      const next = reconcileInterval(current, at)
      if (JSON.stringify(next.run) !== JSON.stringify(current)) {
        intervalRef.current = next.run
        onChangeRef.current?.(next.run)
      }
    }
    reconcile()
    window.addEventListener('pageshow', reconcile)
    window.addEventListener('focus', reconcile)
    document.addEventListener('visibilitychange', reconcile)
    return () => {
      window.removeEventListener('pageshow', reconcile)
      window.removeEventListener('focus', reconcile)
      document.removeEventListener('visibilitychange', reconcile)
    }
  }, [active?.id])

  if (!interval) return null
  const currentStation = interval.stations?.[interval.station]
  const nextStation = nextStationFor(interval)
  const currentEntry = active.entries?.find(entry => entry?.intervalEntryKey === currentStation?.entryKey)
  const loggedSetIndices = new Set((interval.loggedSetIndices || [])
    .filter(item => item?.station === interval.station).map(item => item.setIndex))
  const actual = (currentEntry?.sets || []).flatMap((set, setIndex) => set?.done === true && set.warmup !== true && set.phase !== 'warmup'
    && !loggedSetIndices.has(setIndex) ? [{ setIndex, done: true, ...set }]
    : [])
  const isRest = interval.phase === 'rest' || interval.phase === 'roundRest'
  const phaseLabel = interval.status === 'ready' ? t('Ready')
    : interval.status === 'paused' ? t('Paused')
      : interval.status === 'done' ? t('Complete')
        : interval.phase === 'roundRest' ? t('Rest between rounds')
          : isRest ? t('Rest') : t('Work')
  const roundLabel = interval.plan.mode === 'amrap'
    ? t('AMRAP · {0}', formatClock(interval.plan.durationSec * 1000))
    : t('Round {0} of {1}', Math.min(interval.round + 1, interval.totalRounds ?? interval.plan.rounds), interval.totalRounds ?? interval.plan.rounds)
  const clockLabel = formatClock(clockFor(interval, now))
  const canConfirm = actual.length > 0 && interval.status === 'running' && interval.phase === 'work' && interval.plan.mode !== 'amrap'
  const dispatch = action => {
    const at = Date.now()
    setNow(at)
    const next = dispatchInterval(intervalRef.current, action, at)
    if (JSON.stringify(next.run) !== JSON.stringify(intervalRef.current)) {
      intervalRef.current = next.run
      onChangeRef.current?.(next.run)
    }
  }
  const setAmrapScore = (field, value) => {
    const parsed = Number(value)
    const next = {
      ...interval,
      [field]: Math.max(0, Math.min(9999, Number.isFinite(parsed) ? Math.trunc(parsed) : 0)),
    }
    intervalRef.current = next
    onChangeRef.current?.(next)
  }

  return <section className="card interval-player" data-testid="interval-player" data-status={interval.status} data-phase={interval.phase} aria-label={t('Interval workout')}>
    <div className="interval-player-top">
      <span className={'tag ' + (interval.status === 'running' ? 'acc' : '')}>{phaseLabel}</span>
      <span className="small muted">{roundLabel}</span>
    </div>
    <div className="interval-clock" data-testid="interval-clock" aria-live="off">{clockLabel}</div>
    {currentStation && <div className="interval-station" data-testid="interval-current">
      <span className="small muted">{t('Current station')}</span>
      <strong>{nameOf(currentStation)}</strong>
    </div>}
    {nextStation && <div className="interval-next" data-testid="interval-next">
      <span className="small muted">{t('Next station')}</span>
      <span>{nameOf(nextStation)}</span>
    </div>}
    <div className="interval-progress">
      <span data-testid="interval-confirmed">{t('Confirmed')}: {interval.confirmed?.length || 0}</span>
      <span data-testid="interval-skipped">{t('Skipped')}: {interval.skipped?.length || 0}</span>
    </div>
    {interval.plan.mode === 'amrap' && <div className="interval-score">
      <label>{t('Rounds completed')}
        <input className="input" type="number" min="0" max="9999" step="1" data-interval-score="rounds"
          value={interval.rounds || 0} onChange={event => setAmrapScore('rounds', event.target.value)} />
      </label>
      <label>{t('Partial reps')}
        <input className="input" type="number" min="0" max="9999" step="1" data-interval-score="partial-reps"
          value={interval.partialReps || 0} onChange={event => setAmrapScore('partialReps', event.target.value)} />
      </label>
    </div>}
    <p className="small dim interval-lock-note">{t('The browser may pause alerts while the screen is locked.')}</p>

    <div className="interval-actions">
      {interval.status === 'ready' && <button className="btn primary" data-interval-action="start" onClick={() => dispatch({ type: 'start' })}>{t('Start interval')}</button>}
      {interval.status === 'running' && <>
        {interval.phase === 'work' && interval.plan.mode !== 'amrap' && <>
          <button className="btn primary" data-interval-action="confirm" disabled={!canConfirm}
            onClick={() => onConfirm?.({ round: interval.round, station: interval.station }, actual)}>{t('Confirm station')}</button>
          <button className="btn ghost" data-interval-action="skip"
            onClick={() => dispatch({ type: 'skip-work', round: interval.round, station: interval.station })}>{t('Skip station')}</button>
        </>}
        <button className="btn ghost" data-interval-action="pause" onClick={() => dispatch({ type: 'pause' })}>{t('Pause')}</button>
        <button className="btn ghost dim" data-interval-action="stop" onClick={() => dispatch({ type: 'stop' })}>{t('Stop interval')}</button>
      </>}
      {interval.status === 'paused' && <>
        <button className="btn primary" data-interval-action="resume" onClick={() => dispatch({ type: 'resume' })}>{t('Resume')}</button>
        <button className="btn ghost dim" data-interval-action="stop" onClick={() => dispatch({ type: 'stop' })}>{t('Stop interval')}</button>
      </>}
      {interval.status === 'done' && <>
        {interval.plan.mode === 'circuit' && <button className="btn ghost" data-interval-action="add-round" onClick={() => dispatch({ type: 'start' })}>{t('Add another round')}</button>}
        <button className="btn primary" data-interval-action="finish" onClick={onFinish}>{t('Finish workout')}</button>
      </>}
    </div>
  </section>
}

/* @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIntervalRun, dispatchInterval } from '../lib/interval-engine.js'
import { confirmIntervalStation } from '../lib/interval-session.js'
import IntervalPlayer from './IntervalPlayer.jsx'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const stations = [
  { entryIndex: 0, entryKey: 'workout-1:0', exerciseId: 'squat', name: 'Squat' },
  { entryIndex: 1, entryKey: 'workout-1:1', exerciseId: 'row', name: 'Row' },
]

function runningActive(plan, now = 1_000) {
  const created = createIntervalRun({ plan: { v: 1, ...plan }, stations, workoutId: 'workout-1', now })
  const interval = dispatchInterval(created, { type: 'start' }, now).run
  return {
    id: 'workout-1',
    interval,
    entries: stations.map(station => ({
      id: station.exerciseId,
      intervalEntryKey: station.entryKey,
      sets: [{ w: 20, r: 8, done: false }],
    })),
  }
}

function Harness({ initial, onFinish = () => {}, onIntervalChange = () => {} }) {
  const [active, setActive] = React.useState(initial)
  return <IntervalPlayer
    active={active}
    onIntervalChange={interval => {
      setActive(current => ({ ...current, interval }))
      onIntervalChange(interval)
    }}
    onConfirm={(position, actual) => setActive(current => confirmIntervalStation(current, position, actual, Date.now()))}
    onFinish={onFinish}
  />
}

import React from 'react'

describe('interval player', () => {
  let host, root

  beforeEach(() => {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  it('IntervalPlayer_rendersCurrentAndNextStation', async () => {
    const active = runningActive({ mode: 'circuit', rounds: 2, gapSec: 15, roundRestSec: 0 })
    await act(async () => root.render(<Harness initial={active} />))

    expect(host.querySelector('[data-testid="interval-current"]')?.textContent).toContain('Squat')
    expect(host.querySelector('[data-testid="interval-next"]')?.textContent).toContain('Row')
  })

  it('IntervalPlayer_pausesAndResumes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const active = runningActive({ mode: 'amrap', durationSec: 300 }, 1_000)
    await act(async () => root.render(<Harness initial={active} />))

    await act(async () => host.querySelector('[data-interval-action="pause"]').click())
    expect(host.querySelector('[data-testid="interval-player"]')?.dataset.status).toBe('paused')
    vi.setSystemTime(20_000)
    await act(async () => host.querySelector('[data-interval-action="resume"]').click())
    expect(host.querySelector('[data-testid="interval-player"]')?.dataset.status).toBe('running')
    expect(host.querySelector('[data-testid="interval-clock"]')?.textContent).toBe('5:00')
  })

  it('IntervalPlayer_skipsExpiredWorkAfterReopen', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(12_000)
    const active = runningActive({ mode: 'intervals', workSec: 10, restSec: 5, rounds: 2 }, 1_000)
    await act(async () => root.render(<Harness initial={active} />))

    expect(host.querySelector('[data-testid="interval-player"]')?.dataset.phase).toBe('rest')
    expect(host.querySelector('[data-testid="interval-skipped"]')?.textContent).toContain('1')
    expect(host.querySelector('[data-testid="interval-confirmed"]')?.textContent).toContain('0')
  })

  it('IntervalPlayer_skipsWorkWhenTheForegroundTimerExpires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const active = runningActive({ mode: 'intervals', workSec: 10, restSec: 5, rounds: 2 }, 1_000)
    await act(async () => root.render(<Harness initial={active} />))
    await act(async () => vi.advanceTimersByTime(10_000))

    expect(host.querySelector('[data-testid="interval-player"]')?.dataset.phase).toBe('rest')
    expect(host.querySelector('[data-testid="interval-skipped"]')?.textContent).toContain('1')
    expect(host.querySelector('[data-testid="interval-confirmed"]')?.textContent).toContain('0')
  })

  it('IntervalPlayer_stopsAmrapAtItsCapWithoutInventingAScore', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const active = runningActive({ mode: 'amrap', durationSec: 60 }, 1_000)
    await act(async () => root.render(<Harness initial={active} />))
    await act(async () => vi.advanceTimersByTime(60_000))

    expect(host.querySelector('[data-testid="interval-player"]')?.dataset.status).toBe('done')
    expect(host.querySelector('[data-interval-score="rounds"]')?.value).toBe('0')
    expect(host.querySelector('[data-interval-score="partial-reps"]')?.value).toBe('0')
  })

  it('IntervalPlayer_finishesCircuit', async () => {
    const active = runningActive({ mode: 'circuit', rounds: 1, gapSec: 0, roundRestSec: 0 })
    active.interval.stations = active.interval.stations.slice(0, 1)
    active.entries = active.entries.slice(0, 1)
    active.entries[0].sets[0] = { w: 20, r: 8, done: true }
    const onFinish = vi.fn()
    await act(async () => root.render(<Harness initial={active} onFinish={onFinish} />))

    await act(async () => host.querySelector('[data-interval-action="confirm"]').click())
    expect(host.querySelector('[data-testid="interval-player"]')?.dataset.status).toBe('done')
    await act(async () => host.querySelector('[data-interval-action="finish"]').click())
    expect(onFinish).toHaveBeenCalledOnce()
  })

  it('IntervalPlayer_keepsAmrapScoreOutOfSetFailure', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const active = runningActive({ mode: 'amrap', durationSec: 60 })
    const onIntervalChange = vi.fn()
    await act(async () => root.render(<Harness initial={active} onIntervalChange={onIntervalChange} />))

    const rounds = host.querySelector('[data-interval-score="rounds"]')
    const partialReps = host.querySelector('[data-interval-score="partial-reps"]')
    expect(rounds).not.toBeNull()
    expect(partialReps).not.toBeNull()
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setValue.call(rounds, '3')
      rounds.dispatchEvent(new Event('input', { bubbles: true }))
      setValue.call(partialReps, '4')
      partialReps.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onIntervalChange).toHaveBeenLastCalledWith(expect.objectContaining({ rounds: 3, partialReps: 4 }))
    expect(active.entries[0].sets[0]).not.toHaveProperty('failure')
  })
})

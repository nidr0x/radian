import { describe, expect, it } from 'vitest'
import {
  FIT_EPOCH_OFFSET,
  MSG,
  fitCrc,
  fitFileName,
  fitTime,
  workoutFit,
  workoutFitMessages,
} from './fit-export.js'

const start = Date.UTC(2024, 0, 2, 9, 30)
const workout = {
  id: 'synthetic-fit-export',
  d: '2024-01-02',
  start,
  end: start + 3 * 60 * 1000,
  entries: [{ id: '0025', sets: [{ w: 100.5, r: 8, done: true, at: start + 90_000 }] }],
}

const fieldValue = (message, number) => message.fields.find(([n]) => n === number)?.[2]

describe('FIT workout export', () => {
  it('encodes a FIT file with valid header and file CRCs', () => {
    const bytes = workoutFit(workout, { version: '1.4.2' })
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const signature = String.fromCharCode(...bytes.subarray(8, 12))

    expect(bytes[0]).toBe(14)
    expect(signature).toBe('.FIT')
    expect(view.getUint32(4, true)).toBe(bytes.length - 16)
    expect(view.getUint16(12, true)).toBe(fitCrc(bytes.subarray(0, 12)))
    expect(view.getUint16(bytes.length - 2, true)).toBe(fitCrc(bytes.subarray(0, bytes.length - 2)))
  })

  it('preserves date and converts decimal pounds to FIT kilograms', () => {
    const messages = workoutFitMessages({ ...workout, entries: [{ id: '0025', sets: [{ w: 100.5, r: 8, done: true, at: start + 90_000 }] }] }, { unit: 'lb' })
    const fileId = messages.find(m => m.global === MSG.fileId)
    const set = messages.find(m => m.global === MSG.set && fieldValue(m, 5) === 1)

    expect(fitTime(start)).toBe(Math.round(start / 1000) - FIT_EPOCH_OFFSET)
    expect(fieldValue(fileId, 4)).toBe(fitTime(start))
    expect(fieldValue(set, 4)).toBeCloseTo(100.5 * 0.45359237 * 16, 8)
    expect(fieldValue(set, 9)).toBe(2)
  })

  it('uses a stable date-based filename and refuses a workout without a date', () => {
    const date = new Date(start)
    const p = n => String(n).padStart(2, '0')

    expect(fitFileName(workout)).toBe(`radian-${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}.fit`)
    expect(() => workoutFitMessages({ entries: [] })).toThrow('This workout has no date')
  })
})

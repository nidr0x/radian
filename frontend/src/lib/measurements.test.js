import { describe, expect, it } from 'vitest'
import { fromMeasurementDisplay, fromMeasurementDisplayEdit, toMeasurementDisplay } from './measurements.js'

describe('measurement display edits', () => {
  it('keeps untouched canonical centimetres while converting only the edited field', () => {
    const originalCm = 100
    const shownInches = toMeasurementDisplay(originalCm, 'lb')
    const untouched = fromMeasurementDisplayEdit(shownInches, shownInches, originalCm, 'lb')
    const edited = fromMeasurementDisplayEdit(40, shownInches, originalCm, 'lb')

    expect(shownInches).toBe(39.4)
    expect(untouched).toBe(100)
    expect(edited).toBe(fromMeasurementDisplay(40, 'lb'))
    expect(edited).toBe(101.6)
  })

  it('clears a field when the visible value is removed', () => {
    expect(fromMeasurementDisplayEdit(null, 39.4, 100, 'lb')).toBeNull()
  })
})

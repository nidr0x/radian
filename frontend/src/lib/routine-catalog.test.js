import { describe, expect, it } from 'vitest'
import { ROUTINE_CATALOG } from './routine-catalog.js'
import { buildStarterPlan, starterCatalogErrors, starterPlanDays, starterPlanOptions } from './starter.js'

describe('routine catalog adapter', () => {
  it('exposes and builds every program without losing its prescriptions', () => {
    expect(starterCatalogErrors).toEqual([])
    const options = starterPlanOptions()
    expect(options).toHaveLength(60)

    for (const template of ROUTINE_CATALOG) {
      const option = options.find(({ id }) => id === template.id)
      expect(option).toMatchObject({
        id: template.id,
        name: template.name,
        nameEs: template.nameEs,
        about: template.about,
        aboutEs: template.aboutEs,
        goal: template.goal,
        level: template.level,
        equipment: template.equipment,
        days: template.sessions.length,
      })

      const plan = buildStarterPlan(template.id)
      expect(plan?.template).toBe(template)
      expect(plan?.sessions).toEqual(template.sessions)
      expect(plan?.schedule.map(({ day }) => day)).toEqual(starterPlanDays(template.id))
      expect(plan?.routines).toHaveLength(template.sessions.length)
      for (const [index, session] of template.sessions.entries()) {
        expect(plan.routines[index]).toMatchObject({ name: session.name, emoji: session.emoji })
        expect(plan.routines[index].ex).toEqual(session.exercises.map(exercise => ({ ...exercise, weight: 0 })))
      }
    }
  })

  it('returns null for an unknown program id', () => {
    expect(buildStarterPlan('unknown-program')).toBeNull()
    expect(starterPlanDays('unknown-program')).toBeNull()
  })
})

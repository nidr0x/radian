import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import WORKOUT_GUIDE_MAP from './workout-guide-map.json' with { type: 'json' }
import { EXDB, EXIDX } from './exercises.js'
import { ROUTINE_CATALOG } from './routine-catalog.js'
import { workoutGuideFrames, workoutGuideSlug } from './workout-guide.js'
import { planMediaUrls } from './media-prefetch.js'

describe('Workout Guide mapping', () => {
  it('maps every routine exercise to a real local illustration', () => {
    const ids = Object.keys(WORKOUT_GUIDE_MAP)
    const slugs = Object.values(WORKOUT_GUIDE_MAP)
    const catalogueIds = new Set(EXDB.map(ex => ex.id))
    const routineIds = new Set(ROUTINE_CATALOG.flatMap(program => program.sessions.flatMap(session => session.exercises.map(ex => ex.id))))

    expect(ids.length).toBeGreaterThanOrEqual(85)
    expect(ids.every(id => catalogueIds.has(id))).toBe(true)
    expect(slugs.every(slug => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))).toBe(true)
    expect([...routineIds].every(id => WORKOUT_GUIDE_MAP[id])).toBe(true)
  })

  it('returns exactly three local Workout Guide frames for a mapped exercise', () => {
    const [id, slug] = Object.entries(WORKOUT_GUIDE_MAP)[0]
    const exercise = EXIDX[id]

    expect(workoutGuideSlug(exercise)).toBe(slug)
    expect(workoutGuideFrames(exercise)).toEqual([
      `/exercise-media/workout-guide/${slug}/frame-1.png`,
      `/exercise-media/workout-guide/${slug}/frame-2.png`,
      `/exercise-media/workout-guide/${slug}/frame-3.png`,
    ])
    expect(workoutGuideFrames(exercise).every(url => !/gym-visual|\/exercise-media\/(still|clip)\//i.test(url))).toBe(true)
  })

  it('has a neutral no-mapping result for an unknown exercise', () => {
    expect(workoutGuideSlug({ id: 'not-in-the-catalogue' })).toBeNull()
    expect(workoutGuideFrames({ id: 'not-in-the-catalogue' })).toEqual([])
  })

  it('keeps the white thumbnail surface outside the inverted artwork', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8')
    const component = readFileSync(new URL('../components/Media.jsx', import.meta.url), 'utf8')
    const thumb = css.match(/\.thumb\s*\{([^}]*)\}/)?.[1] || ''
    const wrapper = css.match(/\.thumb\.workout-guide-thumb\s*\{([^}]*)\}/)?.[1] || ''
    const artwork = css.match(/\.thumb\.workout-guide-thumb\s+img\s*\{([^}]*)\}/)?.[1] || ''

    expect(component).toMatch(/<span className="thumb workout-guide-thumb">\s*<img/)
    expect(thumb).toContain('background:#fff')
    expect(wrapper).not.toMatch(/filter\s*:/)
    expect(artwork).toContain('filter:invert(1)')
  })

  it('plans only unique same-origin guide frames for built-ins in the plan and active session', () => {
    const [mappedId] = Object.keys(WORKOUT_GUIDE_MAP)
    const custom = { id: 'custom-1', custom: true, img: 'my-own-photo.webp' }
    const urls = planMediaUrls({
      routines: [{ ex: [{ id: mappedId }, { id: mappedId }, custom, { id: 'missing' }] }],
      active: { entries: [{ id: mappedId }, { id: 'missing' }] },
    }, 'https://gym.example/app', {
      [mappedId]: EXIDX[mappedId],
      [custom.id]: custom,
    })
    const slug = WORKOUT_GUIDE_MAP[mappedId]

    expect(urls).toEqual([
      `https://gym.example/exercise-media/workout-guide/${slug}/frame-1.png`,
      `https://gym.example/exercise-media/workout-guide/${slug}/frame-2.png`,
      `https://gym.example/exercise-media/workout-guide/${slug}/frame-3.png`,
    ])
    expect(urls.every(url => new URL(url).origin === 'https://gym.example')).toBe(true)
  })
})

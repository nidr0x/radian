import WORKOUT_GUIDE_MAP from './workout-guide-map.json' with { type: 'json' }

const MEDIA_ROOT = '/exercise-media/workout-guide/'

// shortcut: the guide has one figure per movement, so the PWA ignores the figure preference until licensed variants exist.
export const workoutGuideSlug = ex => WORKOUT_GUIDE_MAP[ex?.id] || null

export const workoutGuideFrames = ex => {
  const slug = workoutGuideSlug(ex)
  return slug ? [1, 2, 3].map(frame => MEDIA_ROOT + slug + '/frame-' + frame + '.png') : []
}

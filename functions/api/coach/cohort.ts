import { enforceAuthRateLimit, getAuthenticatedContext, json } from '../../lib/auth';
import { coachRuntime } from '../../lib/radian-api/coach.js';
import { readCoachCohortData } from '../../lib/radian-api/coach-cohort';
import type { CoachApiContext } from '../../lib/radian-api/coach-routes';

export const onRequestGet = async (context: CoachApiContext): Promise<Response> => {
  const authenticated = await getAuthenticatedContext(context);
  if (authenticated instanceof Response) return authenticated;
  const limited = await enforceAuthRateLimit(context, 'coach-cohort', authenticated.user.id);
  if (limited) return limited;
  const runtime = await coachRuntime(authenticated.env);
  if (runtime.reason === 'config_unavailable') return json({ error: 'coach_off' }, 503);
  let data;
  try { data = await readCoachCohortData(authenticated.env.DB!, authenticated.user.id); }
  catch { return json({ error: 'cohort_unavailable' }, 503); }
  const enabled = runtime.enabled && runtime.community;
  const enough = data.people >= data.minPeople && !!data.sessionsPerWeek;
  const ok = enabled && data.sharing && enough;
  return json({
    ok, enabled, sharing: data.sharing,
    people: enabled && data.sharing ? data.people : 0,
    minPeople: data.minPeople,
    unit: data.unit,
    sessionsPerWeek: ok ? data.sessionsPerWeek : null,
    exercises: ok ? data.exercises : [],
    rankPct: ok ? data.rankPct : null,
  });
};

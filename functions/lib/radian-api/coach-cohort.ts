import type { D1DatabaseLike } from '../../types';
import { readGymState } from '../db/radian/state';
import { libraryName } from '../../../api/coach/core/library.js';

const MIN_PEOPLE = 3;
const DAY = 86_400_000;
const LB_PER_KG = 2.2046226218;
type Unit = 'kg' | 'lb';
type ProfileMetrics = { accountId: string; sessionsPerWeek: number; unit: Unit; best: Record<string, number> };
export interface CoachCohortData {
  sharing: boolean;
  people: number;
  minPeople: number;
  unit: Unit;
  sessionsPerWeek: { median: number; you: number } | null;
  exercises: Array<{ id: string; name: string; people: number; median: number | null; you: number | null }>;
  rankPct: number | null;
}

const FORMULAS: Record<string, (w: number, r: number) => number> = {
  epley: (w, r) => w * (1 + r / 30), brzycki: (w, r) => w * 36 / (37 - r),
  lombardi: (w, r) => w * Math.pow(r, 0.1), oconner: (w, r) => w * (1 + r / 40),
  mayhew: (w, r) => w * 100 / (52.2 + 41.9 * Math.exp(-0.055 * r)),
  wathan: (w, r) => w * 100 / (48.8 + 53.8 * Math.exp(-0.075 * r)),
  lander: (w, r) => w * 100 / (101.3 - 2.67123 * r),
};
const FORMULA_WEIGHTS: Record<string, { base: number; factor: (r: number) => number }> = {
  epley: { base: 0.95, factor: r => r <= 6 ? 1 : Math.max(0.4, 1 - (r - 6) * 0.12) },
  brzycki: { base: 1.1, factor: r => r <= 8 ? 1 : Math.max(0.3, 1 - (r - 8) * 0.18) },
  lombardi: { base: 0.85, factor: r => r <= 5 ? 1 : Math.max(0.4, 1 - (r - 5) * 0.1) },
  oconner: { base: 0.9, factor: r => r <= 6 ? 1 : Math.max(0.4, 1 - (r - 6) * 0.12) },
  mayhew: { base: 0.95, factor: r => r <= 8 ? 1 : Math.max(0.5, 1 - (r - 8) * 0.1) },
  wathan: { base: 0.9, factor: r => r <= 7 ? 1 : Math.max(0.4, 1 - (r - 7) * 0.12) },
  lander: { base: 0.85, factor: r => r <= 7 ? 1 : Math.max(0.35, 1 - (r - 7) * 0.15) },
};
const RIR_PCT = [100, 95.5, 92.2, 89.2, 86.3, 83.7, 81.1, 78.6, 76.2, 73.9, 71.7, 69.5, 67.5, 65.5, 63.6];
const weightedEstimate = (weight: number, reps: number): number => {
  let total = 0; let sum = 0;
  for (const [name, formula] of Object.entries(FORMULAS)) {
    const config = FORMULA_WEIGHTS[name]; const portion = config.base * config.factor(reps);
    total += formula(weight, reps) * portion; sum += portion;
  }
  const pct = RIR_PCT[Math.min(Math.max(Math.round(reps) - 1, 0), RIR_PCT.length - 1)];
  const portion = Math.max(0.4, 1 - Math.max(0, reps - 10) * 0.15);
  total += (weight * 100 / pct) * portion; sum += portion;
  return total / sum;
};
const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const round1 = (value: number): number => Math.round(value * 10) / 10;
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const estimate = (set: Record<string, unknown>, formula: string): number | null => {
  const phase = String(set.phase || '').toLowerCase().replace(/[-_]/g, '');
  const weight = Number(set.w); const reps = Number(set.r); const rir = Number(set.rir);
  if (set.done !== true || set.warmup === true || phase === 'warmup' || !Number.isFinite(weight) || weight <= 0 || !Number.isFinite(reps) || reps < 1) return null;
  const effective = Number.isFinite(rir) && rir >= 0 ? reps + rir : reps;
  if (formula === 'weighted' ? effective > 15 : reps > 12) return null;
  const result = formula === 'weighted'
    ? reps === 1 && (!Number.isFinite(rir) || rir === 0) ? weight : weightedEstimate(weight, effective)
    : reps === 1 ? weight : (FORMULAS[formula] || FORMULAS.epley)(weight, Math.round(reps));
  return Number.isFinite(result) && result > 0 ? result : null;
};

const profileMetrics = (state: Record<string, unknown>, accountId: string, now: number): ProfileMetrics => {
  const workouts: unknown[] = Array.isArray(state.workouts) ? state.workouts : [];
  const start = now - 28 * DAY;
  const recentSessions = workouts.filter(workoutValue => {
    const workout = obj(workoutValue);
    const day = typeof workout.d === 'string' ? Date.parse(`${workout.d}T12:00:00Z`) : NaN;
    const time = Number.isFinite(Number(workout.start)) ? Number(workout.start) : day;
    return Number.isFinite(time) && time >= start && time <= now;
  }).length;
  const formula = typeof state.oneRmFormula === 'string' && (FORMULAS[state.oneRmFormula] || state.oneRmFormula === 'weighted') ? state.oneRmFormula : 'epley';
  const best: Record<string, number> = {};
  for (const workoutValue of workouts) {
    const workout = obj(workoutValue);
    const entries: unknown[] = Array.isArray(workout.entries) ? workout.entries : [];
    for (const entryValue of entries) {
      const entry = obj(entryValue);
      const id = typeof entry.id === 'string' ? entry.id : '';
      if (!id || !libraryName(id) || /\bassisted\b/i.test(libraryName(id) || '') || entry.mode === 'time' || entry.mode === 'cardio') continue;
      const sets: unknown[] = Array.isArray(entry.sets) ? entry.sets : [];
      for (const setValue of sets) {
        const set = obj(setValue);
        const sides = obj(set.sides);
        const candidates: unknown[] = sides.L || sides.R ? [sides.L, sides.R] : [set];
        for (const candidate of candidates) {
          const value = estimate(obj(candidate), formula);
          if (value != null) best[id] = Math.max(best[id] || 0, value);
        }
      }
    }
  }
  return { accountId, sessionsPerWeek: recentSessions / 4, best, unit: state.unit === 'lb' ? 'lb' : 'kg' };
};

const empty = (sharing: boolean, people: number, unit: Unit): CoachCohortData => ({
  sharing, people, minPeople: MIN_PEOPLE, unit, sessionsPerWeek: null, exercises: [], rankPct: null,
});

export const readCoachCohortData = async (
  database: D1DatabaseLike,
  accountId: string,
  now = Date.now(),
  currentState?: Record<string, unknown>,
): Promise<CoachCohortData> => {
  const [own, profile] = await Promise.all([
    database.prepare('SELECT sharing FROM gym_coach_cohort_shares WHERE account_id = ?').bind(accountId).first<{ sharing: number }>(),
    database.prepare('SELECT unit FROM gym_profile WHERE account_id = ?').bind(accountId).first<{ unit: string | null }>(),
  ]);
  const unit: Unit = profile?.unit === 'lb' ? 'lb' : 'kg';
  if (own?.sharing !== 1) return empty(false, 0, unit);
  const shareRows = await database.prepare(`SELECT shares.account_id AS accountId
    FROM gym_coach_cohort_shares shares JOIN users ON users.id = shares.account_id
    WHERE shares.sharing = 1 AND users.disabled = 0`).all<{ accountId: string }>();
  const shares = shareRows.results;
  if (shares.length < MIN_PEOPLE) return empty(true, shares.length, unit);

  const profiles: ProfileMetrics[] = [];
  for (const share of shares) {
    const state = share.accountId === accountId && currentState ? currentState : (await readGymState(database, share.accountId)).state;
    if (state) profiles.push(profileMetrics(state, share.accountId, now));
  }
  const you = profiles.find(item => item.accountId === accountId);
  if (profiles.length < MIN_PEOPLE || !you) return empty(true, profiles.length, you?.unit || unit);

  const toReaderUnit = (value: number, from: Unit) => you.unit === from ? value : from === 'kg' ? value * LB_PER_KG : value / LB_PER_KG;
  const sessionsMedian = median(profiles.map(item => item.sessionsPerWeek));
  const ids = new Set(profiles.flatMap(item => Object.keys(item.best)));
  const exercises: CoachCohortData['exercises'] = [];
  const ranks: number[] = [];
  for (const id of ids) {
    const values = profiles.flatMap(item => item.best[id] ? [{ profile: item, value: toReaderUnit(item.best[id], item.unit) }] : []);
    if (values.length < MIN_PEOPLE) continue;
    const yours = values.find(item => item.profile.accountId === accountId)?.value ?? null;
    const typical = median(values.map(item => item.value));
    if (yours != null) {
      const others = values.filter(item => item.profile.accountId !== accountId);
      if (others.length) ranks.push(others.filter(item => item.value <= yours).length / others.length * 100);
    }
    exercises.push({ id, name: libraryName(id) || id, people: values.length,
      median: typical == null ? null : round1(typical), you: yours == null ? null : round1(yours) });
  }
  exercises.sort((a, b) => a.name.localeCompare(b.name));
  exercises.length = Math.min(exercises.length, 100);
  return { sharing: true, people: profiles.length, minPeople: MIN_PEOPLE, unit: you.unit,
    sessionsPerWeek: { median: sessionsMedian == null ? 0 : round1(sessionsMedian), you: round1(you.sessionsPerWeek) },
    exercises, rankPct: ranks.length ? Math.round(ranks.reduce((sum, value) => sum + value, 0) / ranks.length) : null };
};

/** Only cohort medians reach a provider; the caller's own values are already in its state payload. */
export const coachPromptCohort = (data: CoachCohortData): Record<string, unknown> | null => {
  if (!data.sharing || data.people < MIN_PEOPLE || !data.sessionsPerWeek) return null;
  return {
    unit: data.unit,
    people: data.people,
    sessionsPerWeek: { median: data.sessionsPerWeek.median },
    exercises: data.exercises.map(exercise => ({ id: exercise.id, name: exercise.name, median: exercise.median })),
  };
};

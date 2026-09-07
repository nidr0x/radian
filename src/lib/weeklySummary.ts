import { dateKey, formatDate, normalizeTrainingDays, weekKey } from './date';
import { overallFeedback, progressionAction, recommendationFor } from './recommendations';
import { isWorkSet } from './progression';
import type { AppData, Difficulty, Energy, WorkoutSession } from '../types';

export interface WeeklySummary {
  periodLabel: string;
  targetSessions: number;
  completedSessions: number;
  completedExercises: number;
  volumeKg: number;
  trends: { week: string; sessions: number; adherencePercent: number; volumeKg: number }[];
  strengthChanges: { exerciseId: string; name: string; previousKg: number; currentKg: number; changePercent: number }[];
  difficultyCounts: Record<Difficulty, number>;
  discomfortExercises: string[];
  progressingExercises: string[];
  weightStart?: number;
  weightEnd?: number;
  waistStart?: number;
  waistEnd?: number;
  energy?: Energy;
  feeling?: string;
  note?: string;
  feedback: string;
  focus: string;
  focusTone: 'positive' | 'neutral' | 'caution';
  recommendations: WeeklyRecommendation[];
}

export interface WeeklyRecommendation {
  exerciseId: string;
  name: string;
  tone: 'positive' | 'neutral' | 'caution';
  title: string;
  detail: string;
}

const emptyDifficultyCounts = (): Record<Difficulty, number> => ({ easy: 0, good: 0, hard: 0, incomplete: 0 });

const dateFromKey = (value: string): Date => new Date(`${value}T12:00:00`);

const sessionsInWeek = (sessions: WorkoutSession[], start: Date, end: Date): WorkoutSession[] => {
  const startKey = dateKey(start);
  const endKey = dateKey(end);
  return sessions.filter((session) => session.status === 'completed' && session.dateKey >= startKey && session.dateKey <= endKey);
};

const measureEntriesInWeek = (data: AppData, start: Date, end: Date) => data.progress
  .filter((entry) => entry.date >= dateKey(start) && entry.date <= dateKey(end))
  .sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

const volumeFor = (sessions: WorkoutSession[]): number => sessions.reduce((total, session) => total + session.plannedExercises.reduce((exerciseTotal, exercise) => exerciseTotal + exercise.setLogs.reduce((setTotal, set) => setTotal + (isWorkSet(set) && set.completed ? (set.weightKg ?? 0) * (set.actualReps ?? 0) : 0), 0), 0), 0);

const energyLabel = (energy?: Energy): string => energy === 'high' ? 'alta' : energy === 'low' ? 'baja' : energy ? 'normal' : 'sin registrar';
const difficultyLabel = (difficulty?: Difficulty): string => difficulty === 'easy' ? 'Fácil' : difficulty === 'good' ? 'Bien' : difficulty === 'hard' ? 'Difícil' : difficulty === 'incomplete' ? 'No pude' : 'sin valorar';

const exerciseDetailLines = (sessions: WorkoutSession[]): string[] => sessions.flatMap((session) => session.plannedExercises.map((exercise) => {
  const workSets = exercise.setLogs.filter(isWorkSet);
  const completedSets = workSets.filter((set) => set.completed);
  const setDetails = completedSets.map((set) => `${set.weightKg === undefined ? '-' : `${set.weightKg} kg`} × ${set.actualReps === undefined ? '-' : `${set.actualReps} reps`}`).join(', ');
  const result = setDetails || `${completedSets.length}/${workSets.length} series`;
  const discomfort = exercise.discomfort ? ' · molestias registradas' : '';
  return `${session.dateKey} · ${exercise.name} · ${difficultyLabel(exercise.difficulty)} · ${result}${discomfort}`;
}));

const recommendationPriority: Record<WeeklyRecommendation['tone'], number> = { caution: 0, positive: 1, neutral: 2 };

const weeklyRecommendationsFor = (data: AppData): WeeklyRecommendation[] => {
  const seen = new Set<string>();
  return data.plan.days
    .flatMap((day) => day.exercises)
    .filter((exercise) => exercise.active && !seen.has(exercise.exerciseId) && seen.add(exercise.exerciseId))
    .map((exercise) => {
      const action = progressionAction(exercise.exerciseId, data.sessions, exercise);
      if (action) return { exerciseId: exercise.exerciseId, name: exercise.name, tone: action.tone, title: action.title, detail: action.detail };
      const recommendation = recommendationFor(exercise.exerciseId, data.sessions);
      return recommendation ? { exerciseId: exercise.exerciseId, name: exercise.name, tone: recommendation.tone, title: recommendation.label, detail: recommendation.message } : undefined;
    })
    .filter((recommendation): recommendation is WeeklyRecommendation => Boolean(recommendation))
    .sort((a, b) => recommendationPriority[a.tone] - recommendationPriority[b.tone] || a.name.localeCompare(b.name, 'es'))
    .slice(0, 4);
};

export const buildWeeklySummary = (data: AppData, now = new Date()): WeeklySummary => {
  const start = dateFromKey(weekKey(now));
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const sessions = sessionsInWeek(data.sessions, start, end);
  const difficultyCounts = emptyDifficultyCounts();
  const exerciseNames = new Map<string, string>();
  const exerciseIds = new Set<string>();
  let completedExercises = 0;
  const discomfortExercises: string[] = [];

  sessions.forEach((session) => session.plannedExercises.forEach((exercise) => {
    exerciseNames.set(exercise.exerciseId, exercise.name);
    exerciseIds.add(exercise.exerciseId);
    if (exercise.completed) completedExercises += 1;
    if (exercise.difficulty) difficultyCounts[exercise.difficulty] += 1;
    if (exercise.discomfort && !discomfortExercises.includes(exercise.name)) discomfortExercises.push(exercise.name);
  }));

  const progressingExercises = Array.from(exerciseIds)
    .filter((exerciseId) => recommendationFor(exerciseId, data.sessions)?.tone === 'positive')
    .map((exerciseId) => exerciseNames.get(exerciseId) ?? exerciseId)
    .slice(0, 3);
  const orderedProgress = [...data.progress].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const measures = measureEntriesInWeek(data, start, end);
  const previousMeasure = orderedProgress.filter((entry) => entry.date < dateKey(start)).at(-1);
  const firstMeasure = measures[0] ?? previousMeasure;
  const lastMeasure = measures.at(-1) ?? orderedProgress.at(-1);
  const checkin = data.checkins.find((entry) => entry.weekKey === weekKey(now));
  const targetSessions = Math.max(Math.min(normalizeTrainingDays(data.profile.trainingDays).length, data.plan.days.length), 1);
  const trends = Array.from({ length: 4 }, (_, index) => {
    const from = new Date(start);
    from.setDate(from.getDate() - (3 - index) * 7);
    const to = new Date(from);
    to.setDate(to.getDate() + 6);
    const entries = sessionsInWeek(data.sessions, from, to);
    return { week: dateKey(from), sessions: entries.length, adherencePercent: Math.min(100, Math.round(entries.length / targetSessions * 100)), volumeKg: volumeFor(entries) };
  });
  const previousStart = new Date(start);
  previousStart.setDate(previousStart.getDate() - 7);
  const previousEnd = new Date(start);
  previousEnd.setDate(previousEnd.getDate() - 1);
  // Compare the same exercise and rep count: changing exercises or reps is not a strength gain.
  const loads = (entries: WorkoutSession[]) => {
    const result = new Map<string, { exerciseId: string; name: string; kg: number }>();
    entries.forEach((session) => session.plannedExercises.forEach((exercise) => exercise.setLogs.filter(isWorkSet).forEach((set) => {
      if (!set.completed || !set.weightKg || !set.actualReps) return;
      const key = `${exercise.exerciseId}:${set.actualReps}`;
      if (set.weightKg > (result.get(key)?.kg ?? 0)) result.set(key, { exerciseId: exercise.exerciseId, name: exercise.name, kg: set.weightKg });
    })));
    return result;
  };
  const previousLoads = loads(sessionsInWeek(data.sessions, previousStart, previousEnd));
  const seenStrength = new Set<string>();
  const strengthChanges = [...loads(sessions)].flatMap(([key, current]) => {
    const previous = previousLoads.get(key);
    if (!previous || seenStrength.has(current.exerciseId)) return [];
    seenStrength.add(current.exerciseId);
    return [{ exerciseId: current.exerciseId, name: current.name, previousKg: previous.kg, currentKg: current.kg, changePercent: Math.round((current.kg / previous.kg - 1) * 100) }];
  });
  const feedback = overallFeedback(sessions);
  const remainingSessions = Math.max(targetSessions - sessions.length, 0);
  const recommendations = weeklyRecommendationsFor(data);

  let focus = 'Mantén el registro simple y observa cómo responde tu cuerpo.';
  let focusTone: WeeklySummary['focusTone'] = 'neutral';
  if (discomfortExercises.length > 0) {
    focus = `Revisa ${discomfortExercises.slice(0, 2).join(' y ')} antes de progresar.`;
    focusTone = 'caution';
  } else if (difficultyCounts.incomplete > 0 || difficultyCounts.hard > difficultyCounts.easy) {
    focus = 'Repite la programación y busca una ejecución más sólida antes de subir carga.';
    focusTone = 'caution';
  } else if (checkin?.energy === 'low') {
    focus = 'Prioriza recuperar bien esta semana y mantén la carga mientras la energía remonta.';
    focusTone = 'caution';
  } else if (progressingExercises.length > 0) {
    focus = `Hay margen para progresar en ${progressingExercises.slice(0, 2).join(' y ')} si mantienes la técnica.`;
    focusTone = 'positive';
  } else if (remainingSessions > 0 && sessions.length > 0) {
    focus = `Quedan ${remainingSessions} ${remainingSessions === 1 ? 'sesión prevista' : 'sesiones previstas'} esta semana. Completa solo las que encajen con tu recuperación.`;
  }

  return {
    periodLabel: `Del ${formatDate(start, { day: 'numeric', month: 'short' })} al ${formatDate(end, { day: 'numeric', month: 'short' })}`,
    targetSessions,
    completedSessions: sessions.length,
    completedExercises,
    volumeKg: volumeFor(sessions),
    trends,
    strengthChanges,
    difficultyCounts,
    discomfortExercises,
    progressingExercises,
    weightStart: firstMeasure?.weightKg,
    weightEnd: lastMeasure?.weightKg,
    waistStart: firstMeasure?.waistCm,
    waistEnd: lastMeasure?.waistCm,
    energy: checkin?.energy,
    feeling: checkin?.feeling,
    note: checkin?.note,
    feedback,
    focus,
    focusTone,
    recommendations,
  };
};

const formatMeasure = (value: number | undefined, unit: string): string => value === undefined ? 'sin registro' : `${value.toLocaleString('es-ES', { maximumFractionDigits: 1 })} ${unit}`;

export const weeklySummaryText = (data: AppData, now = new Date()): string => {
  const summary = buildWeeklySummary(data, now);
  const start = dateFromKey(weekKey(now));
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  const sessions = sessionsInWeek(data.sessions, start, end);
  const lines = [
    'RADIAN | REVISIÓN SEMANAL',
    summary.periodLabel,
    '',
    'CONTEXTO',
    `Objetivo: ${data.profile.goal || 'sin definir'}`,
    `Gimnasio: ${data.profile.gym || 'sin definir'}`,
    `Peso actual: ${formatMeasure(summary.weightEnd ?? data.profile.currentWeightKg, 'kg')}`,
    '',
    'ADHERENCIA',
    `${summary.completedSessions}/${summary.targetSessions} sesiones completadas`,
    `${summary.completedExercises} ejercicios registrados`,
    `Volumen registrado: ${formatMeasure(summary.volumeKg, 'kg')}`,
    '',
    'SENSACIONES',
    `Fácil: ${summary.difficultyCounts.easy} · Bien: ${summary.difficultyCounts.good} · Difícil: ${summary.difficultyCounts.hard} · No pude: ${summary.difficultyCounts.incomplete}`,
    `Energía: ${energyLabel(summary.energy)}`,
    summary.discomfortExercises.length ? `Molestias: ${summary.discomfortExercises.join(', ')}` : 'Molestias: ninguna registrada',
    '',
    'CAMBIOS',
    `Peso: ${formatMeasure(summary.weightStart, 'kg')} → ${formatMeasure(summary.weightEnd, 'kg')}`,
    `Cintura: ${formatMeasure(summary.waistStart, 'cm')} → ${formatMeasure(summary.waistEnd, 'cm')}`,
    '',
    'TENDENCIAS',
    ...summary.trends.map((trend) => `${trend.week}: ${trend.sessions} sesiones · ${trend.adherencePercent}% del objetivo · ${formatMeasure(trend.volumeKg, 'kg')} de volumen`),
    summary.strengthChanges.length ? `Fuerza comparable: ${summary.strengthChanges.map((change) => `${change.name} ${change.previousKg} → ${change.currentKg} kg`).join('; ')}` : 'Fuerza comparable: sin datos entre semanas consecutivas',
    '',
    'LECTURA',
    summary.feedback,
    `Próximo foco: ${summary.focus}`,
  ];
  const details = exerciseDetailLines(sessions);
  if (details.length) lines.push('', 'DETALLE DE EJERCICIOS', ...details);
  if (summary.recommendations.length) {
    lines.push('', 'RECOMENDACIONES PARA LA PRÓXIMA SEMANA', ...summary.recommendations.map((recommendation) => `${recommendation.name}: ${recommendation.title}. ${recommendation.detail}`));
  }
  if (summary.progressingExercises.length) lines.push(`Margen de progresión: ${summary.progressingExercises.join(', ')}`);
  if (summary.feeling) lines.push(`Sensación: ${summary.feeling}`);
  if (summary.note) lines.push(`Nota: ${summary.note}`);
  return lines.join('\n');
};
